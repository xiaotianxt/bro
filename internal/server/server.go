// Package server is bro's local HTTP surface: the extension WebSocket, the
// MCP endpoint and small JSON diagnostics, all bound to loopback.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/xiaotianxt/bro/internal/bridge"
	"github.com/xiaotianxt/bro/internal/catalog"
	"github.com/xiaotianxt/bro/internal/credentials"
	"github.com/xiaotianxt/bro/internal/facade"
)

const authTimeout = 5 * time.Second

var heartbeat = bridge.Heartbeat{Interval: 15 * time.Second, Timeout: 45 * time.Second}

// allowedHosts stops DNS rebinding: a web page can only send a Host it
// controls. host.docker.internal is how containers name the Mac's localhost;
// it sits under the reserved .internal TLD, so no web page is served from it.
var allowedHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true, "host.docker.internal": true}

// Config configures one server.
type Config struct {
	Token   string
	Version string
	Log     *slog.Logger
}

// Handler returns bro's HTTP routes.
func Handler(cfg Config, b *bridge.Bridge) http.Handler {
	f := facade.New(b, cfg.Log)
	tools := catalog.Tools()
	live := &liveSessions{byID: map[string]context.CancelFunc{}}
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return newMCPServer(cfg, b, f, tools, live)
	}, &mcp.StreamableHTTPOptions{
		// bro checks Host itself so host.docker.internal stays reachable.
		DisableLocalhostProtection: true,
		Logger:                     cfg.Log,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"status": "ok", "version": cfg.Version, "extensionCount": b.ExtensionCount()})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, b.Status())
	})
	mux.HandleFunc("POST /reload-extension", func(w http.ResponseWriter, _ *http.Request) {
		count := b.ReloadAll()
		cfg.Log.Info("reload extension requested", "count", count)
		writeJSON(w, map[string]any{"reloaded": count})
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		// The extension's Origin is chrome-extension://…; the first frame's
		// token, not the Origin, authenticates the connection.
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			cfg.Log.Warn("websocket upgrade failed", "error", err.Error())
			return
		}
		b.Serve(ws, cfg.Token, authTimeout, heartbeat)
	})
	mux.Handle("/mcp", requireBearer(cfg.Token, requireLocalHost(live.cancelOnDelete(mcpHandler))))
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		panic(fmt.Sprintf("encode %T: %v", v, err))
	}
}

func requireBearer(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if r.Method != http.MethodOptions && (!ok || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requireLocalHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if !allowedHosts[strings.Trim(host, "[]")] {
			http.Error(w, "Forbidden: Host header is not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Serve listens on 127.0.0.1:port until ctx ends.
func Serve(ctx context.Context, port int, cfg Config) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to bind %s: %w", addr, err)
	}
	b := bridge.New(cfg.Log)
	srv := &http.Server{Handler: Handler(cfg, b), ReadHeaderTimeout: 10 * time.Second}
	cfg.Log.Info("server listening", "local_addr", listener.Addr().String())
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(listener) }()
	select {
	case err := <-errc:
		return fmt.Errorf("server failed: %w", err)
	case <-ctx.Done():
		cfg.Log.Info("shutdown signal received")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// Hijacked WebSocket connections are not tracked by Shutdown; they end
		// with the process.
		if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return nil
	}
}

// liveSessions cancels a session's in-flight calls when its client ends it.
// The SDK's session close waits for those calls instead of cancelling them,
// so without this a late tab from a cancelled open would stay open, owned by
// a target nobody knows.
type liveSessions struct {
	mu   sync.Mutex
	byID map[string]context.CancelFunc
}

func (l *liveSessions) add(id string, cancel context.CancelFunc) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.byID[id] = cancel
}

func (l *liveSessions) end(id string) {
	l.mu.Lock()
	cancel, ok := l.byID[id]
	delete(l.byID, id)
	l.mu.Unlock()
	if ok {
		cancel()
	}
}

