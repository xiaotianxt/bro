package facade

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/xiaotianxt/bro/internal/bridge"
)

type batchInput struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

func parseBatchInputs(urls *[]string, inputs *[]batchInput, tool string) ([]batchInput, error) {
	var out []batchInput
	switch {
	case urls != nil && inputs != nil:
		return nil, invalid("provide either urls or inputs, not both")
	case urls != nil:
		for i, u := range *urls {
			out = append(out, batchInput{ID: fmt.Sprintf("url-%d", i+1), URL: u})
		}
	case inputs != nil:
		for i, in := range *inputs {
			if in.ID == "" {
				in.ID = fmt.Sprintf("input-%d", i+1)
			}
			out = append(out, in)
		}
	default:
		return nil, invalid("%s requires urls or inputs", tool)
	}
	if len(out) == 0 {
		return nil, invalid("%s requires at least one URL", tool)
	}
	for _, in := range out {
		if in.URL == "" {
			return nil, invalid("input %s has an empty url", in.ID)
		}
	}
	return out, nil
}

func clamp[T int | int64](v *T, def, lo, hi T) T {
	x := def
	if v != nil {
		x = *v
	}
	return max(lo, min(x, hi))
}

func boolOr(v *bool, def bool) bool {
	if v == nil {
		return def
	}
	return *v
}

// runAll runs fn over n items with bounded concurrency, keeping input order.
func runAll[R any](n, concurrency int, fn func(i int) R) []R {
	results := make([]R, n)
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = fn(i)
		}()
	}
	wg.Wait()
	return results
}

// withDeadline runs fn under its own timeout. On expiry the caller gets
// timedOut while fn winds down: its dispatches see the context end and any
// owned tab's cleanup continues in the background.
func withDeadline[R any](ctx context.Context, timeout time.Duration, fn func(context.Context) R, timedOut func(error) R) R {
	itemCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	done := make(chan R, 1)
	go func() { done <- fn(itemCtx) }()
	select {
	case r := <-done:
		return r
	case <-itemCtx.Done():
		if ctx.Err() != nil {
			return timedOut(bridge.ErrCancelled)
		}
		return timedOut(nil)
	}
}

const timedOutMessage = "operation timed out; owned tab cleanup scheduled"

type batchFlowItem struct {
	ID        string  `json:"id"`
	URL       string  `json:"url"`
	Status    string  `json:"status"`
	TabID     *int64  `json:"tabId,omitempty"`
	Title     *string `json:"title,omitempty"`
	Results   []any   `json:"results"`
	StoppedAt *int    `json:"stoppedAt,omitempty"`
	Error     *string `json:"error,omitempty"`
}

func (r *batchFlowItem) fail(message string) {
	r.Status = "failed"
	if r.Error != nil {
		message = *r.Error + "; " + message
	}
	r.Error = &message
}

func failedFlowItem(in batchInput, err string) batchFlowItem {
	return batchFlowItem{ID: in.ID, URL: in.URL, Status: "failed", Results: []any{}, Error: &err}
}

