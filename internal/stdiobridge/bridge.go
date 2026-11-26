// Package stdiobridge serves MCP over stdio by relaying each message to bro's
// local Streamable HTTP endpoint. It lets clients that launch a command (Claude
// Desktop, Cursor, Claude Code) use the one long-lived bro server without
// putting the token in their config: the bridge reads it from settings.
//
// The bridge is transparent: it relays JSON-RPC frames without interpreting
// them, except that it remembers the client's initialize handshake. When the
// server restarts (an upgrade, a crash) the old session is gone and the server
// answers 404; the bridge replays the handshake on a new session and retries,
// so the client never sees the restart. Server state tied to the old session,
// such as its default target, is not recovered.
//
// bro sends server-to-client messages only on the stream of the request that
// caused them, so the bridge opens no standalone GET stream.
package stdiobridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const maxLine = 16 << 20

// Bridge relays one stdio MCP client to one bro endpoint.
type Bridge struct {
	Endpoint string
	Token    string
	Client   *http.Client

	outMu sync.Mutex
	out   io.Writer

	mu              sync.Mutex
	sessionID       string
	protocolVersion string
	initialize      []byte
	initialized     []byte
	generation      int
	reinitMu        sync.Mutex
}

type envelope struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Result *struct {
		ProtocolVersion string `json:"protocolVersion"`
	} `json:"result"`
}

// Run relays messages from in to the endpoint and replies to out until in
// ends or ctx is done, then ends the server session.
func (b *Bridge) Run(ctx context.Context, in io.Reader, out io.Writer) error {
	b.out = out
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64<<10), maxLine)
	var wg sync.WaitGroup
	lines := make(chan []byte)
	scanErr := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 {
				continue
			}
			select {
			case lines <- append([]byte(nil), line...):
			case <-ctx.Done():
				return
			}
		}
		scanErr <- scanner.Err()
		close(lines)
	}()
	defer b.endSession()
	for {
		select {
		case <-ctx.Done():
			return nil
		case line, ok := <-lines:
			if !ok {
				// Calls already sent still answer; a client that wants out
				// sooner signals the process, which cancels ctx.
				wg.Wait()
				return <-scanErr
			}
			var env envelope
			if err := json.Unmarshal(line, &env); err != nil {
				b.write(errorResponse(nil, -32700, "parse error: "+err.Error()))
				continue
			}
			switch env.Method {
			case "initialize", "notifications/initialized":
				// The handshake runs in order: nothing else is sent before it.
				wg.Wait()
				b.mu.Lock()
				if env.Method == "initialize" {
					b.initialize, b.sessionID, b.protocolVersion = line, "", ""
				} else {
					b.initialized = line
				}
				b.mu.Unlock()
				b.relay(ctx, line, env)
			default:
				wg.Add(1)
				go func() {
					defer wg.Done()
					b.relay(ctx, line, env)
				}()
			}
		}
	}
}

func (b *Bridge) relay(ctx context.Context, msg []byte, env envelope) {
	isRequest := env.Method != "" && len(env.ID) > 0
	b.mu.Lock()
	generation := b.generation
	b.mu.Unlock()
	resp, err := b.post(ctx, msg)
	if err == nil && resp.StatusCode == http.StatusNotFound && env.Method != "initialize" {
		resp.Body.Close()
		if err = b.reinitialize(ctx, generation); err == nil {
			resp, err = b.post(ctx, msg)
		}
	}
	if err != nil {
		if isRequest {
			b.write(errorResponse(env.ID, -32000, b.unreachable(err)))
		}
		return
	}
	defer resp.Body.Close()
	if env.Method == "initialize" {
		b.mu.Lock()
		b.sessionID = resp.Header.Get("Mcp-Session-Id")
		b.mu.Unlock()
	}
	if err := b.forward(resp, isRequest, env); err != nil && isRequest {
		b.write(errorResponse(env.ID, -32000, err.Error()))
	}
}

