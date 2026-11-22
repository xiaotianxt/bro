// Package bridge owns authenticated extension connections and routes tool
// calls to them over the /ws protocol.
//
// browserId is the extension instanceId. The default browser is the latest
// connected one. Every pending call has a bounded timeout and is completed when
// its connection ends. A reply completes a call only when it arrives on the
// connection the call was sent to.
package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/xiaotianxt/bro/internal/ids"
)

const toolCallTimeout = 30 * time.Second

var (
	ErrNoBrowser    = errors.New("no browser extension is connected")
	ErrDisconnected = errors.New("browser extension disconnected")
	ErrCancelled    = errors.New("request cancelled; already-dispatched effects are not undone")
)

// UnknownBrowserError names a browserId that is not connected.
type UnknownBrowserError struct{ BrowserID string }

func (e UnknownBrowserError) Error() string { return "unknown browser id: " + e.BrowserID }

// Result is an extension reply. Result holds the raw payload; IsError is set
// for tool_error frames, payloads with isError:true, timeouts and disconnects.
type Result struct {
	Result  json.RawMessage
	IsError bool
}

func errorResult(message string) Result {
	data, _ := json.Marshal(map[string]string{"message": message})
	return Result{Result: data, IsError: true}
}

// Heartbeat probes an authenticated connection for liveness.
type Heartbeat struct {
	Interval time.Duration
	// Timeout is the silence after which the connection is dead; it must exceed Interval.
	Timeout time.Duration
}

// BrowserInfo is what the extension reports about its browser.
type BrowserInfo struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Platform  string `json:"platform"`
	UserAgent string `json:"userAgent"`
}

type connectMessage struct {
	Type         string       `json:"type"`
	Version      string       `json:"version"`
	ExtensionID  string       `json:"extensionId"`
	InstanceID   string       `json:"instanceId"`
	Token        string       `json:"token"`
	ActiveTabURL *string      `json:"activeTabUrl"`
	BrowserInfo  *BrowserInfo `json:"browserInfo"`
}

type connection struct {
	ws           *websocket.Conn
	extensionID  string
	sessionID    string
	activeTabURL *string
	browserInfo  *BrowserInfo
	lastSeen     time.Time
	seq          uint64
}

type pendingCall struct {
	browserID, sessionID string
	done                 chan Result
}

// Bridge is safe for concurrent use.
type Bridge struct {
	mu       sync.Mutex
	browsers map[string]*connection
	latest   string
	seq      uint64
	pending  map[string]*pendingCall
	log      *slog.Logger
}

func New(log *slog.Logger) *Bridge {
	return &Bridge{browsers: map[string]*connection{}, pending: map[string]*pendingCall{}, log: log}
}

// Target is the authority for dependent work and cleanup: a browser and the
// exact connection it was bound on. It never rebinds after a reconnect.
type Target struct {
	BrowserID string
	sessionID string
}

// ExtensionStatus is one connection in /status.
type ExtensionStatus struct {
	BrowserID      string       `json:"browserId"`
	ExtensionID    string       `json:"extensionId"`
	SessionID      string       `json:"sessionId"`
	ActiveTabURL   *string      `json:"activeTabUrl"`
	BrowserInfo    *BrowserInfo `json:"browserInfo"`
	LastSeenUnixMs int64        `json:"lastSeenUnixMs"`
}

// Status is the /status and browsers_context payload.
type Status struct {
	ExtensionCount   int               `json:"extensionCount"`
	DefaultBrowserID *string           `json:"defaultBrowserId"`
	Extensions       []ExtensionStatus `json:"extensions"`
}

func (b *Bridge) ExtensionCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.browsers)
}

func (b *Bridge) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := Status{Extensions: []ExtensionStatus{}}
	for id, c := range b.browsers {
		st.Extensions = append(st.Extensions, ExtensionStatus{
			BrowserID: id, ExtensionID: c.extensionID, SessionID: c.sessionID,
			ActiveTabURL: c.activeTabURL, BrowserInfo: c.browserInfo, LastSeenUnixMs: c.lastSeen.UnixMilli(),
		})
	}
	sort.Slice(st.Extensions, func(i, j int) bool { return st.Extensions[i].BrowserID < st.Extensions[j].BrowserID })
	st.ExtensionCount = len(st.Extensions)
	if b.latest != "" {
		latest := b.latest
		st.DefaultBrowserID = &latest
	}
	return st
}

