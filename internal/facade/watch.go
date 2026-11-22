package facade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/xiaotianxt/bro/internal/bridge"
	"github.com/xiaotianxt/bro/internal/ids"
)

// A watch reports changes on a page until its condition is met, its time runs
// out, or its tab or browser goes away. The server owns it: its clock decides
// when to probe (page timers are throttled in background tabs) and it keeps
// the last value seen, so a probe that finds the page's latch gone (a
// navigation, a re-render, a service worker restart) can lose a transient but
// never a change that is still on the page. The extension's probe is
// stateless apart from that latch.
//
// A watch never sits silent: every read reports the tab's state and when it
// was last probed, and a frozen, unresponsive or disconnected tab is an event.

const (
	defaultWatchInterval = time.Second
	minWatchIntervalMs   = 250
	maxWatchIntervalMs   = 60_000
	defaultWatchDuration = 30 * time.Minute
	maxWatchDurationMs   = 24 * 60 * 60 * 1000
	defaultWatchReadWait = 20 * time.Second
	maxWatchReadWaitMs   = 50_000
	maxWatchEvents       = 200
	maxActiveWatches     = 16
	watchRetention       = 10 * time.Minute
	watchSnippetChars    = 160
	maxWatchPatternChars = 200
	maxWatchAdded        = 5
	watchProbeBound      = 5 * time.Second
	watchUnresponsiveEnd = 60 * time.Second
	watchDisconnectedEnd = 30 * time.Second
	watchErrorEnd        = 60 * time.Second
	watchErrorShown      = 5 * time.Second
	watchResolveBackoff  = 5 * time.Second
	watchStopBound       = 3 * time.Second
	watchCleanupBound    = 2 * time.Second
)

// Watch end reasons.
const (
	endMet          = "met"
	endTimeout      = "timeout"
	endStopped      = "stopped"
	endTabClosed    = "tabClosed"
	endDiscarded    = "discarded"
	endUnresponsive = "unresponsive"
	endDisconnected = "extensionDisconnected"
	endError        = "error"
)

type watchCond struct {
	kind    string // text, textGone, pattern, state, change, count
	text    string
	pattern string
	state   string
}

// until conditions end the watch when first met; the others stream changes.
func (c watchCond) until() bool { return c.kind != "change" && c.kind != "count" }

func (c watchCond) probeArgs() map[string]any {
	m := map[string]any{"kind": c.kind}
	switch c.kind {
	case "text", "textGone":
		m["text"] = c.text
	case "pattern":
		m["pattern"] = c.pattern
	case "state":
		m["state"] = c.state
	}
	return m
}

type watchTarget struct {
	css        string
	refID      string
	role, name string
	// frameID is the CDP frame id observe prints ("" is the main frame, or a
	// ref's own frame); scriptFrame is the chrome.scripting id a probe
	// resolved it to, sent back so later probes skip locating the frame.
	frameID     string
	scriptFrame *int64
}

func (t watchTarget) kind() string {
	switch {
	case t.css != "":
		return "css"
	case t.refID != "" || t.role != "":
		return "node"
	default:
		return "page"
	}
}

func (t watchTarget) probeArgs() map[string]any {
	m := map[string]any{"kind": t.kind()}
	switch t.kind() {
	case "css":
		m["css"] = t.css
	case "node":
		if t.refID != "" {
			m["refId"] = t.refID
		} else {
			m["role"], m["name"] = t.role, t.name
		}
	}
	if t.frameID != "" {
		m["frameId"] = t.frameID
	}
	if t.scriptFrame != nil {
		m["scriptFrame"] = *t.scriptFrame
	}
	return m
}

func (t watchTarget) describe() string {
	switch t.kind() {
	case "css":
		return " in " + t.css
	case "node":
		if t.refID != "" {
			return " in " + t.refID
		}
		return " in " + t.role + " " + jsonText(t.name)
	default:
		return ""
	}
}

func describeWatch(c watchCond, t watchTarget) string {
	if t.frameID != "" {
		return describeCondition(c, t) + " in frame " + t.frameID
	}
	return describeCondition(c, t)
}

