package e2e

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"
)

const readablePage = "Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. Readable page sentence. "

// openBlank opens about:blank as tab 42. about:blank has no load to settle,
// so the first use goes straight to the tested call.
func openBlank(t *testing.T, c *Client, ext *Ext) string {
	t.Helper()
	p := c.Start("browser.open", j(`{"url":"about:blank","observe":false}`))
	ext.Reply(ext.NextTool("tabs_create"), "Created tab: 42")
	r := p.Wait()
	if r.IsError {
		t.Fatalf("open failed: %+v", r)
	}
	return r.Str("targetId")
}

func keys(v any) []string {
	obj, _ := v.(map[string]any)
	out := make([]string, 0, len(obj))
	for k := range obj {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestTargetsStayPinnedAndActsFailFast(t *testing.T) {
	s := startServer(t)
	a := s.connectExt(t, "a")
	c := s.client(t)

	p := c.Start("browser.open", j(`{"url":"https://start.test","ownerSessionId":"pi-owner","label":"Task","observe":false}`))
	create := a.NextTool("tabs_create")
	equalJSON(t, create.Args["sessionId"], `"pi-owner"`)
	equalJSON(t, create.Args["deferReadiness"], `true`)
	a.Reply(create, "Created tab: 42")
	opened := p.Wait()
	// Model-facing envelopes carry the target handle, not connection identity.
	equalJSON(t, keys(opened.Structured), `["tabId","targetId","url"]`)
	target := opened.Str("targetId")

	b := s.connectExt(t, "b")
	equalJSON(t, s.status(t)["defaultBrowserId"], `"b"`)

	// Every step parses before any effect, including shared observe options.
	r := c.Call("browser.act", j(`{"targetId":%q,"steps":[{"type":"navigate","url":"https://next.test"},{"type":"observe","mode":"text","refId":"r"}]}`, target))
	if !r.IsError {
		t.Fatalf("invalid observe step was accepted: %+v", r)
	}
	a.Quiet()

	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[
		{"type":"navigate","url":"https://next.test"},
		{"type":"evaluate","code":"''"},
		{"type":"observe","refId":"scope","maxChars":900,"filter":"interactive"},
		{"type":"evaluate","code":"mustNotRun()"}]}`, target))
	// The open's deferred readiness settles first, on the pinned connection.
	ready := a.NextTool("extract_page")
	if tabID(ready) != 42 {
		t.Fatalf("readiness wait went to tab %d", tabID(ready))
	}
	a.ReplyResult(ready, snapshot(readablePage))
	for _, step := range []struct {
		tool, text string
		failed     bool
	}{
		{"navigate", "Navigated to https://next.test", false},
		{"javascript_tool", "", false},
		{"read_page", "stale scope", true},
	} {
		call := a.NextTool(step.tool)
		if tabID(call) != 42 {
			t.Fatalf("%s went to tab %d", step.tool, tabID(call))
		}
		if step.tool == "read_page" {
			equalJSON(t, call.Args["maxChars"], `900`)
			equalJSON(t, call.Args["refId"], `"scope"`)
		}
		if step.failed {
			a.ReplyFailed(call, step.text)
		} else {
			a.Reply(call, step.text)
		}
	}
	r = p.Wait()
	if !r.IsError {
		t.Fatalf("failed act is not an MCP error: %+v", r)
	}
	equalJSON(t, r.Get("status"), `"failed"`)
	equalJSON(t, r.Get("stoppedAt"), `2`)
	equalJSON(t, r.Get("results", 0), `{"type":"navigate","url":"https://next.test"}`)
	// A legitimate empty eval is not a readiness test.
	equalJSON(t, r.Get("results", 1), `{"type":"evaluate","result":""}`)
	equalJSON(t, r.Get("results", 2, "error"), `"stale scope"`)
	raw, _ := json.Marshal(r.Structured)
	for _, key := range []string{"browserId", "cleanup", "tabId", "acknowledgement"} {
		if strings.Contains(string(raw), key) {
			t.Fatalf("%s leaked into act output: %s", key, raw)
		}
	}
	if !strings.HasPrefix(r.Text, "failed at step 3 (observe): stale scope\ntargetId: ") ||
		!strings.HasSuffix(r.Text, "\nnavigated: https://next.test\nevaluated: ") {
		t.Fatalf("rendered act:\n%s", r.Text)
	}
	a.Quiet()
	b.Quiet()

	// Failed close retains ownership for retry; neither close follows the new default.
	for _, failed := range []bool{true, false} {
		p := c.Start("browser.close", j(`{"targetId":%q}`, target))
		call := a.NextTool("tabs_close")
		equalJSON(t, call.Args["tabId"], `42`)
		if failed {
			a.ReplyFailed(call, "close result")
		} else {
			a.Reply(call, "close result")
		}
		equalJSON(t, p.Wait().Get("closed"), fmt.Sprint(!failed))
	}
	b.Quiet()
}

func TestReconnectRejectsTargetActionsAndCleanup(t *testing.T) {
	s := startServer(t)
	old := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, old)
	replacement := s.connectExt(t, "a")

	r := c.Call("browser.act", j(`{"targetId":%q,"steps":[{"type":"evaluate","code":"document.title"}]}`, target))
	equalJSON(t, r.Get("status"), `"failed"`)
	contains(t, r.Str("results", 0, "error"), "disconnected")
	for range 2 {
		r := c.Call("browser.close", j(`{"targetId":%q}`, target))
		equalJSON(t, r.Get("closed"), `false`)
		equalJSON(t, r.Get("status"), `"failed"`)
	}
	replacement.Quiet()
	old.Quiet()
}

func TestActStepsReportChangesOneLinePerStep(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)

	p := c.Start("browser.act", j(`{"targetId":%q,"steps":[
		{"type":"click","refId":"kqx12"},
		{"type":"check","refId":"kqx13"},
		{"type":"check","refId":"kqx14","checked":false},
		{"type":"click","role":"menuitem","name":"Read and write"},
		{"type":"press","key":"Escape"},
		{"type":"observe","refId":"kqx2"}]}`, target))
	// Each element step is one act_element call that acts and reports what
	// visibly changed once the page settled.
	click := ext.NextTool("act_element")
	equalJSON(t, click.Args, `{"refId":"kqx12","action":"click"}`)
	ext.Reply(click, `{"refId":"kqx12","changes":{"settledMs":420,"quiet":true,"opened":["menu \"Access\""],"controls":["kqx20 menuitem \"Read and write\""],"moreControls":"observe kqx19 for 3 more"}}`)
	for _, c := range []struct {
		ref     string
		checked bool
	}{{"kqx13", true}, {"kqx14", false}} {
		check := ext.NextTool("act_element")
		equalJSON(t, check.Args, fmt.Sprintf(`{"refId":%q,"action":"check","checked":%v}`, c.ref, c.checked))
		ext.Reply(check, fmt.Sprintf(`{"refId":%q,"changes":{"settledMs":400,"quiet":true}}`, c.ref))
	}
	named := ext.NextTool("act_element")
	equalJSON(t, named.Args, `{"role":"menuitem","name":"Read and write","action":"click"}`)
	ext.Reply(named, `{"refId":"kqx20","changes":{"settledMs":450,"quiet":true,"closed":["menu \"Access\""],"added":["Access: Read and write"]}}`)
	// An untargeted press goes to the focused element and reports changes.
	press := ext.NextTool("act_element")
	equalJSON(t, press.Args, `{"action":"press","key":"Escape"}`)
	ext.Reply(press, `{"changes":{"settledMs":410,"quiet":true,"closed":["dialog \"Permissions\""]}}`)
	observe := ext.NextTool("read_page")
	// An act observation verifies one action: a small default budget.
	equalJSON(t, observe.Args["maxChars"], `3000`)
	equalJSON(t, observe.Args["refId"], `"kqx2"`)
	ext.Reply(observe, "Frames: 1\n  [kqx13] radio \"16GB\" checked=\"true\"")

	r := p.Wait()
	equalJSON(t, r.Get("status"), `"ok"`)
	if r.Get("stoppedAt") != nil {
		t.Fatalf("stoppedAt on success: %v", r.Structured)
	}
	want := "targetId: " + target + "\n" +
		"clicked kqx12 → opened menu \"Access\"; controls kqx20 menuitem \"Read and write\"; observe kqx19 for 3 more (settled 420ms)\n" +
		"checked kqx13\n" +
		"unchecked kqx14\n" +
		"clicked kqx20 (menuitem \"Read and write\") → closed menu \"Access\"; text \"Access: Read and write\" (settled 450ms)\n" +
		"pressed Escape → closed dialog \"Permissions\" (settled 410ms)\n" +
		"observed:\nFrames: 1\n  [kqx13] radio \"16GB\" checked=\"true\""
	if r.Text != want {
		t.Fatalf("rendered act:\n%s\nwant:\n%s", r.Text, want)
	}

	// Standalone observation defaults to a bounded page budget and forwards cursor.
	p = c.Start("browser.observe", j(`{"targetId":%q,"cursor":40}`, target))
	read := ext.NextTool("read_page")
	equalJSON(t, read.Args["maxChars"], `8000`)
	equalJSON(t, read.Args["cursor"], `40`)
	ext.Reply(read, "Frames: 1; from cursor=40")
	r = p.Wait()
	if r.Text != "Frames: 1; from cursor=40" {
		t.Fatalf("rendered observe: %q", r.Text)
	}
	equalJSON(t, keys(r.Structured), `["content","targetId"]`)
}

func TestActScrollNamesTheElementThatMoved(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)
	for _, tc := range []struct{ reply, line string }{
		{`{"refId":"abc9","scrolled":"document","delta":{"x":0,"y":400},"boundary":false}`, "scrolled document (from abc9) dy=400"},
		{`{"refId":"abc9","scrolled":"abc9","delta":{"x":0,"y":120.4},"boundary":true}`, "scrolled abc9 dy=120; at the end"},
		{`{"refId":"abc9","scrolled":"abc12 <div id=\"feed\">","delta":{"x":0,"y":0},"boundary":true}`, "scrolled abc12 <div id=\"feed\"> (from abc9) without moving; at the end"},
	} {
		p := c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"scroll","refId":"abc9"}]}`, target))
		ext.Reply(ext.Next(), tc.reply)
		if r := p.Wait(); r.Text != "targetId: "+target+"\n"+tc.line {
			t.Fatalf("rendered scroll: %q", r.Text)
		}
	}
}

