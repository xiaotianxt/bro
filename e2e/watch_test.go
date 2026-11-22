package e2e

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// probeStep is the fake extension's answer to one watch_probe.
type probeStep struct {
	reply map[string]any
	delay time.Duration
}

func rec(met bool, snippet string) map[string]any {
	r := map[string]any{"at": 0, "met": met}
	if snippet != "" {
		r["snippet"] = snippet
	}
	return r
}

func live(url string, records ...map[string]any) map[string]any {
	return map[string]any{"tab": "live", "url": url, "records": records}
}

// prober answers watch_probe calls from a script, repeating its last step,
// and records the probe arguments. A stop probe always succeeds.
type prober struct {
	mu    sync.Mutex
	args  []map[string]any
	stops int
	quit  chan struct{}
}

func probeWith(t *testing.T, ext *Ext, steps []probeStep) *prober {
	p := &prober{quit: make(chan struct{})}
	t.Cleanup(func() { close(p.quit) })
	go func() {
		i := 0
		for {
			var call ToolCall
			select {
			case call = <-ext.calls:
			case <-p.quit:
				return
			}
			if call.Tool != "watch_probe" {
				_ = ext.send(map[string]any{"type": "tool_error", "requestId": call.RequestID, "error": map[string]any{"message": "unexpected " + call.Tool}})
				continue
			}
			p.mu.Lock()
			if call.Args["op"] == "stop" {
				p.stops++
				p.mu.Unlock()
				_ = replyJSON(ext, call, map[string]any{"tab": "live"})
				continue
			}
			p.args = append(p.args, call.Args)
			p.mu.Unlock()
			step := steps[min(i, len(steps)-1)]
			i++
			if step.delay > 0 {
				select {
				case <-time.After(step.delay):
				case <-p.quit:
					return
				}
			}
			_ = replyJSON(ext, call, step.reply)
		}
	}()
	return p
}

func (p *prober) probeArgs() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.args...)
}