func describeCondition(c watchCond, t watchTarget) string {
	switch c.kind {
	case "text":
		return "text " + jsonText(c.text) + " appears" + t.describe()
	case "textGone":
		return "text " + jsonText(c.text) + " is gone" + t.describe()
	case "pattern":
		return "text matches /" + c.pattern + "/i" + t.describe()
	case "state":
		where := strings.TrimPrefix(t.describe(), " in ")
		return where + " is " + c.state
	case "change":
		if t.kind() == "page" {
			return "page text changes"
		}
		return "text or value changes" + t.describe()
	default:
		return "match count changes" + t.describe()
	}
}

// watchValue is one evaluation from the page (see extension watch.ts).
type watchValue struct {
	At      int64    `json:"at"`
	Met     *bool    `json:"met"`
	Snippet string   `json:"snippet"`
	Text    *string  `json:"text"`
	Count   *int64   `json:"count"`
	Items   []string `json:"items"`
}

type probeResult struct {
	Tab        string                       `json:"tab"`
	URL        string                       `json:"url"`
	Installed  bool                         `json:"installed"`
	Records    []watchValue                 `json:"records"`
	Dropped    int64                        `json:"dropped"`
	TargetLost bool                         `json:"targetLost"`
	Resolved   *struct{ Role, Name string } `json:"resolved"`
	Frame      *struct {
		FrameID     string `json:"frameId"`
		ScriptFrame int64  `json:"scriptFrame"`
	} `json:"frame"`
	ResolveError string `json:"resolveError"`
}

// WatchEvent is one entry in a watch's event log.
type WatchEvent struct {
	Seq      int64    `json:"seq"`
	Type     string   `json:"type"` // initial, met, change, count, navigated, tab, target, end
	Ms       int64    `json:"ms"`
	Value    string   `json:"value,omitempty"`
	Previous string   `json:"previous,omitempty"`
	Count    *int64   `json:"count,omitempty"`
	Added    []string `json:"added,omitempty"`
	URL      string   `json:"url,omitempty"`
	State    string   `json:"state,omitempty"`
	Reason   string   `json:"reason,omitempty"`
	Error    string   `json:"error,omitempty"`
}

type dispatcher func(ctx context.Context, args map[string]any) (bridge.Result, error)

type watch struct {
	id        string
	targetID  string
	tabID     int64
	cond      watchCond
	condition string
	interval  time.Duration
	started   time.Time
	deadline  time.Time
	dispatch  dispatcher
	cancel    context.CancelFunc
	done      chan struct{}

	mu        sync.Mutex
	target    watchTarget
	events    []WatchEvent
	seq       int64
	dropped   int64 // events evicted from the buffer
	missed    int64 // page values the latch dropped
	wake      chan struct{}
	reason    string
	endedAt   time.Time
	tab       string
	probedAt  time.Time
	url       string
	last      *watchValue
	lost      bool
	lostError string
	// resolveFailed is when re-resolving a lost node target last failed.
	resolveFailed time.Time
	// trouble is the failing probe state (unresponsive, disconnected, error)
	// and when it started; empty while probes succeed.
	trouble      string
	troubleSince time.Time
	troubleError string
	troubleShown bool
}

func (w *watch) ended() bool { return w.reason != "" }

// emit appends an event and wakes readers. Caller holds mu.
func (w *watch) emit(e WatchEvent) {
	w.seq++
	e.Seq = w.seq
	e.Ms = time.Since(w.started).Milliseconds()
	w.events = append(w.events, e)
	if len(w.events) > maxWatchEvents {
		w.events = w.events[1:]
		w.dropped++
	}
	close(w.wake)
	w.wake = make(chan struct{})
}

// end records why the watch ended; the first reason wins. Caller holds mu.
func (w *watch) end(reason, message string) {
	if w.ended() {
		return
	}
	w.reason = reason
	w.endedAt = time.Now()
	w.emit(WatchEvent{Type: "end", Reason: reason, Error: message})
}

func snippet(s string) string { return truncateRunes(s, watchSnippetChars) }