func TestActObserveFallsBackToThePageWhenItsScopeWasReplaced(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)

	p := c.Start("browser.act", j(`{"targetId":%q,"steps":[
		{"type":"check","refId":"svs286"},
		{"type":"observe","refId":"svs282","filter":"interactive","cursor":40}]}`, target))
	ext.Reply(ext.NextTool("act_element"), `{"refId":"svs286","changes":{"settledMs":400,"quiet":true}}`)
	scoped := ext.NextTool("read_page")
	equalJSON(t, scoped.Args["refId"], `"svs282"`)
	ext.ReplyError(scoped, "Scoped ref svs282 no longer has an accessibility node; read a fresh snapshot")
	// Same budget and filter; the scope and its cursor do not carry over.
	page := ext.NextTool("read_page")
	equalJSON(t, page.Args, `{"filter":"interactive","depth":20,"maxChars":3000,"compact":true}`)
	ext.Reply(page, "Frames: 1\n  [svs300] radio \"32GB\"")
	r := p.Wait()
	equalJSON(t, r.Get("status"), `"ok"`)
	want := "targetId: " + target + "\nchecked svs286\nobserved:\nscope svs282 was replaced; observed page\nFrames: 1\n  [svs300] radio \"32GB\""
	if r.Text != want {
		t.Fatalf("rendered act:\n%s", r.Text)
	}

	// Other observation failures still stop the act.
	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"observe","refId":"svs282"}]}`, target))
	ext.ReplyError(ext.NextTool("read_page"), "Document navigated or frame disappeared during observation; read a fresh snapshot.")
	equalJSON(t, p.Wait().Get("stoppedAt"), `0`)
}

func TestObservationBudgetsAndCeilings(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)

	// Text mode takes a budget and a cursor.
	p := c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"observe","mode":"text","maxChars":2000,"cursor":2000}]}`, target))
	read := ext.NextTool("get_page_text")
	equalJSON(t, read.Args, `{"maxChars":2000,"cursor":2000}`)
	ext.Reply(read, "tail")
	equalJSON(t, p.Wait().Get("results", 0, "content"), `"tail"`)
	// ...but not accessibility options.
	isErrorWith(t, c.Call("browser.act", j(`{"targetId":%q,"steps":[{"type":"observe","mode":"text","filter":"interactive"}]}`, target)),
		"refId/filter/depth/compact require mode a11y")

	// a11y above its cap is reduced to the cap.
	p = c.Start("browser.observe", j(`{"targetId":%q,"maxChars":20000}`, target))
	read = ext.NextTool("read_page")
	equalJSON(t, read.Args["maxChars"], `12000`)
	ext.Reply(read, "Frames: 1")
	p.Wait()

	// Text reads content up to the full ceiling.
	p = c.Start("browser.observe", j(`{"targetId":%q,"mode":"text","maxChars":20000}`, target))
	read = ext.NextTool("get_page_text")
	equalJSON(t, read.Args, `{"maxChars":20000}`)
	ext.Reply(read, readablePage)
	p.Wait()

	// The act observe step gets the same cap.
	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"observe","maxChars":16000}]}`, target))
	read = ext.NextTool("read_page")
	equalJSON(t, read.Args["maxChars"], `12000`)
	ext.Reply(read, "Frames: 1")
	p.Wait()

	// Above the ceiling is rejected before any browser call, in every facade path.
	for _, call := range []struct {
		tool string
		args string
	}{
		{"browser.observe", fmt.Sprintf(`{"targetId":%q,"mode":"text","maxChars":20001}`, target)},
		{"browser.act", fmt.Sprintf(`{"targetId":%q,"steps":[{"type":"observe","maxChars":60000}]}`, target)},
		{"browser.batch.flow", `{"urls":["https://a.invalid"],"steps":[{"type":"observe","maxChars":30000}]}`},
	} {
		isErrorWith(t, c.Call(call.tool, j("%s", call.args)), "maxChars is at most 20000")
	}
	ext.Quiet()
}

func TestActWaitPollsItsConditionAndATimeoutContinues(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)

	// Met on the second poll: returns then, not at the timeout. Text waits
	// run on the watch probe over the page's text.
	started := time.Now()
	p := c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"wait","text":"Results  READY"}]}`, target))
	first := ext.NextTool("watch_probe")
	equalJSON(t, first.Args["target"], `{"kind":"page"}`)
	equalJSON(t, first.Args["condition"], `{"kind":"text","text":"Results  READY"}`)
	ext.Reply(first, `{"tab":"live","url":"about:blank","records":[{"at":1,"met":false}]}`)
	second := ext.NextTool("watch_probe")
	if time.Since(started) < 250*time.Millisecond {
		t.Fatalf("polled again after %v", time.Since(started))
	}
	ext.Reply(second, `{"tab":"live","url":"about:blank","records":[{"at":2,"met":true,"snippet":"Results ready"}]}`)
	stop := ext.NextTool("watch_probe")
	equalJSON(t, stop.Args["op"], `"stop"`)
	ext.Reply(stop, `{"tab":"live"}`)
	r := p.Wait()
	if time.Since(started) > time.Second {
		t.Fatalf("met wait returned after %v", time.Since(started))
	}
	equalJSON(t, r.Get("results", 0, "met"), `true`)
	equalJSON(t, r.Get("results", 0, "condition"), `"text \"Results  READY\" appears"`)
	contains(t, r.Text, "waited ")
	contains(t, r.Text, `ms until text "Results  READY" appears`)

	// A ref that left the document is hidden; a timeout is a result and the
	// following observe still runs.
	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[
		{"type":"wait","refId":"abc7","state":"hidden"},
		{"type":"wait","textGone":"Loading","timeoutMs":300},
		{"type":"observe","mode":"text"}]}`, target))
	info := ext.NextTool("get_element_info")
	equalJSON(t, info.Args, `{"refId":"abc7"}`)
	ext.ReplyError(info, "Stale ref abc7: its node or document disappeared.")
	for {
		call := ext.Next()
		if call.Tool == "get_page_text" {
			ext.Reply(call, readablePage)
			break
		}
		if call.Tool != "watch_probe" {
			t.Fatalf("unexpected %s", call.Tool)
		}
		if call.Args["op"] == "stop" {
			ext.Reply(call, `{"tab":"live"}`)
			continue
		}
		ext.ReplyError(call, "Cannot find context")
	}
	r = p.Wait()
	equalJSON(t, r.Get("status"), `"ok"`)
	equalJSON(t, r.Get("results", 0, "met"), `true`)
	equalJSON(t, r.Get("results", 1, "met"), `false`)
	if ms, _ := r.Get("results", 1, "ms").(float64); ms < 300 {
		t.Fatalf("timed-out wait reported %vms", ms)
	}
	contains(t, r.Text, "ms until abc7 is hidden\nwait not met after ")
	contains(t, r.Text, "ms: text \"Loading\" is gone (last check failed: Cannot find context); continuing\nobserved:")

	// A visible/enabled wait on a gone ref can never hold: it fails.
	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"wait","refId":"abc7","state":"visible"}]}`, target))
	ext.ReplyError(ext.NextTool("get_element_info"), "Stale ref abc7: its node or document disappeared.")
	equalJSON(t, p.Wait().Get("status"), `"failed"`)

	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"wait","refId":"abc7","state":"enabled"}]}`, target))
	ext.Reply(ext.NextTool("get_element_info"), `{"visible":true,"disabled":false}`)
	equalJSON(t, p.Wait().Get("results", 0, "met"), `true`)

	for _, tc := range []struct{ steps, message string }{
		{`[{"type":"wait","ms":500}]`, "act wait takes a condition, not a delay"},
		{`[{"type":"wait"}]`, "wait requires a condition"},
		{`[{"type":"wait","text":"a","textGone":"b"}]`, "exactly one condition"},
		{`[{"type":"wait","refId":"abc7"}]`, "exactly one condition"},
		{`[{"type":"wait","text":"a","timeoutMs":15001}]`, "timeoutMs must be between 1 and 15000"},
		{`[{"type":"wait","text":"a","ms":5}]`, "not both"},
		{`[{"type":"navigate","url":"https://must-not-run.invalid"},{"type":"evaluate","code":""}]`, "code must be nonempty"},
	} {
		isErrorWith(t, c.Call("browser.act", j(`{"targetId":%q,"steps":%s}`, target, tc.steps)), tc.message)
	}
	ext.Quiet()
}

func TestOpenReturnsAtDispatchAndFirstUseSettlesReadiness(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	open := func() Result {
		p := c.Start("browser.open", j(`{"url":"https://test.invalid","observe":false}`))
		ext.Reply(ext.NextTool("tabs_create"), "Created tab: 43")
		return p.Wait()
	}
	opened := open()
	if opened.Get("ready") != nil || opened.Get("reason") != nil {
		t.Fatalf("open waited for readiness: %v", opened.Structured)
	}
	target := opened.Str("targetId")

	// The first use waits once for the page, by extract's readiness rule (the
	// extension polls; live-refs E covers the rule itself), then reads.
	p := c.Start("browser.observe", j(`{"targetId":%q,"mode":"text"}`, target))
	ready := ext.NextTool("extract_page")
	// Its guard is what remains of the 4 s cap.
	if guard, _ := ready.Args["guardMs"].(float64); guard <= 3000 || guard > 4000 {
		t.Fatalf("readiness guard %vms", ready.Args["guardMs"])
	}
	delete(ready.Args, "guardMs")
	equalJSON(t, ready.Args, `{"maxChars":2000,"maxLinks":0,"quietMs":250}`)
	ext.ReplyResult(ready, snapshot("Short."))
	// A short page's text is its content: no second readiness rule.
	read := ext.NextTool("get_page_text")
	ext.Reply(read, "Short.")
	equalJSON(t, p.Wait().Get("content"), `"Short."`)

	// Settled once: the next act goes straight to its step.
	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"evaluate","code":"1"}]}`, target))
	eval := ext.NextTool("javascript_tool")
	equalJSON(t, eval.Args["code"], `"1"`)
	ext.Reply(eval, "1")
	equalJSON(t, p.Wait().Get("status"), `"ok"`)

	// A page that never runs script (still parsing) fails every readiness
	// poll: the wait keeps polling to its 4 s cap, then the step runs anyway.
	slow := open()
	started := time.Now()
	p = c.Start("browser.act", j(`{"targetId":%q,"steps":[{"type":"evaluate","code":"2"}]}`, slow.Str("targetId")))
	for {
		call := ext.Next()
		if call.Tool == "javascript_tool" {
			equalJSON(t, call.Args["code"], `"2"`)
			ext.Reply(call, "2")
			break
		}
		if call.Tool != "extract_page" {
			t.Fatalf("unexpected %s during the readiness wait", call.Tool)
		}
		ext.ReplyError(call, "Cannot find default execution context")
	}
	if waited := time.Since(started); waited < 3500*time.Millisecond || waited > 5*time.Second {
		t.Fatalf("readiness wait ran %v; the cap is 4 s", waited)
	}
	equalJSON(t, p.Wait().Get("status"), `"ok"`)

	// A watch is a first use too: its first probe must not land on the
	// about:blank a just-opened tab still shows.
	fresh := open()
	p = c.Start("browser.watch", j(`{"targetId":%q,"text":"Done"}`, fresh.Str("targetId")))
	ext.ReplyResult(ext.NextTool("extract_page"), snapshot("Short."))
	probe := ext.NextTool("watch_probe")
	ext.Reply(probe, `{"tab":"live","url":"https://test.invalid/","records":[{"at":1,"met":false}]}`)
	watch := p.Wait()
	equalJSON(t, watch.Get("active"), `true`)
	ext.Reply(ext.NextTool("watch_probe"), `{"tab":"live","url":"https://test.invalid/","records":[]}`)
	stopped := c.Start("browser.watch", j(`{"watchId":%q,"stop":true}`, watch.Str("watchId")))
	for {
		call := ext.NextTool("watch_probe")
		ext.Reply(call, `{"tab":"live","url":"https://test.invalid/","records":[]}`)
		if call.Args["op"] == "stop" {
			break
		}
	}
	equalJSON(t, stopped.Wait().Get("reason"), `"stopped"`)
}