func (b *Bridge) unreachable(err error) string {
	return fmt.Sprintf("bro is not reachable at %s (%v); start it with `bro setup`", b.Endpoint, err)
}

// forward copies the server's answer to the client. A JSON body is one
// message; an event stream carries one message per event.
func (b *Bridge) forward(resp *http.Response, isRequest bool, env envelope) error {
	switch {
	case resp.StatusCode == http.StatusAccepted:
		return nil
	case resp.StatusCode == http.StatusUnauthorized:
		return errors.New("bro rejected the token in ~/.bro/settings.json; restart the bro service so both use the same settings")
	case resp.StatusCode >= 300:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("bro answered HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return b.forwardEvents(resp.Body, env)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		if isRequest {
			return errors.New("bro returned an empty response")
		}
		return nil
	}
	b.deliver(body, env)
	return nil
}

func (b *Bridge) forwardEvents(r io.Reader, env envelope) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64<<10), maxLine)
	var data []byte
	flush := func() {
		if len(data) > 0 {
			b.deliver(data, env)
		}
		data = nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "data:"):
			if data != nil {
				data = append(data, '\n')
			}
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")...)
		}
	}
	flush()
	return scanner.Err()
}

// deliver writes one server message to the client, noting the negotiated
// protocol version when it is the initialize result.
func (b *Bridge) deliver(msg []byte, req envelope) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, msg); err != nil {
		b.write(errorResponse(req.ID, -32000, "bro sent invalid JSON"))
		return
	}
	if req.Method == "initialize" {
		var env envelope
		if json.Unmarshal(compact.Bytes(), &env) == nil && env.Result != nil {
			b.mu.Lock()
			b.protocolVersion = env.Result.ProtocolVersion
			b.mu.Unlock()
		}
	}
	b.write(compact.Bytes())
}

// reinitialize replays the client's handshake on a new session, once per
// lost session however many requests noticed it.
func (b *Bridge) reinitialize(ctx context.Context, generation int) error {
	b.reinitMu.Lock()
	defer b.reinitMu.Unlock()
	b.mu.Lock()
	if b.generation != generation {
		b.mu.Unlock()
		return nil
	}
	initialize, initialized := b.initialize, b.initialized
	b.sessionID = ""
	b.mu.Unlock()
	if initialize == nil {
		return errors.New("the client sent a request before initialize")
	}
	resp, err := b.post(ctx, initialize)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bro restarted and refused to start a new session: HTTP %d", resp.StatusCode)
	}
	b.mu.Lock()
	b.sessionID = resp.Header.Get("Mcp-Session-Id")
	b.generation++
	b.mu.Unlock()
	if initialized != nil {
		resp, err := b.post(ctx, initialized)
		if err != nil {
			return err
		}
		resp.Body.Close()
	}
	return nil
}

func (b *Bridge) post(ctx context.Context, msg []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.Endpoint, bytes.NewReader(msg))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	b.headers(req)
	return b.Client.Do(req)
}

func (b *Bridge) headers(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+b.Token)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", b.sessionID)
	}
	if b.protocolVersion != "" {
		req.Header.Set("Mcp-Protocol-Version", b.protocolVersion)
	}
}

// endSession tells the server the client is gone, which cancels its
// in-flight calls instead of leaving them to finish for nobody.
func (b *Bridge) endSession() {
	b.mu.Lock()
	id := b.sessionID
	b.mu.Unlock()
	if id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, b.Endpoint, nil)
	if err != nil {
		return
	}
	b.headers(req)
	if resp, err := b.Client.Do(req); err == nil {
		resp.Body.Close()
	}
}

func (b *Bridge) write(msg []byte) {
	b.outMu.Lock()
	defer b.outMu.Unlock()
	_, _ = b.out.Write(append(msg, '\n'))
}

func errorResponse(id json.RawMessage, code int, message string) []byte {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	data, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
	if err != nil {
		panic(err)
	}
	return data
}
