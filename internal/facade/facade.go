// Package facade composes extension primitives into bro's higher-level tools:
// owned and attached targets (open/attach/observe/act/close), batch flows,
// extraction and console/network capture.
//
// Ownership: a tab bro opens is registered before its first use and is closed
// on the connection it was opened on, never on a replacement connection that
// may reuse the tab id. Failed cleanup keeps the target registered so an
// explicit browser.close can retry. Request cancellation stops new dispatches;
// already-dispatched effects are not undone, and required cleanup ignores it.
package facade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/xiaotianxt/bro/internal/bridge"
	"github.com/xiaotianxt/bro/internal/ids"
)

const (
	defaultBatchConcurrency = 6
	maxBatchConcurrency     = 16
	defaultTimeoutMs        = 12_000
	maxTimeoutMs            = 60_000
	openSettleTimeout       = 4 * time.Second
	// readyProbeChars bounds the text a readiness wait compares between polls.
	readyProbeChars        = 2000
	defaultTextReadyMin    = 120
	maxTextReadyMin        = 10_000
	extractPageGuardMs     = 8_000
	defaultExtractMaxChars = 20_000
	defaultBatchExtractMax = 8_000
	maxExtractMaxChars     = 60_000
	defaultExtractMaxLinks = 20
	maxExtractMaxLinks     = 200
	textReadyPoll          = 250 * time.Millisecond
	maxWaitMs              = 30_000
	cleanupTimeout         = 2 * time.Second
	observeMaxChars        = 8_000
	// An act observation verifies one action: a small default budget.
	actObserveMaxChars    = 3_000
	maxObserveChars       = 20_000
	maxA11yObserveChars   = 12_000
	defaultWaitTimeoutMs  = 5_000
	maxWaitTimeoutMs      = 15_000
	waitPoll              = 250 * time.Millisecond
	consoleCaptureTimeout = 5_000
	consoleCaptureMaxMsgs = 100
	networkCaptureTimeout = 10_000
	networkCaptureMaxBody = 20_000
	networkCaptureMaxReqs = 20
)

// InvalidInputError is a request rejected before any browser effect.
type InvalidInputError struct{ Message string }

func (e InvalidInputError) Error() string { return "invalid input: " + e.Message }

func invalid(format string, args ...any) error {
	return InvalidInputError{fmt.Sprintf(format, args...)}
}

// ToolFailedError is an extension tool that reported failure.
type ToolFailedError struct{ Tool, Message string }

func (e ToolFailedError) Error() string {
	return fmt.Sprintf("browser tool %s failed: %s", e.Tool, e.Message)
}

// CleanupError is an owned tab that could not be closed; the target stays registered.
type CleanupError struct {
	TargetID string
	Err      error
}

func (e CleanupError) Error() string {
	return fmt.Sprintf("cleanup failed for targetId %s: %v", e.TargetID, e.Err)
}

func (e CleanupError) Unwrap() error { return e.Err }

type unknownSessionError struct{ id string }

func (e unknownSessionError) Error() string { return "unknown flow session: " + e.id }

// session is a registered target.
type session struct {
	ID      string
	TabID   int64
	Browser bridge.Target
	URL     string
	Cleanup bool
	// Owned is false for an attached tab, which bro never closes.
	Owned bool
	// ReadyPending: opened with deferred readiness, not yet observed or acted on.
	ReadyPending bool
}

// Facade is shared by every MCP session.
type Facade struct {
	bridge   *bridge.Bridge
	log      *slog.Logger
	mu       sync.Mutex
	sessions map[string]session
	watches  watchRegistry
}

func New(b *bridge.Bridge, log *slog.Logger) *Facade {
	f := &Facade{bridge: b, log: log, sessions: map[string]session{}, watches: watchRegistry{watches: map[string]*watch{}}}
	b.OnWatchEvent(f.watchEvent)
	return f
}

func newTargetID() string { return "flow-" + ids.Hex(6) }

// dispatch sends a call on the target's original connection unless the
// request is already cancelled.
func (f *Facade) dispatch(ctx context.Context, tool string, args any, tabID int64, target bridge.Target) (bridge.Result, error) {
	if ctx.Err() != nil {
		return bridge.Result{}, bridge.ErrCancelled
	}
	return target.Dispatch(ctx, f.bridge, tool, args, &tabID)
}

func (f *Facade) session(id string) (session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sessions[id]
	if !ok {
		return session{}, unknownSessionError{id}
	}
	return s, nil
}

func (f *Facade) store(s session) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[s.ID] = s
}

func (f *Facade) remove(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sessions, id)
}

func (f *Facade) updateURL(id, url string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s, ok := f.sessions[id]; ok {
		s.URL = url
		f.sessions[id] = s
	}
}

