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
	equalJSON(t, read.Args, `{"guardMs":8000,"maxChars":30,"maxLinks":1,"minChars":120,"quietMs":250}`)
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
	for _, tc := range []struct{ tool, args, read string }{
		// Links are opt-in.
		{"browser.extract", `{"url":"https://a.test"}`, `{"guardMs":8000,"maxChars":20000,"maxLinks":0,"minChars":120,"quietMs":250}`},
		{"browser.extract", `{"url":"https://a.test","includeLinks":true,"minChars":999999,"maxChars":999999,"maxLinks":999999}`,
			`{"guardMs":8000,"maxChars":60000,"maxLinks":200,"minChars":10000,"quietMs":250}`},
		{"browser.batch.extract", `{"urls":["https://a.test"]}`, `{"guardMs":8000,"maxChars":8000,"maxLinks":0,"minChars":120,"quietMs":250}`},
	} {
		p := c.Start(tc.tool, j("%s", tc.args))
		ext.Reply(ext.NextTool("tabs_create"), "Created tab: 42")
		read := ext.NextTool("extract_page")
		equalJSON(t, read.Args, tc.read)
		ext.ReplyResult(read, snapshot(readablePage))
		ext.Reply(ext.NextTool("tabs_close"), "closed")
		r := p.Wait()
		if tc.tool == "browser.batch.extract" {
			equalJSON(t, r.Get("results", 0, "status"), `"ok"`)
			equalJSON(t, r.Get("results", 0, "links"), `[]`)
		} else {
			equalJSON(t, r.Get("status"), `"ok"`)
		}
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
