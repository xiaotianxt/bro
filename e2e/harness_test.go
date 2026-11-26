// Package e2e is bro's black-box contract suite. It runs the bro binary with
// an isolated HOME, connects fake extensions to /ws, and drives /mcp with the
// official Go MCP SDK. It asserts only what MCP clients and the extension can
// observe, so internals can change freely underneath it.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	testToken = "e2e-secret-token-0123456789"
	// A step that fails early never sends the next call; fail, do not hang.
	callWait = 5 * time.Second
	// How long "no further browser call" is observed: over a socket an
	// absence needs a short window.
	quietWindow = 200 * time.Millisecond
	// Clients send notifications/cancelled asynchronously and best-effort
	// (go-sdk allows itself 5 s), so its arrival gets the hang bound, not callWait.
	cancelWait = 15 * time.Second
)

var broBin = os.Getenv("BRO_BIN")

// TestMain runs the contracts against BRO_BIN, or against a fresh build of
// ./cmd/bro when it is unset, so plain `go test ./...` covers them.
func TestMain(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) int {
	if broBin == "" {
		dir, err := os.MkdirTemp("", "bro-e2e-")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		defer os.RemoveAll(dir)
		broBin = filepath.Join(dir, "bro")
		build := exec.Command("go", "build", "-o", broBin, "../cmd/bro")
		build.Stdout, build.Stderr = os.Stderr, os.Stderr
		if err := build.Run(); err != nil {
			fmt.Fprintln(os.Stderr, "build bro:", err)
			return 2
		}
	}
	abs, err := filepath.Abs(broBin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	broBin = abs
	return m.Run()
}

// Server is one bro process with its own HOME and port.
type Server struct {
	Port int
	Home string
	logs *lockedBuffer
	cmd  *exec.Cmd
}

func startServer(t *testing.T) *Server {
	t.Helper()
	home := t.TempDir()
	writeSettings(t, home)
	return startServerAt(t, home, freePort(t))
}

// startServerAt starts bro on a given HOME and port, as a restart does.
func startServerAt(t *testing.T, home string, port int) *Server {
	t.Helper()
	logs := &lockedBuffer{}
	cmd := exec.Command(broBin, "serve", "--port", fmt.Sprint(port))
	cmd.Env = append(os.Environ(), "HOME="+home, "NO_COLOR=1")
	cmd.Stdout = logs
	cmd.Stderr = logs
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", broBin, err)
	}
	s := &Server{Port: port, Home: home, logs: logs, cmd: cmd}
	t.Cleanup(func() {
		s.Stop()
		out := logs.String()
		if strings.Contains(out, testToken) {
			t.Errorf("server output contains the bearer token")
		}
		if t.Failed() {
			t.Logf("server output:\n%s", out)
		}
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get(s.URL("/health"))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return s
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("server never became healthy: %v\n%s", err, logs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Stop kills the server process; repeated calls are harmless.
func (s *Server) Stop() {
	if s.cmd.ProcessState == nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
}

func (s *Server) URL(path string) string { return fmt.Sprintf("http://127.0.0.1:%d%s", s.Port, path) }

// Logs returns everything the server wrote so far.
func (s *Server) Logs() string { return s.logs.String() }

// waitLog waits until the server log contains want: a state the server
// reports, never a guessed delay.
func (s *Server) waitLog(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(cancelWait)
	for !strings.Contains(s.Logs(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("server never logged %q", want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func writeSettings(t *testing.T, home string) {
	t.Helper()
	dir := filepath.Join(home, ".bro")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"token":"` + testToken + `"}`)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// ---------------------------------------------------------------------------
// Fake extension

// ToolCall is a server-to-extension tool_call frame.
type ToolCall struct {
	RequestID string         `json:"requestId"`
	Tool      string         `json:"tool"`
	Args      map[string]any `json:"args"`
	TabID     *int64         `json:"tabId"`
}

// Ext is a fake extension connection. It answers pings and queues tool calls.
type Ext struct {
	t         *testing.T
	conn      *websocket.Conn
	SessionID string
	calls     chan ToolCall
	closed    chan struct{}
}

// connectExt authenticates as extension instance id, like the real extension.
func (s *Server) connectExt(t *testing.T, instanceID string) *Ext {
	t.Helper()
	conn := s.dialWS(t)
	connect := map[string]any{
		"type": "connect", "version": "1.8.0", "extensionId": "extension",
		"instanceId": instanceID, "token": testToken, "activeTabUrl": nil, "browserInfo": nil,
	}
	writeJSON(t, conn, connect)
	var connected struct {
		Type      string `json:"type"`
		SessionID string `json:"sessionId"`
	}
	readJSON(t, conn, &connected)
	if connected.Type != "connected" || connected.SessionID == "" {
		t.Fatalf("expected connected frame, got %+v", connected)
	}
	e := &Ext{t: t, conn: conn, SessionID: connected.SessionID, calls: make(chan ToolCall, 64), closed: make(chan struct{})}
	go e.read()
	t.Cleanup(func() { _ = conn.CloseNow() })
	return e
}

func (s *Server) dialWS(t *testing.T) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws", s.Port), nil)
	if err != nil {
		t.Fatalf("dial /ws: %v", err)
	}
	conn.SetReadLimit(-1)
	return conn
}

func (e *Ext) read() {
	defer close(e.closed)
	for {
		_, data, err := e.conn.Read(context.Background())
		if err != nil {
			return
		}
		var frame struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		switch frame.Type {
		case "tool_call":
			var call ToolCall
			if err := json.Unmarshal(data, &call); err == nil {
				e.calls <- call
			}
		case "ping":
			_ = e.send(map[string]any{"type": "pong"})
		}
	}
}

func (e *Ext) send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return e.conn.Write(ctx, websocket.MessageText, data)
}

// Next returns the next tool call, failing the test if none arrives.
func (e *Ext) Next() ToolCall {
	e.t.Helper()
	select {
	case call := <-e.calls:
		return call
	case <-time.After(callWait):
		e.t.Fatalf("timed out waiting for the next tool call")
		return ToolCall{}
	}
}

// NextTool returns the next call and checks its tool name.
func (e *Ext) NextTool(tool string) ToolCall {
	e.t.Helper()
	call := e.Next()
	if call.Tool != tool {
		e.t.Fatalf("expected tool %q, got %q (args %v)", tool, call.Tool, call.Args)
	}
	return call
}

// Quiet asserts that no tool call arrives within the quiet window.
func (e *Ext) Quiet() {
	e.t.Helper()
	select {
	case call := <-e.calls:
		e.t.Fatalf("unexpected tool call %q args %v", call.Tool, call.Args)
	case <-time.After(quietWindow):
	}
}

// Reply answers with a successful MCP-shaped text result.
func (e *Ext) Reply(call ToolCall, text string) {
	e.t.Helper()
	e.ReplyResult(call, map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}})
}

// ReplyFailed answers with an MCP-shaped text result marked isError.
func (e *Ext) ReplyFailed(call ToolCall, text string) {
	e.t.Helper()
	e.ReplyResult(call, map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": true})
}

// ReplyResult answers with an arbitrary result payload.
func (e *Ext) ReplyResult(call ToolCall, result any) {
	e.t.Helper()
	if err := e.send(map[string]any{"type": "tool_result", "requestId": call.RequestID, "result": result}); err != nil {
		e.t.Fatalf("reply: %v", err)
	}
}

// ReplyError answers with a tool_error frame.
func (e *Ext) ReplyError(call ToolCall, message string) {
	e.t.Helper()
	if err := e.send(map[string]any{"type": "tool_error", "requestId": call.RequestID, "error": map[string]any{"message": message}}); err != nil {
		e.t.Fatalf("reply error: %v", err)
	}
}

// Close ends the connection with a normal close frame.
func (e *Ext) Close() {
	_ = e.conn.Close(websocket.StatusNormalClosure, "")
	select {
	case <-e.closed:
	case <-time.After(callWait):
	}
}

func writeJSON(t *testing.T, conn *websocket.Conn, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("ws write: %v", err)
	}
}

func readJSON(t *testing.T, conn *websocket.Conn, v any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("ws decode %s: %v", data, err)
	}
}

// ---------------------------------------------------------------------------
// MCP client

// Client is one MCP session; bro keeps per-session state such as the last target.
type Client struct {
	t       *testing.T
	session *mcp.ClientSession
}

type bearer struct{ base http.RoundTripper }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+testToken)
	return b.base.RoundTrip(r)
}

func (s *Server) client(t *testing.T) *Client {
	t.Helper()
	transport := &mcp.StreamableClientTransport{
		Endpoint:             s.URL("/mcp"),
		HTTPClient:           &http.Client{Transport: bearer{http.DefaultTransport}},
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session, err := mcp.NewClient(&mcp.Implementation{Name: "bro-e2e", Version: "0"}, nil).Connect(ctx, transport, nil)
	if err != nil {
		t.Fatalf("mcp connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return &Client{t: t, session: session}
}

// Pending is an in-flight tool call; the fake extension answers it meanwhile.
type Pending struct {
	t      *testing.T
	done   chan struct{}
	result *mcp.CallToolResult
	err    error
	cancel context.CancelFunc
}

// Start begins a tool call without waiting for it.
func (c *Client) Start(name string, args any) *Pending {
	ctx, cancel := context.WithCancel(context.Background())
	p := &Pending{t: c.t, done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(p.done)
		p.result, p.err = c.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	}()
	return p
}

// Cancel cancels the request; the SDK sends notifications/cancelled.
func (p *Pending) Cancel() { p.cancel() }

// Wait returns the result, failing on protocol errors or a hang.
func (p *Pending) Wait() Result {
	p.t.Helper()
	select {
	case <-p.done:
	case <-time.After(15 * time.Second):
		p.t.Fatalf("tool call did not finish")
	}
	if p.err != nil {
		p.t.Fatalf("tool call protocol error: %v", p.err)
	}
	return newResult(p.t, p.result)
}

// Done reports whether the call has finished.
func (p *Pending) Done() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

// Call runs a tool call to completion; use it only when no browser call is expected.
func (c *Client) Call(name string, args any) Result {
	c.t.Helper()
	return c.Start(name, args).Wait()
}

// Result is a decoded tool result.
type Result struct {
	IsError    bool
	Text       string
	Structured map[string]any
}

func newResult(t *testing.T, r *mcp.CallToolResult) Result {
	t.Helper()
	var texts []string
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			texts = append(texts, tc.Text)
		}
	}
	out := Result{IsError: r.IsError, Text: strings.Join(texts, "\n")}
	if r.StructuredContent != nil {
		data, err := json.Marshal(r.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &out.Structured); err != nil {
			t.Fatalf("structured content is not an object: %s", data)
		}
	}
	return out
}

// Get walks Structured by object keys and array indexes.
func (r Result) Get(path ...any) any { return dig(r.Structured, path...) }

// Str is Get for a string value ("" when absent).
func (r Result) Str(path ...any) string {
	s, _ := r.Get(path...).(string)
	return s
}

func dig(v any, path ...any) any {
	for _, p := range path {
		switch key := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = m[key]
		case int:
			a, ok := v.([]any)
			if !ok || key >= len(a) {
				return nil
			}
			v = a[key]
		default:
			panic(fmt.Sprintf("bad path element %v", p))
		}
	}
	return v
}

// ---------------------------------------------------------------------------
// Assertions

// equalJSON compares any JSON-shaped value with a JSON literal.
func equalJSON(t *testing.T, got any, want string) {
	t.Helper()
	var w any
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("bad want JSON %s: %v", want, err)
	}
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var g any
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("JSON mismatch\n got: %s\nwant: %s", data, want)
	}
}

func contains(t *testing.T, s, sub string) {
	t.Helper()
	if !strings.Contains(s, sub) {
		t.Fatalf("expected %q in:\n%s", sub, s)
	}
}

func isErrorWith(t *testing.T, r Result, sub string) {
	t.Helper()
	if !r.IsError {
		t.Fatalf("expected an error result, got: %s %v", r.Text, r.Structured)
	}
	contains(t, r.Text+fmt.Sprint(r.Structured), sub)
}

// tabID reads the envelope tab id of a call.
func tabID(call ToolCall) int64 {
	if call.TabID == nil {
		return -1
	}
	return *call.TabID
}

// j writes tool arguments as a JSON literal, the way the contracts read best.
func j(format string, args ...any) json.RawMessage {
	s := format
	if len(args) > 0 {
		s = fmt.Sprintf(format, args...)
	}
	if !json.Valid([]byte(s)) {
		panic("invalid JSON literal: " + s)
	}
	return json.RawMessage(s)
}

// status reads the unauthenticated /status endpoint.
func (s *Server) status(t *testing.T) map[string]any {
	t.Helper()
	resp, err := http.Get(s.URL("/status"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}