func (l *liveSessions) cancelOnDelete(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			if id := r.Header.Get("Mcp-Session-Id"); id != "" {
				l.end(id)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// session is one MCP session's state. The facade is shared by every session,
// so the default target lives here, never in the facade.
type session struct {
	log    *slog.Logger
	bridge *bridge.Bridge
	facade *facade.Facade
	// ctx ends with the MCP session; every tool call is bounded by it.
	ctx  context.Context
	mu   sync.Mutex
	last string
}

func newMCPServer(cfg Config, b *bridge.Bridge, f *facade.Facade, tools []*mcp.Tool, live *liveSessions) *mcp.Server {
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{log: cfg.Log, bridge: b, facade: f, ctx: ctx}
	server := mcp.NewServer(&mcp.Implementation{Name: "bro", Version: cfg.Version}, &mcp.ServerOptions{
		InitializedHandler: func(_ context.Context, req *mcp.InitializedRequest) {
			id := req.Session.ID()
			live.add(id, cancel)
			go func() {
				_ = req.Session.Wait()
				live.end(id)
			}()
		},
	})
	for _, tool := range tools {
		server.AddTool(tool, s.call)
	}
	// An unknown tool is a tool result the model can read, not a protocol error.
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if call, ok := req.(*mcp.CallToolRequest); ok && method == "tools/call" && !catalog.Known(call.Params.Name) {
				return toolError("Unknown tool: " + call.Params.Name), nil
			}
			return next(ctx, method, req)
		}
	})
	return server
}

func toolError(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}}
}

func structured(value any, isError bool) *mcp.CallToolResult {
	data, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("encode %T: %v", value, err))
	}
	return &mcp.CallToolResult{IsError: isError, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}, StructuredContent: json.RawMessage(data)}
}