func replyJSON(ext *Ext, call ToolCall, v any) error {
	data, _ := json.Marshal(v)
	return ext.send(map[string]any{"type": "tool_result", "requestId": call.RequestID,
		"result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(data)}}}})
}

// eventKey names an event for comparison: its type, and its state for tab
// and target events.
func eventKey(e map[string]any) string {
	if s, _ := e["state"].(string); s != "" {
		return e["type"].(string) + ":" + s
	}
	return e["type"].(string)
}

// watchShape is one way a watched change arrives (or never does).
type watchShape struct {
	name  string
	start string // start fields besides targetId and intervalMs
	steps []probeStep
	// Event keys in order, ending with "end"; reason is the end reason.
	events []string
	reason string
	// The wait step's outcome on the page-text form of the shape; "" skips it.
	wait string // "met", "notMet", "failed"
	// A substring of the wait's lastError when not met.
	waitError string
	// The target of the first and last probes, when the shape resolves one.
	firstTarget, lastTarget string
}

var watchShapes = []watchShape{
	{
		name:  "late change from a slow fetch",
		start: `"text":"Done"`,
		steps: []probeStep{
			{reply: live("https://a.test", rec(false, ""))},
			{reply: live("https://a.test", rec(false, ""))},
			{reply: live("https://a.test", rec(false, ""))},
			{reply: live("https://a.test", rec(true, "Status: Done"))},
		},
		events: []string{"met", "end"}, reason: "met", wait: "met",
	},
	{
		// The ref's node is replaced: the page re-pins the element with the
		// same role and name, and the next probes carry role+name.
		name:  "target node replaced by a re-render",
		start: `"refId":"r7","text":"Done"`,
		steps: []probeStep{
			{reply: map[string]any{"tab": "live", "url": "https://a.test", "records": []any{rec(false, "")}, "resolved": map[string]any{"role": "status", "name": "Job 1"}}},
			{reply: map[string]any{"tab": "live", "url": "https://a.test", "records": []any{}, "targetLost": true, "resolveError": "No visible status named \"Job 1\""}},
			{reply: map[string]any{"tab": "live", "url": "https://a.test", "records": []any{rec(true, "Job 1 Done")}, "resolved": map[string]any{"role": "status", "name": "Job 1"}}},
		},
		events: []string{"target:lost", "target:found", "met", "end"}, reason: "met",
		firstTarget: `{"kind":"node","refId":"r7"}`,
		lastTarget:  `{"kind":"node","role":"status","name":"Job 1"}`,
	},
	{
		// A support chat in a cross-site iframe: the first probe locates the
		// frame, and later probes carry its scripting id.
		name:  "target in a cross-site iframe",
		start: `"frameId":"CHAT1","text":"Done"`,
		steps: []probeStep{
			{reply: map[string]any{"tab": "live", "url": "https://chat.test/", "records": []any{rec(false, "")}, "frame": map[string]any{"frameId": "CHAT1", "scriptFrame": 7}}},
			{reply: live("https://chat.test/", rec(false, ""))},
			{reply: live("https://chat.test/", rec(true, "Agent: Done"))},
		},
		events: []string{"met", "end"}, reason: "met",
		firstTarget: `{"kind":"page","frameId":"CHAT1"}`,
		lastTarget:  `{"kind":"page","frameId":"CHAT1","scriptFrame":7}`,
	},
	{
		name:  "page navigates, then the content appears",
		start: `"text":"Done"`,
		steps: []probeStep{
			{reply: live("https://a.test/form", rec(false, ""))},
			{reply: map[string]any{"tab": "live", "url": "https://a.test/result", "installed": true, "records": []any{rec(false, "")}}},
			{reply: live("https://a.test/result", rec(true, "Done"))},
		},
		events: []string{"navigated", "met", "end"}, reason: "met", wait: "met",
	},
	{
		// A throttled background tab answers slowly, and the text came and
		// went between two probes: only the page's latch saw it.
		name:  "background tab, throttled, change between probes",
		start: `"text":"Done"`,
		steps: []probeStep{
			{reply: live("https://a.test", rec(false, ""))},
			{reply: live("https://a.test", rec(true, "Saved: Done"), rec(false, "")), delay: 1500 * time.Millisecond},
			{reply: live("https://a.test", rec(false, ""))},
		},
		events: []string{"met", "end"}, reason: "met", wait: "met",
	},
	{
		name:  "tab frozen, then live again",
		start: `"text":"Done"`,
		steps: []probeStep{
			{reply: live("https://a.test", rec(false, ""))},
			{reply: map[string]any{"tab": "frozen"}},
			{reply: map[string]any{"tab": "frozen"}},
			{reply: live("https://a.test", rec(true, "Done"))},
		},
		events: []string{"tab:frozen", "tab:live", "met", "end"}, reason: "met",
		wait: "notMet", waitError: "is frozen",
	},
	{
		name:  "tab closes mid-watch",
		start: `"text":"Done"`,
		steps: []probeStep{
			{reply: live("https://a.test", rec(false, ""))},
			{reply: map[string]any{"tab": "closed"}},
		},
		events: []string{"end"}, reason: "tabClosed", wait: "failed",
	},
	{
		name:   "watch times out",
		start:  `"text":"Done","maxDurationMs":900`,
		steps:  []probeStep{{reply: live("https://a.test", rec(false, ""))}},
		events: []string{"end"}, reason: "timeout", wait: "notMet",
	},
}

// TestWatchContractMatrix runs every shape through every entry point: the
// MCP long-poll read, the CLI stream, and the act wait step, which shares
// the probe for text conditions.
func TestWatchContractMatrix(t *testing.T) {
	for _, shape := range watchShapes {
		t.Run(shape.name+"/mcp read", func(t *testing.T) {
			t.Parallel()
			s := startServer(t)
			ext := s.connectExt(t, "a")
			c := s.client(t)
			target := openBlank(t, c, ext)
			p := probeWith(t, ext, shape.steps)
			start := c.Call("browser.watch", j(`{"targetId":%q,"intervalMs":250,%s}`, target, shape.start))
			if start.IsError {
				t.Fatalf("start failed: %s", start.Text)
			}
			id := start.Str("watchId")
			events := eventsOf(start.Structured)
			cursor := start.Get("cursor")
			result := start
			for result.Get("active") == true {
				result = c.Call("browser.watch", j(`{"watchId":%q,"cursor":%v,"waitMs":10000}`, id, cursor))
				if result.IsError {
					t.Fatalf("read failed: %s", result.Text)
				}
				got := eventsOf(result.Structured)
				if len(got) == 0 && result.Get("active") == true {
					t.Fatalf("a read returned no event before its waitMs: %v", result.Structured)
				}
				events = append(events, got...)
				cursor = result.Get("cursor")
			}
			checkEvents(t, events, shape.events)
			equalJSON(t, result.Get("reason"), fmt.Sprintf("%q", shape.reason))
			checkTargets(t, p, shape)
		})
		t.Run(shape.name+"/cli stream", func(t *testing.T) {
			t.Parallel()
			s := startServer(t)
			ext := s.connectExt(t, "a")
			c := s.client(t)
			target := openBlank(t, c, ext)
			p := probeWith(t, ext, shape.steps)
			lines, code := s.runWatchCLI(t, fmt.Sprintf(`{"targetId":%q,"intervalMs":250,%s}`, target, shape.start))
			checkEvents(t, lines, shape.events)
			last := lines[len(lines)-1]
			equalJSON(t, last["reason"], fmt.Sprintf("%q", shape.reason))
			if last["watchId"] == "" {
				t.Fatalf("CLI line carries no watchId: %v", last)
			}
			want := 1
			if shape.reason == "met" {
				want = 0
			}
			if code != want {
				t.Fatalf("exit code %d, want %d", code, want)
			}
			checkTargets(t, p, shape)
		})
		if shape.wait == "" {
			continue
		}
		t.Run(shape.name+"/wait step", func(t *testing.T) {
			t.Parallel()
			s := startServer(t)
			ext := s.connectExt(t, "a")
			c := s.client(t)
			target := openBlank(t, c, ext)
			p := probeWith(t, ext, shape.steps)
			started := time.Now()
			r := c.Call("browser.act", j(`{"targetId":%q,"steps":[{"type":"wait","text":"Done","timeoutMs":3000}]}`, target))
			switch shape.wait {
			case "met":
				equalJSON(t, r.Get("results", 0, "met"), `true`)
			case "notMet":
				equalJSON(t, r.Get("status"), `"ok"`)
				equalJSON(t, r.Get("results", 0, "met"), `false`)
				if shape.waitError != "" {
					contains(t, r.Text, shape.waitError)
					// A frozen tab is reported at once, not after the timeout.
					if time.Since(started) > 2*time.Second {
						t.Fatalf("frozen wait returned after %v", time.Since(started))
					}
				}
			case "failed":
				equalJSON(t, r.Get("status"), `"failed"`)
				contains(t, r.Text, "closed")
			}
			// The wait checks the page's text, case-insensitively, on the probe.
			args := p.probeArgs()
			if len(args) == 0 {
				t.Fatalf("the wait never probed the page")
			}
			equalJSON(t, args[0]["target"], `{"kind":"page"}`)
			equalJSON(t, args[0]["condition"], `{"kind":"text","text":"Done"}`)
		})
	}
}

func checkTargets(t *testing.T, p *prober, shape watchShape) {
	t.Helper()
	if shape.firstTarget == "" {
		return
	}
	args := p.probeArgs()
	equalJSON(t, args[0]["target"], shape.firstTarget)
	equalJSON(t, args[len(args)-1]["target"], shape.lastTarget)
}

func eventsOf(v map[string]any) []map[string]any {
	raw, _ := v["events"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, e := range raw {
		out = append(out, e.(map[string]any))
	}
	return out
}

func checkEvents(t *testing.T, events []map[string]any, want []string) {
	t.Helper()
	got := make([]string, 0, len(events))
	for i, e := range events {
		got = append(got, eventKey(e))
		if seq, _ := e["seq"].(float64); int(seq) != i+1 {
			t.Fatalf("event %d has seq %v: %v", i, e["seq"], events)
		}
	}
	equalJSON(t, got, mustJSON(want))
}

func mustJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

// runWatchCLI runs `bro watch` against s and returns its JSON lines and exit
// code; it fails the test when the command prints no line.
func (s *Server) runWatchCLI(t *testing.T, args ...string) ([]map[string]any, int) {
	t.Helper()
	lines, code, stderr := s.runCLI(t, args...)
	if len(lines) == 0 {
		t.Fatalf("bro watch printed nothing (exit %d): %s", code, stderr)
	}
	return lines, code
}

func (s *Server) runCLI(t *testing.T, args ...string) ([]map[string]any, int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, broBin, append(append([]string{"watch"}, args...), "--port", fmt.Sprint(s.Port))...)
	cmd.Env = append(os.Environ(), "HOME="+s.Home, "NO_COLOR=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code = exit.ExitCode()
	} else if err != nil {
		t.Fatalf("bro watch: %v\n%s", err, stderr.String())
	}
	var lines []map[string]any
	sc := bufio.NewScanner(&stdout)
	for sc.Scan() {
		var line map[string]any
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			t.Fatalf("bro watch printed a non-JSON line %q", sc.Text())
		}
		lines = append(lines, line)
	}
	if strings.Contains(stdout.String()+stderr.String(), testToken) {
		t.Fatalf("bro watch printed the token")
	}
	return lines, code, stderr.String()
}

// Streams, buffers and the lifecycle around one watch.
func TestWatchLifecycle(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)
	count := func(n int, items ...string) map[string]any {
		return map[string]any{"at": 0, "count": n, "items": items}
	}
	p := probeWith(t, ext, []probeStep{
		{reply: live("https://chat.test", count(1, "hi"))},
		{reply: live("https://chat.test", count(2, "hi", "new message"))},
		{reply: live("https://chat.test", count(2, "hi", "new message"))},
	})

	// A streaming condition reports a baseline, then each change; a target
	// defaults to the session's last one.
	start := c.Call("browser.watch", j(`{"css":"li.msg","count":true,"intervalMs":250,"waitMs":5000}`))
	if start.IsError {
		t.Fatalf("start failed: %s", start.Text)
	}
	equalJSON(t, start.Get("targetId"), fmt.Sprintf("%q", target))
	equalJSON(t, start.Get("condition"), `"match count changes in li.msg"`)
	equalJSON(t, start.Get("events", 0, "type"), `"initial"`)
	equalJSON(t, start.Get("events", 0, "count"), `1`)
	equalJSON(t, start.Get("tab", "state"), `"live"`)
	id := start.Str("watchId")
	r := c.Call("browser.watch", j(`{"watchId":%q,"cursor":1,"waitMs":5000}`, id))
	equalJSON(t, r.Get("events", 0, "type"), `"count"`)
	equalJSON(t, r.Get("events", 0, "count"), `2`)
	equalJSON(t, r.Get("events", 0, "previous"), `"1"`)
	equalJSON(t, r.Get("events", 0, "added"), `["new message"]`)
	if ms, ok := r.Get("tab", "probedMsAgo").(float64); !ok || ms > 2000 {
		t.Fatalf("read does not show a recent probe: %v", r.Get("tab"))
	}

	// No change: the read waits out waitMs and still reports liveness.
	began := time.Now()
	r = c.Call("browser.watch", j(`{"watchId":%q,"cursor":2,"waitMs":600}`, id))
	if waited := time.Since(began); waited < 600*time.Millisecond {
		t.Fatalf("read returned after %v with no event", waited)
	}
	equalJSON(t, r.Get("events"), `[]`)
	equalJSON(t, r.Get("active"), `true`)

	equalJSON(t, c.Call("browser.watch", j(`{"list":true}`)).Get("watches", 0, "watchId"), fmt.Sprintf("%q", id))

	// Stop ends it with a reason and removes the page latch.
	r = c.Call("browser.watch", j(`{"watchId":%q,"cursor":2,"stop":true}`, id))
	equalJSON(t, r.Get("active"), `false`)
	equalJSON(t, r.Get("reason"), `"stopped"`)
	equalJSON(t, r.Get("events", 0, "type"), `"end"`)
	p.mu.Lock()
	stops := p.stops
	p.mu.Unlock()
	if stops != 1 {
		t.Fatalf("stop sent %d page cleanups", stops)
	}

	// A watch the server no longer has (bro restarted) is a tool error, and
	// the CLI turns it into a final end line.
	isErrorWith(t, c.Call("browser.watch", j(`{"watchId":"wdeadbeef"}`)), "unknown watchId wdeadbeef: bro restarted")
	lines, code := s.runWatchCLI(t, "--id", "wdeadbeef")
	equalJSON(t, lines[len(lines)-1]["reason"], `"gone"`)
	if code != 1 {
		t.Fatalf("exit code %d", code)
	}

	for _, tc := range []struct{ args, message string }{
		{`{"text":"a","textGone":"b"}`, "exactly one condition"},
		{`{}`, "exactly one condition"},
		{`{"css":"a","refId":"r1","text":"x"}`, "at most one target"},
		{`{"role":"button","text":"x"}`, "role and name go together"},
		{`{"state":"visible"}`, "state needs a target"},
		{`{"text":"x","state":"shown","css":"a"}`, "exactly one condition"},
		{`{"css":"a","state":"shown"}`, "unknown state `shown`"},
		{`{"count":true}`, "count needs css"},
		{`{"text":"x","intervalMs":10}`, "intervalMs must be between 250"},
		{`{"text":"x","maxDurationMs":86400001}`, "maxDurationMs must be between 1"},
		{`{"text":"x","waitMs":50001}`, "waitMs must be between 0 and 50000"},
		{`{"watchId":"w1","text":"x"}`, "not start fields"},
		{`{"cursor":3}`, "need a watchId"},
		{`{"list":true,"watchId":"w1"}`, "list takes only list"},
		{`{"refId":"r1","frameId":"F","text":"x"}`, "a ref names its own frame"},
		{`{"frameId":" ","text":"x"}`, "frameId must be nonempty"},
	} {
		isErrorWith(t, c.Call("browser.watch", json.RawMessage(tc.args)), tc.message)
	}
}