// BatchFlow runs the same CSS-template steps on each URL in a fresh owned tab.
func (f *Facade) BatchFlow(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		URLs        *[]string          `json:"urls"`
		Inputs      *[]batchInput      `json:"inputs"`
		Steps       *[]json.RawMessage `json:"steps"`
		Concurrency *int               `json:"concurrency"`
		TimeoutMs   *int64             `json:"timeoutMs"`
		Cleanup     *bool              `json:"cleanup"`
		Active      *bool              `json:"active"`
		BrowserID   string             `json:"browserId"`
	}
	const tool = "browser.batch.flow"
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if a.Steps == nil {
		return nil, invalid("missing field `steps`")
	}
	steps, err := parseSteps(*a.Steps)
	if err != nil {
		return nil, err
	}
	inputs, err := parseBatchInputs(a.URLs, a.Inputs, tool)
	if err != nil {
		return nil, err
	}
	for _, st := range steps {
		if st.kind == stepRef || st.kind == stepNamed || st.kind == stepScroll || (st.kind == stepObserve && st.observe.RefID != nil) {
			return nil, invalid("browser.batch.flow creates new tabs, so it cannot reuse snapshot refs or role/name targets; use CSS templates or browser.act on the originating tab")
		}
	}
	if len(steps) == 0 {
		return nil, invalid("browser.batch.flow requires at least one step")
	}
	for i, st := range steps {
		if st.kind == stepWaitFor {
			return nil, invalid("%s wait takes ms; condition waits (text/textGone/refId) are browser.act steps", tool)
		}
		if steps[i], err = st.withinCeiling(); err != nil {
			return nil, err
		}
	}
	concurrency := clamp(a.Concurrency, defaultBatchConcurrency, 1, maxBatchConcurrency)
	timeout := time.Duration(clamp(a.TimeoutMs, defaultTimeoutMs, 1, maxTimeoutMs)) * time.Millisecond
	cleanup, active := boolOr(a.Cleanup, true), boolOr(a.Active, false)
	browser, err := f.bridge.Bind(a.BrowserID)
	if err != nil {
		return nil, err
	}
	results := runAll(len(inputs), concurrency, func(i int) batchFlowItem {
		in := inputs[i]
		return withDeadline(ctx, timeout,
			func(ctx context.Context) batchFlowItem {
				return f.batchFlowItem(ctx, in, steps, browser, cleanup, active)
			},
			func(cancelled error) batchFlowItem {
				if cancelled != nil {
					return failedFlowItem(in, cancelled.Error())
				}
				return failedFlowItem(in, timedOutMessage)
			})
	})
	return map[string]any{"results": results}, nil
}

func (f *Facade) batchFlowItem(ctx context.Context, in batchInput, steps []step, browser bridge.Target, cleanup, active bool) batchFlowItem {
	owned, err := f.acquire(ctx, browser, map[string]any{"url": "about:blank", "active": active}, in.URL, cleanup)
	if err != nil {
		return failedFlowItem(in, err.Error())
	}
	defer owned.release()
	tabID := owned.TabID
	result := batchFlowItem{ID: in.ID, URL: in.URL, Status: "ok", TabID: &tabID, Results: []any{}}
	if owned.Title != "" {
		result.Title = &owned.Title
	}
	r, err := f.dispatch(ctx, "navigate", map[string]any{"url": owned.URL}, owned.TabID, browser)
	if err == nil {
		err = failIfToolError("navigate", r)
	}
	if err != nil {
		result.fail(err.Error())
	} else {
		for i, st := range steps {
			value, err := f.runStep(ctx, owned.session, st, observeMaxChars, false)
			if err != nil {
				result.StoppedAt = &i
				result.fail(stepError(err))
				break
			}
			result.Results = append(result.Results, st.slim(value))
		}
	}
	if err := owned.cleanup(ctx); err != nil {
		result.fail("cleanup failed: " + err.Error())
	}
	return result
}

type extractLink struct {
	Text   string `json:"text"`
	URL    string `json:"url"`
	Source string `json:"source"`
}

type extractDiagnostics struct {
	TextAttempts    int      `json:"textAttempts"`
	ElapsedMs       int64    `json:"elapsedMs"`
	TextChars       int      `json:"textChars"`
	Ready           bool     `json:"ready"`
	Source          string   `json:"source"`
	ExtensionReason string   `json:"extensionReason,omitempty"`
	A11yAttempted   bool     `json:"a11yAttempted,omitempty"`
	A11yChars       int      `json:"a11yChars,omitempty"`
	DomAttempted    bool     `json:"domAttempted,omitempty"`
	DomChars        int      `json:"domChars,omitempty"`
	TextTruncated   bool     `json:"textTruncated,omitempty"`
	LinksTruncated  bool     `json:"linksTruncated,omitempty"`
	Errors          []string `json:"errors,omitempty"`
}

type extractItem struct {
	ID          string             `json:"id"`
	URL         string             `json:"url"`
	Status      string             `json:"status"`
	TabID       *int64             `json:"tabId"`
	Title       *string            `json:"title,omitempty"`
	Text        string             `json:"text"`
	Links       []extractLink      `json:"links"`
	Diagnostics extractDiagnostics `json:"diagnostics"`
	Error       *string            `json:"error,omitempty"`
}

func failedExtract(in batchInput, tabID *int64, err string) extractItem {
	return extractItem{ID: in.ID, URL: in.URL, Status: "failed", TabID: tabID, Links: []extractLink{}, Error: &err}
}