func (s *session) call(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	name := req.Params.Name
	args := map[string]any{}
	if len(req.Params.Arguments) > 0 && string(req.Params.Arguments) != "null" {
		if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
			return toolError("invalid input: arguments must be a JSON object"), nil
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer context.AfterFunc(s.ctx, cancel)()
	if ctx.Err() != nil {
		return toolError(bridge.ErrCancelled.Error()), nil
	}
	// Cancellation is a state callers and tests can wait on: once this is
	// logged the handler has returned, so no further effect is dispatched.
	// (context.AfterFunc would race: the handler can return and stop it after
	// Done closes but before the callback is scheduled.)
	defer func() {
		if ctx.Err() != nil {
			s.log.Info("request cancelled", "tool", name)
		}
	}()
	route := catalog.RouteFor(name)
	switch route {
	case catalog.Observe, catalog.Act, catalog.Click, catalog.Fill, catalog.Press:
		if _, ok := args["targetId"]; !ok {
			s.mu.Lock()
			last := s.last
			s.mu.Unlock()
			if last == "" {
				return toolError("targetId is required: this session has no open target; call browser.open first"), nil
			}
			args["targetId"] = last
		}
	}
	if route == catalog.Watch {
		// Only a start names a target; read, stop and list name a watch.
		_, read := args["watchId"]
		_, list := args["list"]
		_, has := args["targetId"]
		if !read && !list && !has {
			s.mu.Lock()
			last := s.last
			s.mu.Unlock()
			if last != "" {
				args["targetId"] = last
			}
		}
	}
	f := s.facade
	switch route {
	case catalog.BrowsersContext:
		return s.browsersContext(), nil
	case catalog.FindLogins:
		return loginResult(credentials.Find(ctx, args)), nil
	case catalog.InspectLogin:
		return loginResult(credentials.Inspect(ctx, s.bridge, args)), nil
	case catalog.FillLogin:
		return loginResult(credentials.Fill(ctx, s.bridge, args)), nil
	case catalog.BatchFlow:
		return facadeResult(f.BatchFlow(ctx, args)), nil
	case catalog.Extract:
		return facadeResult(f.Extract(ctx, args)), nil
	case catalog.BatchExtract:
		return facadeResult(f.BatchExtract(ctx, args)), nil
	case catalog.ConsoleCapture:
		return facadeResult(f.ConsoleCapture(ctx, args)), nil
	case catalog.NetworkCapture:
		return facadeResult(f.NetworkCapture(ctx, args)), nil
	case catalog.Open:
		return s.targeted(rendered(facade.RenderOpen)(f.Open(ctx, args))), nil
	case catalog.Attach:
		return s.targeted(rendered(facade.RenderOpen)(f.Attach(ctx, args))), nil
	case catalog.Observe:
		return s.targeted(rendered(facade.RenderObserve)(f.Observe(ctx, args))), nil
	case catalog.Act:
		return s.targeted(rendered(facade.RenderAct)(f.Act(ctx, args))), nil
	case catalog.Click:
		return s.targeted(rendered(facade.RenderAct)(f.Step(ctx, "click", args))), nil
	case catalog.Fill:
		return s.targeted(rendered(facade.RenderAct)(f.Step(ctx, "fill", args))), nil
	case catalog.Press:
		return s.targeted(rendered(facade.RenderAct)(f.Step(ctx, "press", args))), nil
	case catalog.Close:
		return facadeResult(f.Close(ctx, args)), nil
	case catalog.Watch:
		return facadeResult(f.Watch(ctx, args)), nil
	case catalog.FileUpload:
		if err := resolveUploadPaths(args); err != nil {
			return toolError(err.Error()), nil
		}
		return s.forward(ctx, name, args, true), nil
	case catalog.ForwardTab:
		return s.forward(ctx, name, args, true), nil
	default:
		return s.forward(ctx, name, args, false), nil
	}
}

// targeted records the target a call reported as this session's default.
func (s *session) targeted(r *mcp.CallToolResult) *mcp.CallToolResult {
	value, ok := r.StructuredContent.(map[string]any)
	if !ok {
		return r
	}
	target, ok := value["targetId"].(string)
	if !ok {
		return r
	}
	// A closed or released target can no longer be the default.
	closed := value["closed"] == true || value["released"] == true
	s.mu.Lock()
	defer s.mu.Unlock()
	if !closed {
		s.last = target
	} else if s.last == target {
		s.last = ""
	}
	return r
}

func (s *session) browsersContext() *mcp.CallToolResult {
	status := s.bridge.Status()
	text := "No browsers connected."
	if status.ExtensionCount > 0 {
		text = fmt.Sprintf("Connected browsers: %d. Use browserId to target a specific browser.", status.ExtensionCount)
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, StructuredContent: status}
}

func (s *session) forward(ctx context.Context, name string, args map[string]any, tabEnvelope bool) *mcp.CallToolResult {
	browserID, _ := args["browserId"].(string)
	delete(args, "browserId")
	var tabID *int64
	if tabEnvelope {
		n, ok := args["tabId"].(float64)
		if !ok || n != float64(int64(n)) {
			return toolError(name + " requires tabId")
		}
		id := int64(n)
		tabID = &id
		delete(args, "tabId")
	}
	r, err := s.bridge.Dispatch(ctx, name, args, tabID, browserID)
	if err != nil {
		return toolError(bridge.Describe(err))
	}
	return bridgeResult(r)
}

// bridgeResult passes an extension reply that is already a tool result
// through; any other value becomes structured content.
func bridgeResult(r bridge.Result) *mcp.CallToolResult {
	var probe map[string]json.RawMessage
	if json.Unmarshal(r.Result, &probe) == nil {
		_, hasContent := probe["content"]
		_, hasStructured := probe["structuredContent"]
		_, hasIsError := probe["isError"]
		var parsed mcp.CallToolResult
		if (hasContent || hasStructured || hasIsError) && json.Unmarshal(r.Result, &parsed) == nil {
			parsed.IsError = parsed.IsError || r.IsError
			if parsed.Content == nil {
				parsed.Content = []mcp.Content{}
			}
			return &parsed
		}
	}
	var value any
	if err := json.Unmarshal(r.Result, &value); err != nil {
		return toolError("browser extension returned invalid JSON")
	}
	return structured(value, r.IsError)
}

func facadeResult(value map[string]any, err error) *mcp.CallToolResult {
	if err != nil {
		return toolError(bridge.Describe(err))
	}
	return structured(value, value["status"] == "failed")
}

// rendered puts model-facing text in content; the same data stays
// machine-readable in structuredContent, which adapters use for target tracking.
func rendered(render func(map[string]any) string) func(map[string]any, error) *mcp.CallToolResult {
	return func(value map[string]any, err error) *mcp.CallToolResult {
		if err != nil {
			return toolError(bridge.Describe(err))
		}
		text := render(value)
		data, err := json.Marshal(value)
		if err != nil {
			panic(fmt.Sprintf("encode result: %v", err))
		}
		var structured map[string]any
		if err := json.Unmarshal(data, &structured); err != nil {
			panic(fmt.Sprintf("decode result: %v", err))
		}
		return &mcp.CallToolResult{
			IsError:           value["status"] == "failed",
			Content:           []mcp.Content{&mcp.TextContent{Text: text}},
			StructuredContent: structured,
		}
	}
}

func loginResult(value any, err error) *mcp.CallToolResult {
	if err != nil {
		return toolError(err.Error())
	}
	return structured(value, false)
}

func resolveUploadPaths(args map[string]any) error {
	raw, ok := args["paths"].([]any)
	if !ok || len(raw) == 0 {
		return errors.New("file_upload requires paths: a non-empty array of absolute local file paths")
	}
	paths := make([]any, len(raw))
	for i, p := range raw {
		s, ok := p.(string)
		if !ok {
			return errors.New("file_upload.paths must contain strings")
		}
		canonical, err := catalog.CanonicalUploadPath("file_upload", s)
		if err != nil {
			return err
		}
		paths[i] = canonical
	}
	args["paths"] = paths
	return nil
}