// diffSnippets windows both texts around their first difference.
func diffSnippets(prev, cur string) (string, string) {
	i := 0
	for i < len(prev) && i < len(cur) && prev[i] == cur[i] {
		i++
	}
	for i > 0 && !utf8.RuneStart(cur[min(i, len(cur)-1)]) {
		i--
	}
	start := max(0, i-40)
	for start > 0 && start < len(cur) && !utf8.RuneStart(cur[start]) {
		start--
	}
	window := func(s string) string {
		if start >= len(s) {
			return snippet(s[max(0, len(s)-watchSnippetChars):])
		}
		return snippet(s[start:])
	}
	return window(prev), window(cur)
}

// added lists items in cur that prev does not account for (a multiset diff).
func added(prev, cur []string) []string {
	seen := map[string]int{}
	for _, s := range prev {
		seen[s]++
	}
	var out []string
	for _, s := range cur {
		if seen[s] > 0 {
			seen[s]--
			continue
		}
		out = append(out, s)
	}
	if len(out) > maxWatchAdded {
		out = out[len(out)-maxWatchAdded:]
	}
	return out
}

// observe turns one page value into events. Caller holds mu.
func (w *watch) observe(v watchValue, url string) {
	if w.ended() {
		return
	}
	prev := w.last
	w.last = &v
	switch {
	case w.cond.until():
		met := v.Met != nil && *v.Met
		wasMet := prev != nil && prev.Met != nil && *prev.Met
		if met && !wasMet {
			w.emit(WatchEvent{Type: "met", Value: v.Snippet, URL: url})
			w.end(endMet, "")
		}
	case w.cond.kind == "change":
		cur := ""
		if v.Text != nil {
			cur = *v.Text
		}
		if prev == nil {
			w.emit(WatchEvent{Type: "initial", Value: snippet(cur), URL: url})
			return
		}
		old := ""
		if prev.Text != nil {
			old = *prev.Text
		}
		if old != cur || derefInt(prev.Count) != derefInt(v.Count) {
			p, c := diffSnippets(old, cur)
			w.emit(WatchEvent{Type: "change", Value: c, Previous: p, URL: url})
		}
	default:
		count := derefInt(v.Count)
		if prev == nil {
			w.emit(WatchEvent{Type: "initial", Count: &count, URL: url})
			return
		}
		if old := derefInt(prev.Count); old != count {
			e := WatchEvent{Type: "count", Count: &count, Previous: fmt.Sprint(old), URL: url}
			e.Added = added(prev.Items, v.Items)
			w.emit(e)
		}
	}
}

