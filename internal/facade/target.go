package facade

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/xiaotianxt/bro/internal/bridge"
)

// Open opens an owned target. Navigation is dispatched with deferred
// readiness; the first observe or act settles the page.
func (f *Facade) Open(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		URL            *string         `json:"url"`
		BrowserID      string          `json:"browserId"`
		Active         bool            `json:"active"`
		OwnerSessionID *string         `json:"ownerSessionId"`
		Label          *string         `json:"label"`
		Observe        json.RawMessage `json:"observe"`
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if a.URL == nil {
		return nil, invalid("missing field `url`")
	}
	if err := checkURL(*a.URL); err != nil {
		return nil, err
	}
	if (a.OwnerSessionID != nil && strings.TrimSpace(*a.OwnerSessionID) == "") ||
		(a.Label != nil && strings.TrimSpace(*a.Label) == "") {
		return nil, invalid("ownerSessionId and label must be nonempty when supplied")
	}
	observe, err := observeOption(a.Observe)
	if err != nil {
		return nil, err
	}
	browser, err := f.bridge.Bind(a.BrowserID)
	if err != nil {
		return nil, err
	}
	create := map[string]any{"url": *a.URL, "active": a.Active, "deferReadiness": true}
	owner := a.OwnerSessionID
	if owner == nil && a.Label != nil {
		id := newTargetID()
		owner = &id
	}
	if owner != nil {
		create["sessionId"] = *owner
		if a.Label != nil {
			create["sessionName"] = *a.Label
		}
	}
	owned, err := f.acquire(ctx, browser, create, *a.URL, true)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		if err := owned.cleanup(context.Background()); err != nil {
			return nil, err
		}
		return nil, bridge.ErrCancelled
	}
	s := owned.handOff()
	value := map[string]any{"targetId": s.ID, "tabId": s.TabID, "url": s.URL}
	if observe == nil {
		return value, nil
	}
	// The tab is open and owned either way, so a failed first read is
	// reported beside its targetId instead of hiding the target.
	s, err = f.settled(ctx, s.ID)
	var content string
	if err == nil {
		content, err = f.observe(ctx, s, *observe, observeMaxChars)
	}
	if err != nil {
		value["observeError"] = err.Error()
	} else {
		value["content"] = content
	}
	return value, nil
}

// Attach makes a tab bro did not open a target it may act on but never
// closes. The probe proves the tab exists and is scriptable before it is
// registered.
func (f *Facade) Attach(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		TabID     *int64          `json:"tabId"`
		BrowserID string          `json:"browserId"`
		Observe   json.RawMessage `json:"observe"`
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if a.TabID == nil {
		return nil, invalid("missing field `tabId`")
	}
	observe, err := observeOption(a.Observe)
	if err != nil {
		return nil, err
	}
	browser, err := f.bridge.Bind(a.BrowserID)
	if err != nil {
		return nil, err
	}
	probe, err := f.dispatch(ctx, "javascript_tool", javascriptArgs("location.href", false, nil), *a.TabID, browser)
	if err != nil {
		return nil, err
	}
	if err := failIfToolError("javascript_tool", probe); err != nil {
		return nil, err
	}
	url, err := javascriptStringResult(decode(probe.Result))
	if err != nil {
		return nil, err
	}
	s := session{ID: newTargetID(), TabID: *a.TabID, Browser: browser, URL: url}
	f.store(s)
	value := map[string]any{"targetId": s.ID, "tabId": s.TabID, "url": s.URL}
	if observe != nil {
		if content, err := f.observe(ctx, s, *observe, observeMaxChars); err != nil {
			value["observeError"] = err.Error()
		} else {
			value["content"] = content
		}
	}
	return value, nil
}

// Observe reads a target's accessibility tree or text.
func (f *Facade) Observe(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		TargetID *string `json:"targetId"`
		Close    bool    `json:"close"`
		rawObserve
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if a.TargetID == nil {
		return nil, invalid("missing field `targetId`")
	}
	o, err := a.rawObserve.options()
	if err != nil {
		return nil, invalid("%v", err)
	}
	if o, err = o.withinCeiling(); err != nil {
		return nil, err
	}
	s, err := f.settled(ctx, *a.TargetID)
	if err != nil {
		return nil, err
	}
	content, err := f.observe(ctx, s, o, observeMaxChars)
	if err != nil {
		return nil, err
	}
	value := map[string]any{"targetId": s.ID, "content": content}
	if a.Close {
		if err := f.closeAfter(ctx, value); err != nil {
			return nil, err
		}
	}
	return value, nil
}