type extractOptions struct {
	minChars, maxChars, maxLinks int
	includeA11y, includeLinks    bool
	cleanup, active              bool
	browser                      bridge.Target
}

type rawExtractOptions struct {
	MinChars     *int   `json:"minChars"`
	MaxChars     *int   `json:"maxChars"`
	MaxLinks     *int   `json:"maxLinks"`
	IncludeA11y  *bool  `json:"includeA11y"`
	IncludeLinks *bool  `json:"includeLinks"`
	Cleanup      *bool  `json:"cleanup"`
	Active       *bool  `json:"active"`
	BrowserID    string `json:"browserId"`
}

func (r rawExtractOptions) bind(b *bridge.Bridge, defaultMaxChars int) (extractOptions, error) {
	browser, err := b.Bind(r.BrowserID)
	return extractOptions{
		minChars:     clamp(r.MinChars, defaultTextReadyMin, 1, maxTextReadyMin),
		maxChars:     clamp(r.MaxChars, defaultMaxChars, 1, maxExtractMaxChars),
		maxLinks:     clamp(r.MaxLinks, defaultExtractMaxLinks, 0, maxExtractMaxLinks),
		includeA11y:  boolOr(r.IncludeA11y, false),
		includeLinks: boolOr(r.IncludeLinks, false),
		cleanup:      boolOr(r.Cleanup, true),
		active:       boolOr(r.Active, false),
		browser:      browser,
	}, err
}

// Extract reads one page's readable text (and optionally links): a URL in an
// owned background tab, or an existing tab (tabId, else the active one), which
// is left open.
func (f *Facade) Extract(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		URL   *string `json:"url"`
		TabID *int64  `json:"tabId"`
		ID    *string `json:"id"`
		rawExtractOptions
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if a.URL != nil && a.TabID != nil {
		return nil, invalid("browser.extract takes url or tabId, not both")
	}
	if a.URL != nil && *a.URL == "" {
		return nil, invalid("browser.extract requires a non-empty url")
	}
	options, err := a.bind(f.bridge, defaultExtractMaxChars)
	if err != nil {
		return nil, err
	}
	if a.URL == nil {
		id := "current"
		if a.ID != nil {
			id = *a.ID
		}
		return toObject(f.extractTab(ctx, id, a.TabID, options)), nil
	}
	in := batchInput{ID: "url-1", URL: *a.URL}
	if a.ID != nil {
		in.ID = *a.ID
	}
	return toObject(f.extractItem(ctx, in, options)), nil
}

// extractTab reads a tab bro does not own; a nil tabID lets the extension pick
// the active tab, whose id comes back with the snapshot.
func (f *Facade) extractTab(ctx context.Context, id string, tabID *int64, o extractOptions) extractItem {
	start := time.Now()
	in := batchInput{ID: id, URL: "current"}
	initial, err := f.extractPage(ctx, tabID, o.browser, o)
	if err != nil {
		return failedExtract(in, tabID, err.Error())
	}
	if initial.TabID == nil {
		if tabID == nil {
			return failedExtract(in, nil, "extract_page did not report which tab it read")
		}
		initial.TabID = tabID
	}
	if initial.URL != nil && *initial.URL != "" {
		in.URL = *initial.URL
	}
	var title *string
	if initial.Title != nil && strings.TrimSpace(*initial.Title) != "" {
		t := strings.TrimSpace(*initial.Title)
		title = &t
	}
	s := session{TabID: *initial.TabID, Browser: o.browser}
	result := f.finishExtract(ctx, in, s, title, initial, nil, o, start)
	result.TabID = initial.TabID
	return result
}

// BatchExtract extracts several URLs concurrently.
func (f *Facade) BatchExtract(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		URLs        *[]string     `json:"urls"`
		Inputs      *[]batchInput `json:"inputs"`
		Concurrency *int          `json:"concurrency"`
		rawExtractOptions
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	inputs, err := parseBatchInputs(a.URLs, a.Inputs, "browser.batch.extract")
	if err != nil {
		return nil, err
	}
	concurrency := clamp(a.Concurrency, defaultBatchConcurrency, 1, maxBatchConcurrency)
	options, err := a.bind(f.bridge, defaultBatchExtractMax)
	if err != nil {
		return nil, err
	}
	results := runAll(len(inputs), concurrency, func(i int) extractItem {
		return f.extractItem(ctx, inputs[i], options)
	})
	return map[string]any{"results": results}, nil
}