func derefInt(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// setTrouble records a failing probe and ends the watch once it has failed
// for longer than the state's bound. An unresponsive or disconnected tab is
// an event at once; a probe error is one only once it persists, because a
// navigation fails a probe or two on its own and each event can wake an agent.
// Caller holds mu.
func (w *watch) setTrouble(state, message string, now time.Time) {
	if w.trouble != state {
		w.trouble, w.troubleSince, w.troubleShown = state, now, false
		w.tab = state
	}
	if !w.troubleShown && (state != "error" || now.Sub(w.troubleSince) >= watchErrorShown) {
		w.troubleShown = true
		w.emit(WatchEvent{Type: "tab", State: state, Error: message})
	}
	w.troubleError = message
	var bound time.Duration
	var reason string
	switch state {
	case "unresponsive":
		bound, reason = watchUnresponsiveEnd, endUnresponsive
	case "disconnected":
		bound, reason = watchDisconnectedEnd, endDisconnected
	default:
		bound, reason = watchErrorEnd, endError
	}
	if now.Sub(w.troubleSince) >= bound {
		w.end(reason, message)
	}
}

// probe runs one probe and applies its result. A probe failure is not
// returned: it becomes the watch's state, and its end once it persists.
func (w *watch) probe(ctx context.Context) {
	w.mu.Lock()
	target := w.target
	// The page re-resolves only when its pinned node is gone; a resolve that
	// failed (an AX tree read costs seconds on a large page) waits a backoff.
	resolve := target.kind() == "node" && time.Since(w.resolveFailed) >= watchResolveBackoff
	w.mu.Unlock()
	args := map[string]any{
		"watchId": w.id, "op": "probe", "resolve": resolve,
		"target": target.probeArgs(), "condition": w.cond.probeArgs(),
	}
	pctx, cancel := context.WithTimeout(ctx, watchProbeBound)
	r, err := w.dispatch(pctx, args)
	timedOut := pctx.Err() != nil && ctx.Err() == nil
	cancel()
	now := time.Now()
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ended() || ctx.Err() != nil {
		return
	}
	switch {
	case timedOut:
		w.setTrouble("unresponsive", fmt.Sprintf("tab %d did not answer a probe within %v", w.tabID, watchProbeBound), now)
		return
	case err != nil:
		if errors.Is(err, bridge.ErrNoBrowser) || errors.Is(err, bridge.ErrDisconnected) || errors.As(err, new(bridge.UnknownBrowserError)) {
			w.setTrouble("disconnected", bridge.Describe(err), now)
		} else {
			w.setTrouble("error", bridge.Describe(err), now)
		}
		return
	}
	if msg, failed := toolErrorMessage(r); failed {
		if strings.Contains(msg, "browser extension disconnected") {
			w.setTrouble("disconnected", msg, now)
		} else {
			w.setTrouble("error", strings.TrimPrefix(msg, "Error: "), now)
		}
		return
	}
	var p probeResult
	if err := json.Unmarshal([]byte(textOf(decode(r.Result))), &p); err != nil {
		w.setTrouble("error", "unreadable watch probe result: "+err.Error(), now)
		return
	}
	w.probedAt = now
	recovered := w.troubleShown
	w.trouble, w.troubleError, w.troubleShown = "", "", false
	switch p.Tab {
	case "closed":
		w.tab = "closed"
		w.end(endTabClosed, "")
		return
	case "discarded":
		w.tab = "discarded"
		w.end(endDiscarded, fmt.Sprintf("tab %d is discarded: Chrome unloaded its page. Navigate or reload it, then start a new watch.", w.tabID))
		return
	case "frozen":
		if w.tab != "frozen" {
			w.tab = "frozen"
			w.emit(WatchEvent{Type: "tab", State: "frozen", Error: fmt.Sprintf("tab %d is frozen: Chrome runs nothing in it until it unfreezes; activate it (tabs_activate) to resume", w.tabID)})
		}
		return
	}
	if recovered || w.tab == "frozen" {
		w.emit(WatchEvent{Type: "tab", State: "live"})
	}
	w.tab = "live"
	if w.url != "" && p.URL != w.url {
		w.emit(WatchEvent{Type: "navigated", URL: p.URL})
	}
	w.url = p.URL
	w.missed += p.Dropped
	if p.Frame != nil {
		w.target.frameID = p.Frame.FrameID
		w.target.scriptFrame = &p.Frame.ScriptFrame
	}
	if p.Resolved != nil {
		w.target.refID, w.target.role, w.target.name = "", p.Resolved.Role, p.Resolved.Name
	}
	if p.ResolveError != "" {
		w.resolveFailed = now
	}
	if target.kind() == "node" {
		w.lostError = p.ResolveError
		if p.TargetLost != w.lost {
			w.lost = p.TargetLost
			// The first probe has no earlier state to differ from; a start
			// whose target is missing fails instead.
			switch {
			case w.last == nil:
			case w.lost:
				w.emit(WatchEvent{Type: "target", State: "lost", Error: p.ResolveError})
			default:
				w.emit(WatchEvent{Type: "target", State: "found", Value: w.target.role + " " + jsonText(w.target.name)})
			}
		}
	}
	for _, v := range p.Records {
		w.observe(v, p.URL)
	}
}

// stopPage removes the page latch; best effort, the page may be gone.
func (w *watch) stopPage() {
	ctx, cancel := context.WithTimeout(context.Background(), watchCleanupBound)
	defer cancel()
	w.mu.Lock()
	target := w.target
	w.mu.Unlock()
	_, _ = w.dispatch(ctx, map[string]any{
		"watchId": w.id, "op": "stop", "target": target.probeArgs(), "condition": w.cond.probeArgs(),
	})
}

func (w *watch) run(ctx context.Context) {
	defer close(w.done)
	for {
		w.mu.Lock()
		ended := w.ended()
		w.mu.Unlock()
		if ended {
			break
		}
		wait := min(w.interval, time.Until(w.deadline))
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		w.mu.Lock()
		switch {
		case ctx.Err() != nil:
			w.end(endStopped, "")
		case !time.Now().Before(w.deadline):
			w.end(endTimeout, "")
		}
		ended = w.ended()
		w.mu.Unlock()
		if ended {
			break
		}
		w.probe(ctx)
	}
	w.mu.Lock()
	closed := w.tab == "closed"
	w.mu.Unlock()
	if !closed {
		w.stopPage()
	}
}

// read returns the events after cursor, waiting up to wait for one.
func (w *watch) read(ctx context.Context, cursor int64, wait time.Duration) map[string]any {
	deadline := time.Now().Add(wait)
	for {
		w.mu.Lock()
		var events []WatchEvent
		for _, e := range w.events {
			if e.Seq > cursor {
				events = append(events, e)
			}
		}
		remaining := time.Until(deadline)
		if len(events) > 0 || w.ended() || remaining <= 0 || ctx.Err() != nil {
			value := w.snapshot(cursor, events)
			w.mu.Unlock()
			return value
		}
		wake := w.wake
		w.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
		case <-time.After(remaining):
		}
	}
}

