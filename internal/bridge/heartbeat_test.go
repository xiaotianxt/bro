package bridge

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A connection that stays open but stops answering pings is dropped by the
// heartbeat, and its pending call fails then instead of at the call timeout.
// e2e cannot cover this without waiting out the production 45 s timeout.
func TestSilentConnectionIsDroppedAndFailsItsPendingCall(t *testing.T) {
	b := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		b.Serve(ws, "secret", time.Second, Heartbeat{Interval: 20 * time.Millisecond, Timeout: 80 * time.Millisecond})
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	connect := `{"type":"connect","version":"1","extensionId":"e","instanceId":"a","token":"secret"}`
	if err := ws.Write(ctx, websocket.MessageText, []byte(connect)); err != nil {
		t.Fatal(err)
	}
	if _, data, err := ws.Read(ctx); err != nil || !strings.Contains(string(data), `"connected"`) {
		t.Fatalf("connected frame: %q %v", data, err)
	}
	// Keep reading so frames are consumed, but never answer ping or tool_call.
	go func() {
		for {
			if _, _, err := ws.Read(ctx); err != nil {
				return
			}
		}
	}()

	start := time.Now()
	r, err := b.Dispatch(ctx, "tabs_context", map[string]any{}, nil, "")
	if err != nil || !r.IsError || !strings.Contains(string(r.Result), ErrDisconnected.Error()) {
		t.Fatalf("dispatch = %s, %v; want the disconnected error result", r.Result, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("pending call waited %v for the heartbeat", elapsed)
	}
	if n := b.ExtensionCount(); n != 0 {
		t.Fatalf("%d connections still registered", n)
	}
}
