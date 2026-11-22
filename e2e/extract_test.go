package e2e

import "testing"

func snapshot(text string) map[string]any {
	return map[string]any{
		"title": "A", "url": "https://a.test", "text": text,
		"links": []any{
			map[string]any{"text": "x", "url": "https://a.test/x", "source": "dom"},
			map[string]any{"text": "y", "url": "https://a.test/y", "source": "dom"},
		},
		"readiness": map[string]any{"reason": "dom_quiet"},
	}
}

// Extraction text is checked through structuredContent only: the rendered
// text is free to become compact instead of the current JSON dump.
func TestExtractReadsOnePageInABackgroundTabAndClosesIt(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)

	p := c.Start("browser.extract", j(`{"url":"https://a.test","includeLinks":true,"maxChars":30,"maxLinks":1}`))
	create := ext.NextTool("tabs_create")
	equalJSON(t, create.Args, `{"active":false,"url":"https://a.test"}`)
	ext.Reply(create, "Created tab: 42")
	read := ext.NextTool("extract_page")
	if tabID(read) != 42 {
		t.Fatalf("extract_page tab %d", tabID(read))
	}
	equalJSON(t, read.Args, `{"guardMs":8000,"maxChars":30,"maxLinks":1,"quietMs":250}`)
	ext.ReplyResult(read, snapshot(readablePage))
	closeCall := ext.NextTool("tabs_close")
	equalJSON(t, closeCall.Args, `{"tabId":42}`)
	ext.Reply(closeCall, "closed")

	r := p.Wait()
	if r.IsError {
		t.Fatalf("extract failed: %+v", r)
	}
	equalJSON(t, r.Get("status"), `"ok"`)
	equalJSON(t, r.Get("title"), `"A"`)
	equalJSON(t, r.Get("text"), `"Readable page sentence. Readab"`)
	equalJSON(t, r.Get("links"), `[{"source":"dom","text":"x","url":"https://a.test/x"}]`)
	equalJSON(t, r.Get("diagnostics", "textTruncated"), `true`)
	equalJSON(t, r.Get("diagnostics", "linksTruncated"), `true`)
	ext.Quiet()
}

func TestExtractLimitsHaveDefaultsAndCeilings(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	for _, tc := range []struct {
		tool, args, read string
		short            bool // readablePage is below the requested minChars
	}{
		// Links are opt-in.
		{"browser.extract", `{"url":"https://a.test"}`, `{"guardMs":8000,"maxChars":20000,"maxLinks":0,"quietMs":250}`, false},
		{"browser.extract", `{"url":"https://a.test","includeLinks":true,"minChars":999999,"maxChars":999999,"maxLinks":999999}`,
			`{"guardMs":8000,"maxChars":60000,"maxLinks":200,"minChars":10000,"quietMs":250}`, true},
		{"browser.batch.extract", `{"urls":["https://a.test"]}`, `{"guardMs":8000,"maxChars":8000,"maxLinks":0,"quietMs":250}`, false},
	} {
		p := c.Start(tc.tool, j("%s", tc.args))
		ext.Reply(ext.NextTool("tabs_create"), "Created tab: 42")
		read := ext.NextTool("extract_page")
		equalJSON(t, read.Args, tc.read)
		ext.ReplyResult(read, snapshot(readablePage))
		if tc.short {
			ext.Reply(ext.NextTool("javascript_tool"), `{"title":"A","url":"https://a.test","text":"","links":[]}`)
		}
		ext.Reply(ext.NextTool("tabs_close"), "closed")
		r := p.Wait()
		if tc.tool == "browser.batch.extract" {
			equalJSON(t, r.Get("results", 0, "status"), `"ok"`)
			equalJSON(t, r.Get("results", 0, "links"), `[]`)
		} else if tc.short {
			equalJSON(t, r.Get("status"), `"partial"`)
		} else {
			equalJSON(t, r.Get("status"), `"ok"`)
		}
	}
}

// Without minChars, short text of a page the extension saw settle is its
// content. A caller's minChars is a requirement: the extension waits for it,
// and short text stays partial however settled the page looked.
func TestExtractMinCharsIsARequirementNotAHint(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	const short = "Short settled page."
	for _, tc := range []struct{ args, read, status string }{
		{`{"tabId":9}`, `{"guardMs":8000,"maxChars":20000,"maxLinks":0,"quietMs":250}`, `"ok"`},
		{`{"tabId":9,"minChars":500}`, `{"guardMs":8000,"maxChars":20000,"maxLinks":0,"minChars":500,"quietMs":250}`, `"partial"`},
	} {
		p := c.Start("browser.extract", j("%s", tc.args))
		read := ext.NextTool("extract_page")
		equalJSON(t, read.Args, tc.read)
		ext.ReplyResult(read, snapshot(short))
		if tc.status == `"partial"` {
			ext.Reply(ext.NextTool("javascript_tool"), `{"title":"A","url":"https://a.test","text":"`+short+`","links":[]}`)
		}
		r := p.Wait()
		equalJSON(t, r.Get("status"), tc.status)
		equalJSON(t, r.Get("text"), `"`+short+`"`)
		ext.Quiet()
	}
}

func TestExtractFailureIsAToolErrorWithoutCleanup(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("browser.extract", j(`{"url":"https://a.test"}`))
	ext.ReplyError(ext.NextTool("tabs_create"), "no window")
	r := p.Wait()
	isErrorWith(t, r, "no window")
	equalJSON(t, r.Get("status"), `"failed"`)
	contains(t, r.Str("error"), "tabs_create failed: no window")
	ext.Quiet()
}

func TestExtractWithoutURLReadsAnExistingTabAndLeavesItOpen(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)

	// No url and no tabId: the extension reads its active tab and reports it.
	p := c.Start("browser.extract", j(`{}`))
	read := ext.NextTool("extract_page")
	if tabID(read) != -1 {
		t.Fatalf("extract_page named tab %d; the extension picks the active tab", tabID(read))
	}
	page := snapshot(readablePage)
	page["tabId"] = 7
	ext.ReplyResult(read, page)
	r := p.Wait()
	equalJSON(t, r.Get("id"), `"current"`)
	equalJSON(t, r.Get("status"), `"ok"`)
	equalJSON(t, r.Get("tabId"), `7`)
	equalJSON(t, r.Get("url"), `"https://a.test"`)
	ext.Quiet() // bro did not open the tab, so it does not close it.

	// A given tab is read in place.
	p = c.Start("browser.extract", j(`{"tabId":9,"id":"mine"}`))
	read = ext.NextTool("extract_page")
	if tabID(read) != 9 {
		t.Fatalf("extract_page tab %d", tabID(read))
	}
	ext.ReplyResult(read, snapshot(readablePage))
	r = p.Wait()
	equalJSON(t, r.Get("id"), `"mine"`)
	equalJSON(t, r.Get("tabId"), `9`)
	ext.Quiet()

	isErrorWith(t, c.Call("browser.extract", j(`{"url":"https://a.test","tabId":9}`)), "url or tabId, not both")
}