func (b *Bridge) resolve(browserID string) (string, *connection, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if browserID == "" {
		if b.latest == "" {
			return "", nil, ErrNoBrowser
		}
		browserID = b.latest
	}
	c, ok := b.browsers[browserID]
	if !ok {
		return "", nil, UnknownBrowserError{browserID}
	}
	return browserID, c, nil
}

// Bind captures the selected browser and its current connection.
func (b *Bridge) Bind(browserID string) (Target, error) {
	id, c, err := b.resolve(browserID)
	if err != nil {
		return Target{}, err
	}
	return Target{BrowserID: id, sessionID: c.sessionID}, nil
}

// Dispatch sends a tool call to browserID (or the default browser).
func (b *Bridge) Dispatch(ctx context.Context, tool string, args any, tabID *int64, browserID string) (Result, error) {
	return b.dispatch(ctx, tool, args, tabID, browserID, "")
}

// Dispatch sends a tool call on the target's original connection only.
func (t Target) Dispatch(ctx context.Context, b *Bridge, tool string, args any, tabID *int64) (Result, error) {
	return b.dispatch(ctx, tool, args, tabID, t.BrowserID, t.sessionID)
}

func (b *Bridge) dispatch(ctx context.Context, tool string, args any, tabID *int64, browserID, expectedSession string) (Result, error) {
	id, c, err := b.resolve(browserID)
	if err != nil {
		return Result{}, err
	}
	if expectedSession != "" && expectedSession != c.sessionID {
		return Result{}, ErrDisconnected
	}
	if args == nil {
		args = map[string]any{}
	}
	requestID := ids.UUID()
	call := &pendingCall{browserID: id, sessionID: c.sessionID, done: make(chan Result, 1)}
	b.mu.Lock()
	b.pending[requestID] = call
	b.mu.Unlock()
	// Removal on every exit also covers cancellation by the caller.
	defer func() {
		b.mu.Lock()
		delete(b.pending, requestID)
		b.mu.Unlock()
	}()

	frame := map[string]any{"type": "tool_call", "requestId": requestID, "tool": tool, "args": args}
	if tabID != nil {
		frame["tabId"] = *tabID
	}
	if err := send(c.ws, frame); err != nil {
		return Result{}, ErrDisconnected
	}
	timer := time.NewTimer(toolCallTimeout)
	defer timer.Stop()
	select {
	case r := <-call.done:
		return r, nil
	case <-timer.C:
		return errorResult("tool call timed out"), nil
	case <-ctx.Done():
		return Result{}, ErrCancelled
	}
}

// ReloadAll asks every connected extension to reload and returns how many were asked.
func (b *Bridge) ReloadAll() int {
	b.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(b.browsers))
	for _, c := range b.browsers {
		conns = append(conns, c.ws)
	}
	b.mu.Unlock()
	sent := 0
	for _, ws := range conns {
		if send(ws, map[string]string{"type": "reload_extension"}) == nil {
			sent++
		}
	}
	return sent
}

func send(ws *websocket.Conn, frame any) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return ws.Write(ctx, websocket.MessageText, data)
}

