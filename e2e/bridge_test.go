package e2e

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestNoBrowserIsAnActionableToolError(t *testing.T) {
	s := startServer(t)
	c := s.client(t)

	isErrorWith(t, c.Call("tabs_context", j(`{}`)), "No extension connected")

	r := c.Call("browsers_context", j(`{}`))
	if r.IsError || r.Text != "No browsers connected." {
		t.Fatalf("browsers_context: %+v", r)
	}
	equalJSON(t, r.Get("extensionCount"), `0`)
	equalJSON(t, r.Get("defaultBrowserId"), `null`)
}

func TestExtensionMustAuthenticateWithItsFirstFrame(t *testing.T) {
	s := startServer(t)
	cases := map[string]func(*websocket.Conn){
		"wrong token": func(conn *websocket.Conn) {
			writeJSON(t, conn, map[string]any{"type": "connect", "version": "1", "extensionId": "e", "instanceId": "a", "token": "wrong"})
		},
		"first frame is not connect": func(conn *websocket.Conn) {
			writeJSON(t, conn, map[string]any{"type": "pong"})
		},
		// The server's authentication window is 5 s.
		"silent": func(*websocket.Conn) {},
	}
	for name, send := range cases {
		t.Run(name, func(t *testing.T) {
			conn := s.dialWS(t)
			defer conn.CloseNow()
			send(conn)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			_, _, err := conn.Read(ctx)
			if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
				t.Fatalf("expected policy close 1008, got %v (%v)", got, err)
			}
			equalJSON(t, s.status(t)["extensionCount"], `0`)
		})
	}
}

func TestMCPRequiresBearerAndALocalHost(t *testing.T) {
	s := startServer(t)
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}`
	post := func(host string, auth bool) int {
		req, err := http.NewRequest(http.MethodPost, s.URL("/mcp"), strings.NewReader(initialize))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = fmt.Sprintf("%s:%d", host, s.Port)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if auth {
			req.Header.Set("Authorization", "Bearer "+testToken)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := post("127.0.0.1", false); got != http.StatusUnauthorized {
		t.Fatalf("no bearer: status %d", got)
	}
	// host.docker.internal is how containers name the host's loopback.
	for _, host := range []string{"127.0.0.1", "localhost", "host.docker.internal"} {
		if got := post(host, true); got != http.StatusOK {
			t.Fatalf("host %s: status %d", host, got)
		}
	}
	// DNS rebinding: a web page can only send a Host it controls.
	if got := post("rebound.example", true); got != http.StatusForbidden {
		t.Fatalf("rebound host: status %d", got)
	}
}

func TestInitializeIdentifiesBro(t *testing.T) {
	s := startServer(t)
	info := s.client(t).session.InitializeResult().ServerInfo
	out, err := exec.Command(broBin, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "bro" || !strings.Contains(string(out), info.Version) || info.Version == "" {
		t.Fatalf("serverInfo %+v; --version %q", info, out)
	}
}

func TestForwardedToolsMapExtensionResultsAndErrors(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)

	p := c.Start("tabs_context", j(`{}`))
	ext.Reply(ext.NextTool("tabs_context"), "tab list")
	if r := p.Wait(); r.IsError || r.Text != "tab list" {
		t.Fatalf("plain result: %+v", r)
	}

	p = c.Start("tabs_context", j(`{}`))
	ext.ReplyFailed(ext.NextTool("tabs_context"), "embedded failure")
	isErrorWith(t, p.Wait(), "embedded failure")

	p = c.Start("tabs_context", j(`{}`))
	ext.ReplyError(ext.NextTool("tabs_context"), "extension threw")
	isErrorWith(t, p.Wait(), "extension threw")

	// Tab tools carry tabId in the envelope; browserId selects, never forwards.
	isErrorWith(t, c.Call("read_page", j(`{}`)), "read_page requires tabId")
	p = c.Start("read_page", j(`{"tabId":7,"browserId":"a","maxChars":100}`))
	call := ext.NextTool("read_page")
	if tabID(call) != 7 {
		t.Fatalf("tab envelope: %v", call.TabID)
	}
	equalJSON(t, call.Args, `{"maxChars":100}`)
	ext.Reply(call, "ok")
	p.Wait()

	isErrorWith(t, c.Call("tabs_context", j(`{"browserId":"missing"}`)), "Browser missing not found")
	isErrorWith(t, c.Call("no_such_tool", j(`{}`)), "Unknown tool: no_such_tool")
}

func TestRepliesMustComeFromTheConnectionThatGotTheCall(t *testing.T) {
	s := startServer(t)
	first := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("tabs_context", j(`{}`))
	call := first.NextTool("tabs_context")

	// Same browser id, new connection: it cannot answer the old connection's call.
	replacement := s.connectExt(t, "a")
	replacement.Reply(call, "from replacement")
	time.Sleep(quietWindow)
	if p.Done() {
		t.Fatalf("a reply from another connection completed the call: %+v", p.Wait())
	}
	first.Reply(call, "from first")
	if r := p.Wait(); r.Text != "from first" {
		t.Fatalf("got %+v", r)
	}
}

func TestDisconnectCompletesPendingCalls(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("tabs_context", j(`{}`))
	ext.NextTool("tabs_context")
	ext.Close()
	isErrorWith(t, p.Wait(), "disconnected")
	equalJSON(t, s.status(t)["extensionCount"], `0`)
}

func TestDefaultBrowserIsTheLatestConnection(t *testing.T) {
	s := startServer(t)
	a := s.connectExt(t, "a")
	b := s.connectExt(t, "b")
	c := s.client(t)

	r := c.Call("browsers_context", j(`{}`))
	equalJSON(t, r.Get("defaultBrowserId"), `"b"`)
	contains(t, r.Text, "Connected browsers: 2")

	p := c.Start("tabs_context", j(`{}`))
	b.Reply(b.NextTool("tabs_context"), "b")
	p.Wait()
	a.Quiet()

	b.Close()
	equalJSON(t, c.Call("browsers_context", j(`{}`)).Get("defaultBrowserId"), `"a"`)
}

func TestStaleDisconnectKeepsTheReplacementConnection(t *testing.T) {
	s := startServer(t)
	old := s.connectExt(t, "a")
	replacement := s.connectExt(t, "a")
	old.Close()

	st := s.status(t)
	equalJSON(t, st["extensionCount"], `1`)
	equalJSON(t, st["defaultBrowserId"], `"a"`)
	equalJSON(t, dig(st, "extensions", 0, "sessionId"), `"`+replacement.SessionID+`"`)

	c := s.client(t)
	p := c.Start("tabs_context", j(`{}`))
	replacement.Reply(replacement.NextTool("tabs_context"), "alive")
	if r := p.Wait(); r.Text != "alive" {
		t.Fatalf("got %+v", r)
	}
}

func TestCancelledForwardedCallKeepsTheConnection(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("read_page", j(`{"tabId":42}`))
	call := ext.NextTool("read_page")
	p.Cancel()
	<-p.done
	if !errors.Is(p.err, context.Canceled) {
		t.Fatalf("expected the client call to be cancelled, got %v", p.err)
	}
	// A late reply to the abandoned request is ignored, not a protocol failure.
	ext.Reply(call, "late")
	equalJSON(t, s.status(t)["extensionCount"], `1`)

	p = c.Start("tabs_context", j(`{}`))
	ext.Reply(ext.NextTool("tabs_context"), "still serving")
	if r := p.Wait(); r.Text != "still serving" {
		t.Fatalf("got %+v", r)
	}
}