// A start whose first probe fails (a selector the page rejects) is a tool
// error and leaves no watch behind.
func TestWatchStartFailsOnAPageError(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)
	p := c.Start("browser.watch", j(`{"targetId":%q,"css":"a[","text":"x"}`, target))
	ext.ReplyError(ext.NextTool("watch_probe"), "Error: Failed to execute 'querySelectorAll' on 'Document': 'a[' is not a valid selector.")
	stop := ext.NextTool("watch_probe")
	equalJSON(t, stop.Args["op"], `"stop"`)
	ext.Reply(stop, `{"tab":"live"}`)
	isErrorWith(t, p.Wait(), "is not a valid selector")
	equalJSON(t, c.Call("browser.watch", j(`{"list":true}`)).Get("watches"), `[]`)
}

// A service worker restart reconnects the same browser on a new connection:
// the watch reports the gap and resumes on the new one.
func TestWatchFollowsAReconnectedBrowser(t *testing.T) {
	s := startServer(t)
	a := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, a)
	probeWith(t, a, []probeStep{{reply: live("https://a.test", rec(false, ""))}})
	start := c.Call("browser.watch", j(`{"targetId":%q,"text":"Done","intervalMs":250}`, target))
	id := start.Str("watchId")
	a.Close()
	r := c.Call("browser.watch", j(`{"watchId":%q,"waitMs":5000}`, id))
	equalJSON(t, r.Get("events", 0, "type"), `"tab"`)
	equalJSON(t, r.Get("events", 0, "state"), `"disconnected"`)
	equalJSON(t, r.Get("active"), `true`)

	b := s.connectExt(t, "a")
	probeWith(t, b, []probeStep{{reply: live("https://a.test", rec(true, "Done"))}})
	r = c.Call("browser.watch", j(`{"watchId":%q,"cursor":1,"waitMs":5000}`, id))
	checkEvents(t, append([]map[string]any{{"type": "tab", "state": "disconnected", "seq": 1.0}}, eventsOf(r.Structured)...), []string{"tab:disconnected", "tab:live", "met", "end"})
}