func (f *Facade) closeTab(ctx context.Context, s session) error {
	r, err := s.Browser.Dispatch(ctx, f.bridge, "tabs_close", map[string]any{"tabId": s.TabID}, nil)
	if err != nil {
		return err
	}
	return failIfToolError("tabs_close", r)
}

// releaseSession closes an owned, cleanup-enabled tab within cleanupTimeout
// and forgets the target; on failure the target is kept for a retry.
func (f *Facade) releaseSession(s session) error {
	if s.Cleanup {
		ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
		err := f.closeTab(ctx, s)
		cancel()
		if errors.Is(err, bridge.ErrCancelled) {
			err = ToolFailedError{"tabs_close", "cleanup timed out"}
		}
		if err != nil {
			return CleanupError{s.ID, err}
		}
	}
	f.remove(s.ID)
	return nil
}

// ownedTab is a freshly allocated tab whose cleanup is still this code's
// responsibility. Call release on every exit; handOff transfers ownership to
// the target map instead.
type ownedTab struct {
	session
	Title string
	f     *Facade
	armed bool
}

// startCleanup begins the one close this tab gets. The waiter may leave; the
// close still completes and reports failure at the owner.
func (o *ownedTab) startCleanup() <-chan error {
	o.armed = false
	done := make(chan error, 1)
	s := o.session
	go func() {
		err := o.f.releaseSession(s)
		if err != nil {
			o.f.log.Warn("owned tab cleanup failed; ownership retained",
				"tab_id", s.TabID, "target_id", s.ID, "error", err.Error())
		}
		done <- err
	}()
	return done
}

// cleanup closes the tab and waits unless ctx ends first.
func (o *ownedTab) cleanup(ctx context.Context) error {
	done := o.startCleanup()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (o *ownedTab) release() {
	if o.armed {
		o.startCleanup()
	}
}

func (o *ownedTab) handOff() session {
	o.armed = false
	return o.session
}

// acquire opens a tab. The allocation runs to its bounded bridge reply even
// if ctx ends; a reply that arrives after the caller left is closed on the
// original connection, never on a replacement browser.
func (f *Facade) acquire(ctx context.Context, browser bridge.Target, args map[string]any, url string, cleanup bool) (*ownedTab, error) {
	if ctx.Err() != nil {
		return nil, bridge.ErrCancelled
	}
	readyPending := args["deferReadiness"] == true && url != "about:blank"
	type outcome struct {
		tab *ownedTab
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		r, err := browser.Dispatch(context.WithoutCancel(ctx), f.bridge, "tabs_create", args, nil)
		if err == nil {
			err = failIfToolError("tabs_create", r)
		}
		if err != nil {
			done <- outcome{err: err}
			return
		}
		value := decode(r.Result)
		tabID, ok := extractTabID(value)
		if !ok {
			done <- outcome{err: ToolFailedError{"tabs_create", "response did not include tabId"}}
			return
		}
		s := session{ID: newTargetID(), TabID: tabID, Browser: browser, URL: url, Cleanup: cleanup, Owned: true, ReadyPending: readyPending}
		f.store(s)
		title, _ := findStringKey(value, "title")
		done <- outcome{tab: &ownedTab{session: s, Title: title, f: f, armed: true}}
	}()
	select {
	case o := <-done:
		return o.tab, o.err
	case <-ctx.Done():
		go func() {
			if o := <-done; o.tab != nil {
				o.tab.release()
			}
		}()
		return nil, bridge.ErrCancelled
	}
}

// finish releases a target and reports whether cleanup ran and how it failed.
// An attached tab is the user's or the page's: releasing never closes it.
func (f *Facade) finish(ctx context.Context, id string) (session, bool, string, error) {
	s, err := f.session(id)
	if err != nil {
		return session{}, false, "", err
	}
	cleanup := s.Owned
	closeError := ""
	if cleanup {
		if err := f.closeTab(context.WithoutCancel(ctx), s); err != nil {
			closeError = err.Error()
		}
	}
	// Retain failed cleanup for an explicit retry or adapter shutdown.
	if closeError == "" {
		f.remove(id)
	}
	return s, cleanup, closeError, nil
}

func failIfToolError(tool string, r bridge.Result) error {
	if msg, failed := toolErrorMessage(r); failed {
		return ToolFailedError{tool, msg}
	}
	return nil
}

func toolErrorMessage(r bridge.Result) (string, bool) {
	if !r.IsError {
		return "", false
	}
	value := decode(r.Result)
	if msg, ok := findStringKey(value, "message"); ok {
		return msg, true
	}
	if text, ok := extractText(value); ok {
		return text, true
	}
	return "browser tool returned an error", true
}

func decode(raw json.RawMessage) any {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return v
}

// stepError keeps the browser's own message: the step already names its tool.
func stepError(err error) string {
	var tf ToolFailedError
	if errors.As(err, &tf) {
		return strings.TrimPrefix(tf.Message, "Error: ")
	}
	return err.Error()
}