func (f *Facade) extractItem(ctx context.Context, in batchInput, o extractOptions) extractItem {
	owned, err := f.acquire(ctx, o.browser, map[string]any{"url": in.URL, "active": o.active}, in.URL, o.cleanup)
	if err != nil {
		return failedExtract(in, nil, err.Error())
	}
	defer owned.release()
	start := time.Now()
	tabID := owned.TabID
	var title *string
	if owned.Title != "" {
		title = &owned.Title
	}
	initial, initialErr := f.extractPage(ctx, &tabID, owned.Browser, o)
	if title == nil && initialErr == nil && initial.Title != nil && strings.TrimSpace(*initial.Title) != "" {
		t := strings.TrimSpace(*initial.Title)
		title = &t
	}
	result := f.finishExtract(ctx, in, owned.session, title, initial, initialErr, o, start)
	result.TabID = &tabID
	if err := owned.cleanup(context.WithoutCancel(ctx)); err != nil {
		result.Status = "failed"
		msg := "cleanup failed: " + err.Error()
		result.Error = &msg
	}
	return result
}

type domSnapshot struct {
	Title     *string       `json:"title"`
	URL       *string       `json:"url"`
	TabID     *int64        `json:"tabId"`
	Text      string        `json:"text"`
	Links     []extractLink `json:"links"`
	Readiness struct {
		Reason string `json:"reason"`
	} `json:"readiness"`
}

func (f *Facade) finishExtract(ctx context.Context, in batchInput, s session, title *string, initial domSnapshot, initialErr error, o extractOptions, start time.Time) extractItem {
	var d extractDiagnostics
	var bestText string
	bestSource := "extract_page"
	var links []extractLink
	var best textQuality
	if initialErr == nil {
		d.TextAttempts = 1
		d.DomChars = utf8.RuneCountInString(initial.Text)
		d.DomAttempted = true
		// The extension watched the page settle; its short, stable text is the
		// page's content, not a reason to read again.
		settled := initial.Readiness.Reason == "dom_quiet"
		d.ExtensionReason = initial.Readiness.Reason
		links = append(links, initial.Links...)
		bestText = initial.Text
		best = quality(bestText, o.minChars)
		best.ready = best.ready || (settled && strings.TrimSpace(bestText) != "")
	} else {
		d.Errors = append(d.Errors, "extract_page: "+initialErr.Error())
	}

	if o.includeA11y && !best.ready {
		d.A11yAttempted = true
		r, err := f.dispatch(ctx, "read_page", map[string]any{"maxChars": o.maxChars, "compact": true}, s.TabID, s.Browser)
		if err == nil {
			err = failIfToolError("read_page", r)
		}
		if err != nil {
			d.Errors = append(d.Errors, "a11y: "+err.Error())
		} else {
			snapshot := textOf(decode(r.Result))
			d.A11yChars = utf8.RuneCountInString(snapshot)
			links = append(links, parseA11yLinks(snapshot)...)
			if q := quality(snapshot, o.minChars); q.score > best.score {
				bestText, best, bestSource = snapshot, q, "a11y"
			}
		}
	}

	if !best.ready || (o.includeLinks && len(links) == 0) {
		d.DomAttempted = true
		r, err := f.dispatch(ctx, "javascript_tool", map[string]any{"code": domExtractScript}, s.TabID, s.Browser)
		if err == nil {
			err = failIfToolError("javascript_tool", r)
		}
		var snapshot domSnapshot
		if err == nil {
			snapshot, err = parseDomSnapshot(r.Result)
		}
		if err != nil {
			d.Errors = append(d.Errors, "dom: "+err.Error())
		} else {
			d.DomChars = utf8.RuneCountInString(snapshot.Text)
			links = append(links, snapshot.Links...)
			if q := quality(snapshot.Text, o.minChars); !best.ready && q.score > best.score {
				bestText, best, bestSource = snapshot.Text, q, "dom"
			}
		}
	}

	links = dedupeLinks(links)
	textChars, linkCount := utf8.RuneCountInString(bestText), len(links)
	bestText = truncateRunes(bestText, o.maxChars)
	if !o.includeLinks {
		links = links[:0]
	} else if len(links) > o.maxLinks {
		links = links[:o.maxLinks]
	}
	d.ElapsedMs = time.Since(start).Milliseconds()
	d.TextChars = utf8.RuneCountInString(bestText)
	d.Source = bestSource
	d.Ready = best.ready
	d.TextTruncated = textChars > o.maxChars
	d.LinksTruncated = o.includeLinks && linkCount > o.maxLinks
	status := "partial"
	if d.Ready {
		status = "ok"
	}
	return extractItem{ID: in.ID, URL: in.URL, Status: status, Title: title, Text: bestText, Links: links, Diagnostics: d}
}