func TestCancellationStopsTheNextEffect(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	target := openBlank(t, c, ext)
	p := c.Start("browser.act", j(`{"targetId":%q,"steps":[
		{"type":"evaluate","code":"firstEffect()"},
		{"type":"navigate","url":"https://must-not-run.invalid"}]}`, target))
	first := ext.NextTool("javascript_tool")
	p.Cancel()
	s.waitLog(t, "cancelled")
	ext.Reply(first, "completed already-dispatched effect")
	ext.Quiet()
}

func TestSessionDefaultTarget(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	isErrorWith(t, c.Call("browser.observe", j(`{}`)), "targetId is required")

	target := openBlank(t, c, ext)
	p := c.Start("browser.observe", j(`{"mode":"text"}`))
	ext.Reply(ext.NextTool("get_page_text"), readablePage)
	equalJSON(t, p.Wait().Get("targetId"), fmt.Sprintf("%q", target))

	// The default is per MCP session.
	isErrorWith(t, s.client(t).Call("browser.observe", j(`{}`)), "targetId is required")

	// close:true on the last call closes the target and clears the default.
	p = c.Start("browser.observe", j(`{"mode":"text","close":true}`))
	ext.Reply(ext.NextTool("get_page_text"), readablePage)
	ext.Reply(ext.NextTool("tabs_close"), "closed")
	equalJSON(t, p.Wait().Get("closed"), `true`)
	isErrorWith(t, c.Call("browser.observe", j(`{}`)), "targetId is required")
}