// --once exits after the first change and leaves the watch running; --cursor
// resumes after the last event seen, so a change between two runs is printed
// by the next one and nothing twice. This is the loop for a harness that wakes
// its agent only when a background command exits.
func TestWatchCLIOnceResumesFromItsCursor(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)
	count := func(n int, items ...string) map[string]any {
		return map[string]any{"at": 0, "count": n, "items": items}
	}
	gate := make(chan struct{})
	p := &prober{quit: make(chan struct{})}
	t.Cleanup(func() { close(p.quit) })
	// Two messages arrive, the second only once the test opens the gate.
	go func() {
		i := 0
		for {
			var call ToolCall
			select {
			case call = <-ext.calls:
			case <-p.quit:
				return
			}
			reply := live("https://chat.test", count(1, "hi"))
			switch {
			case call.Args["op"] == "stop":
				reply = map[string]any{"tab": "live"}
			case i == 0:
			case i < 3:
				reply = live("https://chat.test", count(2, "hi", "first reply"))
			default:
				select {
				case <-gate:
					reply = live("https://chat.test", count(3, "hi", "first reply", "second reply"))
				default:
					reply = live("https://chat.test", count(2, "hi", "first reply"))
				}
			}
			if call.Args["op"] != "stop" {
				i++
			}
			_ = replyJSON(ext, call, reply)
		}
	}()

	lines, code := s.runWatchCLI(t, fmt.Sprintf(`{"targetId":%q,"css":"li","count":true,"intervalMs":250}`, target), "--once")
	if code != 3 {
		t.Fatalf("exit code %d, want 3", code)
	}
	checkEvents(t, lines, []string{"initial", "count"})
	equalJSON(t, lines[1]["added"], `["first reply"]`)
	id, _ := lines[1]["watchId"].(string)
	equalJSON(t, c.Call("browser.watch", j(`{"watchId":%q,"waitMs":0}`, id)).Get("active"), `true`)

	// The second message arrives while no CLI runs.
	close(gate)
	r := c.Call("browser.watch", j(`{"watchId":%q,"cursor":2,"waitMs":5000}`, id))
	equalJSON(t, r.Get("events", 0, "type"), `"count"`)

	lines, code = s.runWatchCLI(t, "--id", id, "--cursor", "2", "--once")
	if code != 3 {
		t.Fatalf("exit code %d, want 3", code)
	}
	if len(lines) != 1 || lines[0]["seq"] != 3.0 {
		t.Fatalf("resume printed %v, want only event 3", lines)
	}
	equalJSON(t, lines[0]["added"], `["second reply"]`)

	_, code, stderr := s.runCLI(t, "--cursor", "2", "{}")
	if code != 2 || !strings.Contains(stderr, "--cursor resumes a watch and needs --id") {
		t.Fatalf("--cursor without --id exited %d", code)
	}
}