// snapshot is the read result. Caller holds mu.
func (w *watch) snapshot(cursor int64, events []WatchEvent) map[string]any {
	next := cursor
	if len(events) > 0 {
		next = events[len(events)-1].Seq
	}
	if events == nil {
		events = []WatchEvent{}
	}
	tab := map[string]any{"state": w.tab}
	if !w.probedAt.IsZero() {
		tab["probedMsAgo"] = time.Since(w.probedAt).Milliseconds()
	}
	if w.troubleError != "" {
		tab["error"] = w.troubleError
	}
	value := map[string]any{
		"watchId": w.id, "targetId": w.targetID, "condition": w.condition,
		"active": !w.ended(), "cursor": next, "events": events, "tab": tab,
	}
	if w.url != "" {
		value["url"] = w.url
	}
	// Events after the cursor that the buffer no longer holds.
	if len(w.events) > 0 {
		if lost := w.events[0].Seq - 1 - cursor; lost > 0 {
			value["dropped"] = lost
		}
	}
	if w.missed > 0 {
		value["missedChanges"] = w.missed
	}
	if w.ended() {
		value["reason"] = w.reason
	}
	return value
}

type watchRegistry struct {
	mu      sync.Mutex
	watches map[string]*watch
}

// sweep forgets watches that ended more than watchRetention ago. Caller holds mu.
func (r *watchRegistry) sweep() {
	for id, w := range r.watches {
		w.mu.Lock()
		old := w.ended() && time.Since(w.endedAt) > watchRetention
		w.mu.Unlock()
		if old {
			delete(r.watches, id)
		}
	}
}

func (r *watchRegistry) get(id string) (*watch, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sweep()
	w, ok := r.watches[id]
	if !ok {
		return nil, invalid("unknown watchId %s: bro restarted, or the watch ended more than %v ago", id, watchRetention)
	}
	return w, nil
}

type watchArgs struct {
	TargetID      *string `json:"targetId"`
	CSS           *string `json:"css"`
	FrameID       *string `json:"frameId"`
	RefID         *string `json:"refId"`
	Role          *string `json:"role"`
	Name          *string `json:"name"`
	Text          *string `json:"text"`
	TextGone      *string `json:"textGone"`
	Pattern       *string `json:"pattern"`
	State         *string `json:"state"`
	Change        *bool   `json:"change"`
	Count         *bool   `json:"count"`
	MaxDurationMs *int64  `json:"maxDurationMs"`
	IntervalMs    *int64  `json:"intervalMs"`
	WaitMs        *int64  `json:"waitMs"`
	WatchID       *string `json:"watchId"`
	Cursor        *int64  `json:"cursor"`
	Stop          *bool   `json:"stop"`
	List          *bool   `json:"list"`
}