// Act runs ordered element steps on one target and stops at the first failure.
func (f *Facade) Act(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		TargetID *string           `json:"targetId"`
		Steps    []json.RawMessage `json:"steps"`
		Close    bool              `json:"close"`
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if a.TargetID == nil {
		return nil, invalid("missing field `targetId`")
	}
	steps, err := parseSteps(a.Steps)
	if err != nil {
		return nil, err
	}
	if len(steps) == 0 || len(steps) > 32 {
		return nil, invalid("act requires 1–32 ordered steps")
	}
	for i, st := range steps {
		if steps[i], err = st.withinCeiling(); err != nil {
			return nil, err
		}
		switch st.kind {
		case stepWaitMs:
			return nil, invalid("act wait takes a condition, not a delay: text, textGone, or refId with state, and optional timeoutMs (default %d, at most %d)", defaultWaitTimeoutMs, maxWaitTimeoutMs)
		case stepGoto:
			if err := checkURL(st.url); err != nil {
				return nil, err
			}
		case stepEval:
			if st.frameID != nil && strings.TrimSpace(*st.frameID) == "" {
				return nil, invalid("frameId must be nonempty")
			}
		case stepCSSClick, stepCSSFill, stepCSSSelect, stepReadText:
			return nil, invalid("act targets elements by refId or role + name: navigate/evaluate/wait/observe and click/fill/select/check/press/scroll; use evaluate for explicit synthetic operations")
		}
	}
	s, err := f.settled(ctx, *a.TargetID)
	if err != nil {
		return nil, err
	}
	value, err := f.actSteps(ctx, s, steps)
	if err != nil {
		return nil, err
	}
	// A failed step keeps the target open: the caller may want to retry.
	if a.Close && value["status"] != "failed" {
		if err := f.closeAfter(ctx, value); err != nil {
			return nil, err
		}
	}
	return value, nil
}

// Step is browser.click/fill/press: one act step, so one rendering and one
// change report for every element action.
func (f *Facade) Step(ctx context.Context, kind string, args map[string]any) (map[string]any, error) {
	step := make(map[string]any, len(args)+1)
	act := map[string]any{}
	for k, v := range args {
		switch k {
		case "targetId", "close":
			act[k] = v
		default:
			step[k] = v
		}
	}
	step["type"] = kind
	act["steps"] = []any{step}
	return f.Act(ctx, act)
}

func (f *Facade) actSteps(ctx context.Context, s session, steps []step) (map[string]any, error) {
	results := make([]any, 0, len(steps))
	var stoppedAt *int
	// An armed answer must not outlive this call: a later confirm would be
	// accepted without the caller asking.
	armedDialogs := false
	for _, st := range steps {
		armedDialogs = armedDialogs || st.kind == stepDialog
	}
	for i, st := range steps {
		value, err := f.runStep(ctx, s, st, actObserveMaxChars, true)
		if err != nil {
			entry := st.label()
			entry["error"] = stepError(err)
			results = append(results, entry)
			stoppedAt = &i
			break
		}
		if st.kind == stepGoto {
			s.URL = st.url
		}
		results = append(results, st.slim(value))
	}
	if armedDialogs {
		r, err := f.dispatch(ctx, "dialog_answer", map[string]any{"disarm": true}, s.TabID, s.Browser)
		if err != nil {
			return nil, err
		}
		if err := failIfToolError("dialog_answer", r); err != nil {
			return nil, err
		}
	}
	value := map[string]any{"targetId": s.ID, "status": "ok", "results": results}
	if stoppedAt != nil {
		value["status"] = "failed"
		value["stoppedAt"] = *stoppedAt
	}
	return value, nil
}

// Close releases a target: an owned tab is closed, an attached one is only
// forgotten. A failed close keeps the target for a retry.
func (f *Facade) Close(ctx context.Context, args map[string]any) (map[string]any, error) {
	var a struct {
		TargetID *string `json:"targetId"`
	}
	if err := parseArgs(args, &a); err != nil {
		return nil, err
	}
	if a.TargetID == nil {
		return nil, invalid("missing field `targetId`")
	}
	s, cleanup, closeError, err := f.finish(ctx, *a.TargetID)
	if err != nil {
		return nil, err
	}
	value := map[string]any{"targetId": *a.TargetID, "closed": cleanup && closeError == "", "status": "ok"}
	if !s.Owned {
		value["released"] = true
	}
	if closeError != "" {
		value["status"], value["error"] = "failed", closeError
	}
	return value, nil
}

// closeAfter implements `close: true` on a target's last call, which saves
// the model a browser.close turn.
func (f *Facade) closeAfter(ctx context.Context, value map[string]any) error {
	s, _, closeError, err := f.finish(ctx, value["targetId"].(string))
	if err != nil {
		return err
	}
	switch {
	case closeError != "":
		value["closeError"] = closeError
	case s.Owned:
		value["closed"] = true
	default:
		value["released"] = true
	}
	return nil
}