func (f *Facade) extractPage(ctx context.Context, tabID *int64, browser bridge.Target, o extractOptions) (domSnapshot, error) {
	maxLinks := 0
	if o.includeLinks {
		maxLinks = o.maxLinks
	}
	if ctx.Err() != nil {
		return domSnapshot{}, bridge.ErrCancelled
	}
	r, err := browser.Dispatch(ctx, f.bridge, "extract_page", map[string]any{
		"minChars": o.minChars,
		"quietMs":  textReadyPoll.Milliseconds(),
		"guardMs":  extractPageGuardMs,
		"maxChars": o.maxChars,
		"maxLinks": maxLinks,
	}, tabID)
	if err != nil {
		return domSnapshot{}, err
	}
	if err := failIfToolError("extract_page", r); err != nil {
		return domSnapshot{}, err
	}
	return parseDomSnapshot(r.Result)
}

// parseDomSnapshot accepts the snapshot as structured data or as the JSON
// text (possibly a JSON string) of a javascript_tool reply.
func parseDomSnapshot(raw json.RawMessage) (domSnapshot, error) {
	var snapshot domSnapshot
	if json.Unmarshal(raw, &snapshot) == nil && (snapshot.Text != "" || len(snapshot.Links) > 0 || snapshot.Readiness.Reason != "") {
		return snapshot, nil
	}
	text, ok := extractText(decode(raw))
	if !ok {
		return domSnapshot{}, ToolFailedError{"javascript_tool", "DOM snapshot returned no text"}
	}
	var wrapper any
	if err := json.Unmarshal([]byte(text), &wrapper); err != nil {
		return domSnapshot{}, ToolFailedError{"javascript_tool", "failed to parse DOM snapshot wrapper: " + err.Error()}
	}
	if inner, ok := wrapper.(string); ok {
		text = inner
	}
	snapshot = domSnapshot{}
	if err := json.Unmarshal([]byte(text), &snapshot); err != nil {
		return domSnapshot{}, fmt.Errorf("invalid DOM snapshot: %w", err)
	}
	return snapshot, nil
}

func parseA11yLinks(text string) []extractLink {
	var links []extractLink
	for _, line := range strings.Split(text, "\n") {
		_, rest, ok := strings.Cut(line, "link \"")
		if !ok {
			continue
		}
		label, rest, ok := strings.Cut(rest, "\" href=\"")
		if !ok {
			continue
		}
		u, _, ok := strings.Cut(rest, "\"")
		if !ok || strings.TrimSpace(u) == "" {
			continue
		}
		links = append(links, extractLink{Text: strings.TrimSpace(label), URL: strings.TrimSpace(u), Source: "a11y"})
	}
	return links
}

func dedupeLinks(links []extractLink) []extractLink {
	seen := map[[2]string]bool{}
	out := []extractLink{}
	for _, l := range links {
		key := [2]string{l.URL, l.Text}
		if !seen[key] {
			seen[key] = true
			out = append(out, l)
		}
	}
	return out
}

type captureArgs struct {
	URL       *string `json:"url"`
	Code      *string `json:"code"`
	TimeoutMs *int64  `json:"timeoutMs"`
	BrowserID string  `json:"browserId"`
	Active    bool    `json:"active"`
	Cleanup   *bool   `json:"cleanup"`
}

func (a captureArgs) check() error {
	if a.URL == nil {
		return invalid("missing field `url`")
	}
	if a.Code == nil {
		return invalid("missing field `code`")
	}
	return nil
}