func (a watchArgs) startFields() bool {
	return a.TargetID != nil || a.CSS != nil || a.FrameID != nil || a.RefID != nil || a.Role != nil || a.Name != nil ||
		a.Text != nil || a.TextGone != nil || a.Pattern != nil || a.State != nil || a.Change != nil ||
		a.Count != nil || a.MaxDurationMs != nil || a.IntervalMs != nil
}

func waitDuration(ms *int64, def time.Duration) (time.Duration, error) {
	if ms == nil {
		return def, nil
	}
	if *ms < 0 || *ms > maxWatchReadWaitMs {
		return 0, invalid("waitMs must be between 0 and %d", maxWatchReadWaitMs)
	}
	return time.Duration(*ms) * time.Millisecond, nil
}

// Watch is the browser.watch tool: start, read, stop or list by argument shape.
func (f *Facade) Watch(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a watchArgs
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	switch {
	case a.List != nil:
		if !*a.List || a.startFields() || a.WatchID != nil || a.Cursor != nil || a.Stop != nil || a.WaitMs != nil {
			return nil, invalid("list takes only list: true")
		}
		return f.listWatches(), nil
	case a.WatchID != nil:
		if a.startFields() {
			return nil, invalid("a read or stop takes watchId with cursor, waitMs or stop, not start fields")
		}
		w, err := f.watches.get(*a.WatchID)
		if err != nil {
			return nil, err
		}
		cursor := int64(0)
		if a.Cursor != nil {
			if *a.Cursor < 0 {
				return nil, invalid("cursor must be at least 0")
			}
			cursor = *a.Cursor
		}
		if a.Stop != nil {
			if !*a.Stop || a.WaitMs != nil {
				return nil, invalid("stop takes watchId, stop: true and an optional cursor")
			}
			w.cancel()
			select {
			case <-w.done:
			case <-time.After(watchStopBound):
			}
			return w.read(ctx, cursor, 0), nil
		}
		wait, err := waitDuration(a.WaitMs, defaultWatchReadWait)
		if err != nil {
			return nil, err
		}
		return w.read(ctx, cursor, wait), nil
	case a.Cursor != nil || a.Stop != nil:
		return nil, invalid("cursor and stop need a watchId")
	default:
		return f.startWatch(ctx, a)
	}
}