// pushStep is one watch_event the fake extension sends. tabID and watchID
// override the watch's own, for a push the server must ignore.
type pushStep struct {
	result  map[string]any
	tabID   int64
	watchID string
}

// A pushed change arrives between heartbeats: every shape runs with a 60 s
// heartbeat whose probes never see the change, so only the push can end it
// within the second the test allows.
var pushShapes = []struct {
	name   string
	start  string
	steps  []probeStep
	pushes []pushStep
	events []string
	reason string
	// The met event's value, when the shape is met.
	met string
	// The wait step's outcome on the page-text form; "" skips it.
	wait string
}{
	{
		name:   "change pushed between heartbeats",
		start:  `"text":"Done"`,
		steps:  []probeStep{{reply: live("https://a.test", rec(false, ""))}},
		pushes: []pushStep{{result: live("https://a.test", rec(true, "Status Done"))}},
		events: []string{"met", "end"}, reason: "met", met: "Status Done", wait: "met",
	},
	{
		// The worker reinstalls the latch in the new document and sends its
		// first value, with the new URL.
		name:  "navigation pushed by the reinstalled latch",
		start: `"text":"Done"`,
		steps: []probeStep{{reply: live("https://a.test/form", rec(false, ""))}},
		pushes: []pushStep{
			{result: map[string]any{"tab": "live", "url": "https://a.test/result", "installed": true, "records": []any{rec(false, "")}}},
			{result: live("https://a.test/result", rec(true, "Done"))},
		},
		events: []string{"navigated", "met", "end"}, reason: "met", met: "Done", wait: "met",
	},
	{
		name:   "tab close pushed",
		start:  `"text":"Done"`,
		steps:  []probeStep{{reply: live("https://a.test", rec(false, ""))}},
		pushes: []pushStep{{result: map[string]any{"tab": "closed"}}},
		events: []string{"end"}, reason: "tabClosed", wait: "failed",
	},
	{
		// The page can say its node is gone but not find the new one: the
		// push makes the server probe at once, and that probe re-pins.
		name:  "node replaced, pushed as lost, re-pinned by the next probe",
		start: `"refId":"r7","text":"Done"`,
		steps: []probeStep{
			{reply: map[string]any{"tab": "live", "url": "https://a.test", "records": []any{rec(false, "")}, "resolved": map[string]any{"role": "status", "name": "Job 1"}}},
			{reply: map[string]any{"tab": "live", "url": "https://a.test", "records": []any{rec(true, "Job 1 Done")}, "resolved": map[string]any{"role": "status", "name": "Job 1"}}},
		},
		pushes: []pushStep{{result: map[string]any{"tab": "live", "url": "https://a.test", "records": []any{}, "targetLost": true}}},
		events: []string{"target:lost", "target:found", "met", "end"}, reason: "met", met: "Job 1 Done",
	},
	{
		name:  "pushes from another tab or for another watch are ignored",
		start: `"text":"Done"`,
		steps: []probeStep{{reply: live("https://a.test", rec(false, ""))}},
		pushes: []pushStep{
			{result: live("https://a.test", rec(true, "other tab Done")), tabID: 7},
			{result: live("https://a.test", rec(true, "other watch Done")), watchID: "w00000000"},
			{result: live("https://a.test", rec(true, "Status Done"))},
		},
		events: []string{"met", "end"}, reason: "met", met: "Status Done", wait: "met",
	},
}