// ConsoleCapture opens the URL, runs code and returns the console messages it caused.
func (f *Facade) ConsoleCapture(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		captureArgs
		MaxMessages *int64 `json:"maxMessages"`
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if err := a.check(); err != nil {
		return nil, err
	}
	return f.capture(ctx, a.captureArgs, "capture_console", map[string]any{
		"code":        *a.Code,
		"timeoutMs":   clamp(a.TimeoutMs, consoleCaptureTimeout, 0, 20_000),
		"maxMessages": clamp(a.MaxMessages, consoleCaptureMaxMsgs, 0, 500),
	})
}

// NetworkCapture opens the URL, runs code and returns the requests it caused.
func (f *Facade) NetworkCapture(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		captureArgs
		URLIncludes           *string `json:"urlIncludes"`
		IncludeResponseBodies *bool   `json:"includeResponseBodies"`
		IncludeHeaders        bool    `json:"includeHeaders"`
		IncludePostData       bool    `json:"includePostData"`
		MaxBodyChars          *int64  `json:"maxBodyChars"`
		MaxRequests           *int64  `json:"maxRequests"`
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if err := a.check(); err != nil {
		return nil, err
	}
	capture := map[string]any{
		"code":                  *a.Code,
		"timeoutMs":             clamp(a.TimeoutMs, networkCaptureTimeout, 0, 20_000),
		"includeResponseBodies": boolOr(a.IncludeResponseBodies, true),
		"includeHeaders":        a.IncludeHeaders,
		"includePostData":       a.IncludePostData,
		"maxBodyChars":          clamp(a.MaxBodyChars, networkCaptureMaxBody, 0, 60_000),
		"maxRequests":           clamp(a.MaxRequests, networkCaptureMaxReqs, 0, 100),
	}
	if a.URLIncludes != nil {
		capture["urlIncludes"] = *a.URLIncludes
	}
	return f.capture(ctx, a.captureArgs, "capture_network", capture)
}

func (f *Facade) capture(ctx context.Context, a captureArgs, tool string, toolArgs map[string]any) (map[string]any, error) {
	browser, err := f.bridge.Bind(a.BrowserID)
	if err != nil {
		return nil, err
	}
	owned, err := f.acquire(ctx, browser, map[string]any{"url": *a.URL, "active": a.Active}, *a.URL, boolOr(a.Cleanup, true))
	if err != nil {
		return nil, err
	}
	defer owned.release()
	value, err := func() (map[string]any, error) {
		ready, err := f.readTextWithRetry(ctx, owned.TabID, browser, map[string]any{})
		if err != nil {
			return nil, err
		}
		if err := failIfToolError("get_page_text", ready); err != nil {
			return nil, err
		}
		r, err := f.dispatch(ctx, tool, toolArgs, owned.TabID, browser)
		if err != nil {
			return nil, err
		}
		if err := failIfToolError(tool, r); err != nil {
			return nil, err
		}
		text, ok := extractText(decode(r.Result))
		if !ok {
			return nil, ToolFailedError{tool, "response did not contain JSON text"}
		}
		var parsed any
		if err := json.Unmarshal([]byte(text), &parsed); err != nil {
			return nil, ToolFailedError{tool, "response was not valid JSON: " + err.Error()}
		}
		object, ok := parsed.(map[string]any)
		if !ok {
			return nil, ToolFailedError{tool, "response JSON was not an object"}
		}
		object["tabId"], object["url"], object["browserId"] = owned.TabID, *a.URL, browser.BrowserID
		return object, nil
	}()
	cleanupErr := owned.cleanup(context.WithoutCancel(ctx))
	switch {
	case err != nil && cleanupErr != nil:
		return nil, ToolFailedError{tool, fmt.Sprintf("%v; cleanup failed: %v", err, cleanupErr)}
	case err != nil:
		return nil, err
	case cleanupErr != nil:
		return nil, cleanupErr
	}
	return value, nil
}

// toObject converts a result struct to the JSON object the MCP layer returns.
func toObject(v any) map[string]any {
	data, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("encode %T: %v", v, err))
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		panic(fmt.Sprintf("decode %T: %v", v, err))
	}
	return out
}