func parseWatchSpec(a watchArgs) (watchTarget, watchCond, error) {
	nonEmpty := func(p *string) bool { return p != nil && strings.TrimSpace(*p) != "" }
	var t watchTarget
	targets := 0
	if a.CSS != nil {
		if !nonEmpty(a.CSS) {
			return t, watchCond{}, invalid("css must be nonempty")
		}
		t.css = *a.CSS
		targets++
	}
	if a.RefID != nil {
		if !nonEmpty(a.RefID) {
			return t, watchCond{}, invalid("refId must be nonempty")
		}
		t.refID = *a.RefID
		targets++
	}
	if a.Role != nil || a.Name != nil {
		if !nonEmpty(a.Role) || !nonEmpty(a.Name) {
			return t, watchCond{}, invalid("role and name go together and must be nonempty")
		}
		t.role, t.name = *a.Role, *a.Name
		targets++
	}
	if targets > 1 {
		return t, watchCond{}, invalid("a watch takes at most one target: css, refId, or role + name (omit for the page's text)")
	}
	if a.FrameID != nil {
		switch {
		case !nonEmpty(a.FrameID):
			return t, watchCond{}, invalid("frameId must be nonempty")
		case t.refID != "":
			return t, watchCond{}, invalid("a ref names its own frame; frameId goes with css, role + name, or the frame's text")
		}
		t.frameID = *a.FrameID
	}
	var conds []watchCond
	if a.Text != nil {
		conds = append(conds, watchCond{kind: "text", text: derefStr(a.Text)})
	}
	if a.TextGone != nil {
		conds = append(conds, watchCond{kind: "textGone", text: derefStr(a.TextGone)})
	}
	if a.Pattern != nil {
		conds = append(conds, watchCond{kind: "pattern", pattern: derefStr(a.Pattern)})
	}
	if a.State != nil {
		conds = append(conds, watchCond{kind: "state", state: *a.State})
	}
	if a.Change != nil {
		conds = append(conds, watchCond{kind: "change"})
	}
	if a.Count != nil {
		conds = append(conds, watchCond{kind: "count"})
	}
	if len(conds) != 1 {
		return t, watchCond{}, invalid("a watch takes exactly one condition: text, textGone, pattern, state (visible|hidden|enabled|disabled), change: true, or count: true")
	}
	c := conds[0]
	switch c.kind {
	case "text", "textGone":
		if strings.TrimSpace(c.text) == "" {
			return t, c, invalid("%s must be nonempty", c.kind)
		}
	case "pattern":
		if c.pattern == "" || utf8.RuneCountInString(c.pattern) > maxWatchPatternChars {
			return t, c, invalid("pattern must be 1 to %d characters", maxWatchPatternChars)
		}
	case "state":
		switch c.state {
		case "visible", "hidden", "enabled", "disabled":
		default:
			return t, c, invalid("unknown state `%s`, expected one of `visible`, `hidden`, `enabled`, `disabled`", c.state)
		}
		if t.kind() == "page" {
			return t, c, invalid("state needs a target: css, refId, or role + name")
		}
	case "change":
		if !*a.Change {
			return t, c, invalid("change takes true")
		}
	case "count":
		if !*a.Count {
			return t, c, invalid("count takes true")
		}
		if t.css == "" {
			return t, c, invalid("count needs css: it counts the elements the selector matches")
		}
	}
	return t, c, nil
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (f *Facade) startWatch(ctx context.Context, a watchArgs) (map[string]any, error) {
	if a.TargetID == nil {
		return nil, invalid("targetId is required: open or attach a tab first")
	}
	target, cond, err := parseWatchSpec(a)
	if err != nil {
		return nil, err
	}
	duration := defaultWatchDuration
	if a.MaxDurationMs != nil {
		if *a.MaxDurationMs < 1 || *a.MaxDurationMs > maxWatchDurationMs {
			return nil, invalid("maxDurationMs must be between 1 and %d", maxWatchDurationMs)
		}
		duration = time.Duration(*a.MaxDurationMs) * time.Millisecond
	}
	interval := defaultWatchInterval
	if a.IntervalMs != nil {
		if *a.IntervalMs < minWatchIntervalMs || *a.IntervalMs > maxWatchIntervalMs {
			return nil, invalid("intervalMs must be between %d and %d", minWatchIntervalMs, maxWatchIntervalMs)
		}
		interval = time.Duration(*a.IntervalMs) * time.Millisecond
	}
	wait, err := waitDuration(a.WaitMs, 0)
	if err != nil {
		return nil, err
	}
	// A tab opened with observe:false may still show about:blank; the first
	// use of a target waits for its document, as observe and act do.
	s, err := f.settled(ctx, *a.TargetID)
	if err != nil {
		return nil, err
	}
	f.watches.mu.Lock()
	f.watches.sweep()
	active := 0
	for _, w := range f.watches.watches {
		w.mu.Lock()
		if !w.ended() {
			active++
		}
		w.mu.Unlock()
	}
	f.watches.mu.Unlock()
	if active >= maxActiveWatches {
		return nil, invalid("%d watches are active, the most bro runs at once; stop one first (browser.watch list: true)", active)
	}
	// The watch follows the browser across a service worker restart, which
	// reconnects the same instance on a new connection; a watch only reads.
	tabID, browserID := s.TabID, s.Browser.BrowserID
	w := f.newWatch(s.ID, tabID, target, cond, interval, duration, func(ctx context.Context, args map[string]any) (bridge.Result, error) {
		return f.bridge.Dispatch(ctx, "watch_probe", args, &tabID, browserID)
	})
	// The first probe runs in the call, so a target or pattern the page
	// rejects fails the start instead of the first read.
	runCtx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	w.probe(runCtx)
	w.mu.Lock()
	failed := w.trouble == "error" || w.lost
	message := w.troubleError
	if w.lost {
		message = "watch target not found: " + w.lostError
	}
	w.mu.Unlock()
	if failed {
		cancel()
		w.stopPage()
		return nil, ToolFailedError{"watch_probe", message}
	}
	f.watches.mu.Lock()
	f.watches.watches[w.id] = w
	f.watches.mu.Unlock()
	go w.run(runCtx)
	return w.read(ctx, 0, wait), nil
}

func (f *Facade) newWatch(targetID string, tabID int64, target watchTarget, cond watchCond, interval, duration time.Duration, d dispatcher) *watch {
	now := time.Now()
	return &watch{
		id: "w" + ids.Hex(4), targetID: targetID, tabID: tabID, cond: cond, target: target,
		condition: describeWatch(cond, target), interval: interval, started: now,
		deadline: now.Add(duration), dispatch: d, done: make(chan struct{}),
		wake: make(chan struct{}), tab: "live", cancel: func() {},
	}
}

func (f *Facade) listWatches() map[string]any {
	f.watches.mu.Lock()
	defer f.watches.mu.Unlock()
	f.watches.sweep()
	list := []map[string]any{}
	for _, w := range f.watches.watches {
		w.mu.Lock()
		entry := map[string]any{
			"watchId": w.id, "targetId": w.targetID, "condition": w.condition,
			"active": !w.ended(), "cursor": w.seq, "tab": w.tab,
		}
		if w.ended() {
			entry["reason"] = w.reason
		}
		w.mu.Unlock()
		list = append(list, entry)
	}
	sort.Slice(list, func(i, j int) bool { return list[i]["watchId"].(string) < list[j]["watchId"].(string) })
	return map[string]any{"watches": list}
}

// waitText runs the wait step's text conditions on the watch probe: the same
// evaluation, the page latch for changes between polls, and an honest stop on
// a tab that is frozen, closed or gone. It dispatches on the target's own
// connection, as every act step does.
func (f *Facade) waitText(ctx context.Context, s session, cond waitCondition, timeoutMs int64) (met bool, lastError string, err error) {
	c := watchCond{kind: cond.kind, text: cond.text}
	tabID := s.TabID
	w := f.newWatch(s.ID, tabID, watchTarget{}, c, waitPoll, time.Duration(timeoutMs)*time.Millisecond, func(ctx context.Context, args map[string]any) (bridge.Result, error) {
		return f.dispatch(ctx, "watch_probe", args, tabID, s.Browser)
	})
	defer func() {
		w.mu.Lock()
		closed := w.tab == "closed"
		w.mu.Unlock()
		if !closed {
			w.stopPage()
		}
	}()
	for {
		w.probe(ctx)
		if ctx.Err() != nil {
			return false, "", bridge.ErrCancelled
		}
		w.mu.Lock()
		met, reason, tab := w.reason == endMet, w.reason, w.tab
		lastError = w.troubleError
		if lastError == "" && tab == "frozen" {
			lastError = fmt.Sprintf("tab %d is frozen: Chrome runs nothing in it until it unfreezes", tabID)
		}
		if reason == endDisconnected || w.trouble == "disconnected" {
			w.mu.Unlock()
			return false, "", bridge.ErrDisconnected
		}
		w.mu.Unlock()
		switch {
		case met:
			return true, "", nil
		case reason == endTabClosed:
			return false, "", ToolFailedError{"watch_probe", fmt.Sprintf("tab %d closed", tabID)}
		case reason != "":
			return false, lastError, nil
		case tab == "frozen":
			// A frozen page changes nothing until something unfreezes it.
			return false, lastError, nil
		}
		remaining := time.Until(w.deadline)
		if remaining <= 0 {
			return false, lastError, nil
		}
		select {
		case <-ctx.Done():
			return false, "", bridge.ErrCancelled
		case <-time.After(min(waitPoll, remaining)):
		}
	}
}