// pushAll sends a shape's pushes once the watch has probed, and returns when
// the last one was sent.
func pushAll(t *testing.T, ext *Ext, p *prober, pushes []pushStep) time.Time {
	t.Helper()
	var watchID string
	deadline := time.Now().Add(5 * time.Second)
	for watchID == "" {
		if args := p.probeArgs(); len(args) > 0 {
			watchID, _ = args[0]["watchId"].(string)
		} else if time.Now().After(deadline) {
			t.Fatalf("the watch never probed: %v", p.probeArgs())
		} else {
			time.Sleep(10 * time.Millisecond)
		}
	}
	for _, push := range pushes {
		id, tab := watchID, int64(42)
		if push.watchID != "" {
			id = push.watchID
		}
		if push.tabID != 0 {
			tab = push.tabID
		}
		if err := ext.send(map[string]any{"type": "watch_event", "watchId": id, "tabId": tab, "result": push.result}); err != nil {
			t.Fatalf("push: %v", err)
		}
	}
	return time.Now()
}

func TestWatchPushContract(t *testing.T) {
	const within = time.Second
	for _, shape := range pushShapes {
		check := func(t *testing.T, events []map[string]any, reason any, pushed time.Time) {
			t.Helper()
			if took := time.Since(pushed); took > within {
				t.Fatalf("the pushed change took %v, want under %v", took, within)
			}
			checkEvents(t, events, shape.events)
			equalJSON(t, reason, fmt.Sprintf("%q", shape.reason))
			if shape.met == "" {
				return
			}
			for _, e := range events {
				if e["type"] == "met" && e["value"] != shape.met {
					t.Fatalf("met value %q, want %q", e["value"], shape.met)
				}
			}
		}
		t.Run(shape.name+"/mcp read", func(t *testing.T) {
			t.Parallel()
			s := startServer(t)
			ext := s.connectExt(t, "a")
			c := s.client(t)
			target := openBlank(t, c, ext)
			p := probeWith(t, ext, shape.steps)
			start := c.Call("browser.watch", j(`{"targetId":%q,"intervalMs":60000,%s}`, target, shape.start))
			if start.IsError {
				t.Fatalf("start failed: %s", start.Text)
			}
			pushed := pushAll(t, ext, p, shape.pushes)
			events := eventsOf(start.Structured)
			result := start
			for result.Get("active") == true {
				result = c.Call("browser.watch", j(`{"watchId":%q,"cursor":%v,"waitMs":10000}`, start.Str("watchId"), result.Get("cursor")))
				events = append(events, eventsOf(result.Structured)...)
			}
			check(t, events, result.Get("reason"), pushed)
		})
		t.Run(shape.name+"/cli stream", func(t *testing.T) {
			t.Parallel()
			s := startServer(t)
			ext := s.connectExt(t, "a")
			c := s.client(t)
			target := openBlank(t, c, ext)
			p := probeWith(t, ext, shape.steps)
			done := make(chan []map[string]any)
			go func() {
				lines, _ := s.runWatchCLI(t, fmt.Sprintf(`{"targetId":%q,"intervalMs":60000,%s}`, target, shape.start))
				done <- lines
			}()
			pushed := pushAll(t, ext, p, shape.pushes)
			lines := <-done
			check(t, lines, lines[len(lines)-1]["reason"], pushed)
		})
		if shape.wait == "" {
			continue
		}
		t.Run(shape.name+"/wait step", func(t *testing.T) {
			t.Parallel()
			s := startServer(t)
			ext := s.connectExt(t, "a")
			c := s.client(t)
			target := openBlank(t, c, ext)
			p := probeWith(t, ext, shape.steps)
			call := c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"wait","text":"Done","timeoutMs":10000}]}`, target))
			pushed := pushAll(t, ext, p, shape.pushes)
			r := call.Wait()
			if took := time.Since(pushed); took > within {
				t.Fatalf("the pushed change took %v, want under %v", took, within)
			}
			switch shape.wait {
			case "met":
				equalJSON(t, r.Get("results", 0, "met"), `true`)
			case "failed":
				equalJSON(t, r.Get("status"), `"failed"`)
				contains(t, r.Text, "closed")
			}
		})
	}
}