// Serve runs one extension connection until it ends. The first frame must be
// a connect message carrying token within authTimeout, else the socket gets a
// policy-violation close and is never registered.
func (b *Bridge) Serve(ws *websocket.Conn, token string, authTimeout time.Duration, hb Heartbeat) {
	ws.SetReadLimit(-1)
	type frame struct {
		typ  websocket.MessageType
		data []byte
		err  error
	}
	first := make(chan frame, 1)
	go func() {
		typ, data, err := ws.Read(context.Background())
		first <- frame{typ, data, err}
	}()
	var f frame
	select {
	case f = <-first:
	case <-time.After(authTimeout):
		_ = ws.Close(websocket.StatusPolicyViolation, "authentication timed out")
		return
	}
	if f.err != nil {
		_ = ws.CloseNow()
		return
	}
	var connect connectMessage
	if f.typ != websocket.MessageText || json.Unmarshal(f.data, &connect) != nil ||
		connect.Type != "connect" || connect.InstanceID == "" || connect.Token != token {
		_ = ws.Close(websocket.StatusPolicyViolation, "authentication failed")
		return
	}

	browserID, sessionID := connect.InstanceID, ids.UUID()
	if err := send(ws, map[string]string{"type": "connected", "sessionId": sessionID}); err != nil {
		_ = ws.CloseNow()
		return
	}
	b.register(connect, sessionID, ws)
	defer b.unregister(browserID, sessionID)

	// A connection that dies without a close frame never ends the read loop on
	// its own, and the extension reconnects only once its socket closes.
	// Protocol pings, answered by the extension's JS, bound how long a dead
	// session keeps receiving calls.
	var lastInbound atomic.Int64
	lastInbound.Store(time.Now().UnixNano())
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(hb.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				silent := time.Since(time.Unix(0, lastInbound.Load()))
				if silent >= hb.Timeout {
					b.log.Warn("dropping unresponsive browser extension connection",
						"browser_id", browserID, "silent_ms", silent.Milliseconds())
					_ = ws.CloseNow()
					return
				}
				_ = send(ws, map[string]string{"type": "ping", "sessionId": sessionID})
			}
		}
	}()

	for {
		typ, data, err := ws.Read(context.Background())
		if err != nil {
			if status := websocket.CloseStatus(err); status != websocket.StatusNormalClosure && status != websocket.StatusGoingAway {
				b.log.Debug("websocket bridge closed", "browser_id", browserID, "error", err)
			}
			return
		}
		lastInbound.Store(time.Now().UnixNano())
		if typ == websocket.MessageText {
			b.handleMessage(browserID, sessionID, data)
		}
	}
}

func (b *Bridge) register(connect connectMessage, sessionID string, ws *websocket.Conn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	b.latest = connect.InstanceID
	b.browsers[connect.InstanceID] = &connection{
		ws: ws, extensionID: connect.ExtensionID, sessionID: sessionID,
		activeTabURL: connect.ActiveTabURL, browserInfo: connect.BrowserInfo,
		lastSeen: time.Now(), seq: b.seq,
	}
}

// unregister removes the connection only if it is still the current one for
// browserID, so a stale disconnect never drops its replacement.
func (b *Bridge) unregister(browserID, sessionID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if c, ok := b.browsers[browserID]; ok && c.sessionID == sessionID {
		delete(b.browsers, browserID)
		if b.latest == browserID {
			b.latest = ""
			var best uint64
			for id, c := range b.browsers {
				if c.seq >= best {
					best, b.latest = c.seq, id
				}
			}
		}
	}
	for requestID, call := range b.pending {
		if call.browserID == browserID && call.sessionID == sessionID {
			delete(b.pending, requestID)
			call.done <- errorResult("browser extension disconnected")
		}
	}
}

func (b *Bridge) handleMessage(browserID, sessionID string, data []byte) {
	var msg struct {
		Type      string          `json:"type"`
		RequestID string          `json:"requestId"`
		Result    json.RawMessage `json:"result"`
		Error     struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &msg) != nil {
		return
	}
	switch msg.Type {
	case "tool_result":
		var flag struct {
			IsError bool `json:"isError"`
		}
		_ = json.Unmarshal(msg.Result, &flag)
		result := msg.Result
		if len(result) == 0 {
			result = json.RawMessage("null")
		}
		b.complete(msg.RequestID, browserID, sessionID, Result{Result: result, IsError: flag.IsError})
	case "tool_error":
		b.complete(msg.RequestID, browserID, sessionID, errorResult(msg.Error.Message))
	case "pong":
	default:
		return
	}
	b.touch(browserID, sessionID)
}

func (b *Bridge) complete(requestID, browserID, sessionID string, r Result) {
	b.mu.Lock()
	defer b.mu.Unlock()
	call, ok := b.pending[requestID]
	if !ok || call.browserID != browserID || call.sessionID != sessionID {
		return
	}
	delete(b.pending, requestID)
	call.done <- r
}

func (b *Bridge) touch(browserID, sessionID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if c, ok := b.browsers[browserID]; ok && c.sessionID == sessionID {
		c.lastSeen = time.Now()
	}
}

// Describe renders a bridge error for MCP clients.
func Describe(err error) string {
	var unknown UnknownBrowserError
	switch {
	case errors.Is(err, ErrNoBrowser):
		return "No extension connected. Load the Bro extension in Chrome."
	case errors.As(err, &unknown):
		return fmt.Sprintf("Browser %s not found.", unknown.BrowserID)
	default:
		return err.Error()
	}
}