func (f *Facade) observe(ctx context.Context, s session, o observeOptions, defaultMax int) (string, error) {
	var tool string
	var r bridge.Result
	var err error
	if o.Mode == "text" {
		tool = "get_page_text"
		args := map[string]any{}
		if o.MaxChars != nil {
			args["maxChars"] = *o.MaxChars
		}
		if o.Cursor != nil && *o.Cursor > 0 {
			// A continuation may legitimately be a short tail; readiness was
			// established by the read that produced the cursor.
			args["cursor"] = *o.Cursor
			r, err = f.dispatch(ctx, tool, args, s.TabID, s.Browser)
		} else {
			r, err = f.readTextWithRetry(ctx, s.TabID, s.Browser, args)
		}
	} else {
		tool = "read_page"
		if o.MaxChars == nil {
			o.MaxChars = &defaultMax
		}
		r, err = f.dispatch(ctx, tool, o.readPageArgs(), s.TabID, s.Browser)
	}
	if err != nil {
		return "", err
	}
	if err := failIfToolError(tool, r); err != nil {
		return "", err
	}
	return textOf(decode(r.Result)), nil
}

// readTextWithRetry rereads page text until it is readable, the tool fails,
// or textReadyTimeout passes.
func (f *Facade) readTextWithRetry(ctx context.Context, tabID int64, browser bridge.Target, args map[string]any) (bridge.Result, error) {
	deadline := time.Now().Add(textReadyTimeout)
	for {
		r, err := f.dispatch(ctx, "get_page_text", args, tabID, browser)
		if err != nil {
			return r, err
		}
		if _, failed := toolErrorMessage(r); failed || hasPageText(textOf(decode(r.Result))) || !time.Now().Before(deadline) {
			return r, nil
		}
		if err := sleep(ctx, textReadyPoll); err != nil {
			return bridge.Result{}, err
		}
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return bridge.ErrCancelled
	case <-t.C:
		return nil
	}
}

type documentProbe struct {
	State string `json:"state"`
	Blank bool   `json:"blank"`
	Text  string `json:"text"`
}

func (p documentProbe) hasContent() bool {
	return p.State != "loading" && !p.Blank && hasPageText(p.Text)
}

// settledShort is short text of a fully loaded document that is not a placeholder.
func (p documentProbe) settledShort() bool {
	return p.State == "complete" && !p.Blank && strings.TrimSpace(p.Text) != "" &&
		!isLoadingPlaceholder(p.Text) && !isProbableNavShell(p.Text)
}

// settled: an opened target's first observe/act establishes readiness, so a
// page that loaded during the model's turn costs one probe. At the cap the
// call proceeds and shows whatever the page has.
func (f *Facade) settled(ctx context.Context, id string) (session, error) {
	s, err := f.session(id)
	if err != nil || !s.ReadyPending {
		return s, err
	}
	deadline := time.Now().Add(openSettleTimeout)
	var previous *string
	for {
		probe, err := f.documentProbe(ctx, s)
		if err != nil {
			return session{}, err
		}
		if probe != nil {
			// Enough readable text passes at once; a complete document's short
			// text passes once it holds still across two probes.
			if probe.hasContent() || (probe.settledShort() && previous != nil && *previous == probe.Text) {
				break
			}
			previous = &probe.Text
		} else {
			previous = nil
		}
		if !time.Now().Before(deadline) {
			break
		}
		if err := sleep(ctx, textReadyPoll); err != nil {
			return session{}, err
		}
	}
	f.mu.Lock()
	if stored, ok := f.sessions[id]; ok {
		stored.ReadyPending = false
		f.sessions[id] = stored
	}
	f.mu.Unlock()
	s.ReadyPending = false
	return s, nil
}

// documentProbe reads the document's load state and text; nil while a
// navigation makes the probe fail.
func (f *Facade) documentProbe(ctx context.Context, s session) (*documentProbe, error) {
	r, err := f.dispatch(ctx, "javascript_tool", javascriptArgs(
		"({state: document.readyState, blank: location.href === 'about:blank', text: (document.body?.innerText ?? '').slice(0, 2000)})",
		false, nil), s.TabID, s.Browser)
	if err != nil {
		return nil, err
	}
	if _, failed := toolErrorMessage(r); failed {
		return nil, nil
	}
	var probe documentProbe
	if json.Unmarshal([]byte(textOf(decode(r.Result))), &probe) != nil {
		return nil, nil
	}
	return &probe, nil
}
