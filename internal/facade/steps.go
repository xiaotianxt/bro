package facade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/xiaotianxt/bro/internal/bridge"
	"github.com/xiaotianxt/bro/internal/catalog"
)

type stepKind int

const (
	stepObserve stepKind = iota
	stepGoto
	stepEval
	stepCSSClick
	stepCSSFill
	stepCSSSelect
	stepRef   // an element action by refId
	stepNamed // an element action by role + name, resolved when the step runs
	stepScroll
	stepPress // a key press to the focused element
	stepWaitMs
	stepWaitFor
	stepReadText
	stepDialog // arms how native dialogs opened by later steps are answered
)

type actionKind int

const (
	actClick actionKind = iota
	actFill
	actSelect
	actCheck
	actPress
	actUpload
)

type refAction struct {
	kind    actionKind
	value   string
	checked bool
	key     string
	paths   []string
	drop    bool
}

type waitCondition struct {
	kind  string // "text", "textGone", "ref"
	text  string
	refID string
	state string
}

func (c waitCondition) describe() string {
	switch c.kind {
	case "text":
		return "text " + jsonText(c.text) + " appears"
	case "textGone":
		return "text " + jsonText(c.text) + " is gone"
	default:
		return c.refID + " is " + c.state
	}
}

// step is one parsed act or batch.flow step. Every step of a request parses
// before any effect, so css+refId or refId+frameId never half-run a flow.
type step struct {
	kind       stepKind
	observe    observeOptions
	url, code  string
	css, value string
	frameID    *string
	refID      string
	role, name string
	action     refAction
	direction  string
	amount     int
	key        string
	ms         int64
	cond       waitCondition
	timeoutMs  int64
	accept     bool
	promptText *string
}

func (s step) kindName() string {
	switch s.kind {
	case stepObserve:
		return "observe"
	case stepGoto:
		return "navigate"
	case stepEval:
		return "evaluate"
	case stepCSSClick:
		return "click"
	case stepCSSFill:
		return "fill"
	case stepCSSSelect:
		return "select"
	case stepRef, stepNamed:
		return [...]string{"click", "fill", "select", "check", "press", "upload"}[s.action.kind]
	case stepPress:
		return "press"
	case stepScroll:
		return "scroll"
	case stepWaitMs, stepWaitFor:
		return "wait"
	case stepReadText:
		return "read_text"
	default:
		return "dialog"
	}
}

var targetFields = []string{"css", "refId", "frameId", "role", "name"}

type rawStep struct {
	Type       string   `json:"type"`
	URL        *string  `json:"url"`
	Code       *string  `json:"code"`
	FrameID    *string  `json:"frameId"`
	CSS        *string  `json:"css"`
	RefID      *string  `json:"refId"`
	Role       *string  `json:"role"`
	Name       *string  `json:"name"`
	Value      *string  `json:"value"`
	Ms         *int64   `json:"ms"`
	Text       *string  `json:"text"`
	TextGone   *string  `json:"textGone"`
	State      *string  `json:"state"`
	TimeoutMs  *int64   `json:"timeoutMs"`
	Direction  *string  `json:"direction"`
	Amount     *int     `json:"amount"`
	Checked    *bool    `json:"checked"`
	Key        *string  `json:"key"`
	Accept     *bool    `json:"accept"`
	PromptText *string  `json:"promptText"`
	Paths      []string `json:"paths"`
	Drop       *bool    `json:"drop"`
}

func with(base []string, extra ...string) []string {
	return append(append([]string{"type"}, base...), extra...)
}

func parseSteps(raw []json.RawMessage) ([]step, error) {
	steps := make([]step, 0, len(raw))
	for _, r := range raw {
		s, err := parseStep(r)
		if err != nil {
			return nil, invalid("%v", err)
		}
		steps = append(steps, s)
	}
	return steps, nil
}

func parseStep(data json.RawMessage) (step, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return step{}, fmt.Errorf("step must be an object: %v", err)
	}
	var r rawStep
	if err := json.Unmarshal(data, &r); err != nil {
		return step{}, err
	}
	var err error
	switch r.Type {
	case "observe":
		err = fields(obj, with(observeFields))
	case "goto", "navigate":
		err = fields(obj, with([]string{"url"}), "url")
	case "eval", "evaluate":
		err = fields(obj, with([]string{"code", "frameId"}), "code")
	case "click":
		err = fields(obj, with(targetFields))
	case "fill", "select":
		err = fields(obj, with(targetFields, "value"), "value")
	case "wait":
		err = fields(obj, with([]string{"ms", "text", "textGone", "refId", "state", "timeoutMs"}))
	case "read_text":
		err = fields(obj, with([]string{"frameId"}))
	case "scroll":
		err = fields(obj, with([]string{"refId", "direction", "amount"}), "refId")
	case "check":
		err = fields(obj, with(targetFields, "checked"))
	case "press":
		err = fields(obj, with(targetFields, "key"), "key")
	case "dialog":
		err = fields(obj, with([]string{"accept", "promptText"}), "accept")
	case "upload":
		err = fields(obj, with(targetFields, "paths", "drop"), "paths")
	case "":
		return step{}, errors.New("missing field `type`")
	default:
		return step{}, fmt.Errorf("unknown variant `%s`", r.Type)
	}
	if err != nil {
		return step{}, err
	}
	switch r.Type {
	case "observe":
		// Decoded on its own: rawStep's refId shadows the observe options' refId.
		var raw rawObserve
		if err := json.Unmarshal(data, &raw); err != nil {
			return step{}, err
		}
		o, err := raw.options()
		return step{kind: stepObserve, observe: o}, err
	case "goto", "navigate":
		return step{kind: stepGoto, url: *r.URL}, nil
	case "eval", "evaluate":
		if *r.Code == "" {
			return step{}, errors.New("evaluation code must be nonempty")
		}
		return step{kind: stepEval, code: *r.Code, frameID: r.FrameID}, nil
	case "scroll":
		direction, amount := "down", 400
		if r.Direction != nil {
			switch *r.Direction {
			case "up", "down", "left", "right":
				direction = *r.Direction
			default:
				return step{}, fmt.Errorf("unknown variant `%s`, expected one of `up`, `down`, `left`, `right`", *r.Direction)
			}
		}
		if r.Amount != nil {
			amount = *r.Amount
		}
		if strings.TrimSpace(*r.RefID) == "" || amount < 1 || amount > 10_000 {
			return step{}, errors.New("scroll requires a nonempty refId and amount between 1 and 10000 CSS pixels")
		}
		return step{kind: stepScroll, refID: *r.RefID, direction: direction, amount: amount}, nil
	case "check":
		if r.CSS != nil {
			return step{}, errors.New("check requires a refId or role + name, not css")
		}
		checked := r.Checked == nil || *r.Checked
		return fromTarget(r, refAction{kind: actCheck, checked: checked})
	case "press":
		if strings.TrimSpace(*r.Key) == "" {
			return step{}, errors.New("press requires a nonempty key, e.g. Escape")
		}
		if r.CSS != nil {
			return step{}, errors.New("press targets a refId or role + name, not css")
		}
		if r.RefID == nil && r.FrameID == nil && r.Role == nil && r.Name == nil {
			return step{kind: stepPress, key: *r.Key}, nil
		}
		return fromTarget(r, refAction{kind: actPress, key: *r.Key})
	case "wait":
		return parseWait(r)
	case "read_text":
		return step{kind: stepReadText, frameID: r.FrameID}, nil
	case "click":
		return fromTarget(r, refAction{kind: actClick})
	case "fill":
		return fromTarget(r, refAction{kind: actFill, value: *r.Value})
	case "select":
		return fromTarget(r, refAction{kind: actSelect, value: *r.Value})
	case "dialog":
		return step{kind: stepDialog, accept: *r.Accept, promptText: r.PromptText}, nil
	default: // upload
		if r.CSS != nil {
			return step{}, errors.New("upload targets a refId or role + name, not css")
		}
		if len(r.Paths) == 0 {
			return step{}, errors.New("upload requires paths: absolute local file paths")
		}
		// Checked while parsing, so a bad path fails before any step runs.
		paths := make([]string, 0, len(r.Paths))
		for _, p := range r.Paths {
			canonical, err := catalog.CanonicalUploadPath("upload", p)
			if err != nil {
				return step{}, err
			}
			paths = append(paths, canonical)
		}
		return fromTarget(r, refAction{kind: actUpload, paths: paths, drop: r.Drop != nil && *r.Drop})
	}
}

func fromTarget(r rawStep, action refAction) (step, error) {
	nonEmpty := func(p *string) bool { return p != nil && strings.TrimSpace(*p) != "" }
	switch {
	case r.CSS != nil && r.RefID == nil && r.Role == nil && r.Name == nil && nonEmpty(r.CSS):
		kind := map[actionKind]stepKind{actClick: stepCSSClick, actFill: stepCSSFill, actSelect: stepCSSSelect}[action.kind]
		return step{kind: kind, css: *r.CSS, value: action.value, frameID: r.FrameID}, nil
	case r.CSS == nil && r.Role == nil && r.Name == nil && nonEmpty(r.RefID) && r.FrameID == nil:
		return step{kind: stepRef, refID: *r.RefID, action: action}, nil
	case r.CSS == nil && r.RefID == nil && nonEmpty(r.Role) && nonEmpty(r.Name) && r.FrameID == nil:
		return step{kind: stepNamed, role: *r.Role, name: *r.Name, action: action}, nil
	}
	return step{}, errors.New("element steps take exactly one target: nonempty css (optionally with frameId), refId, or role + name (main frame)")
}

func parseWait(r rawStep) (step, error) {
	nonEmpty := func(p *string) bool { return p != nil && strings.TrimSpace(*p) != "" }
	var cond *waitCondition
	switch {
	case r.Text != nil && r.TextGone == nil && r.RefID == nil && r.State == nil && nonEmpty(r.Text):
		cond = &waitCondition{kind: "text", text: *r.Text}
	case r.Text == nil && r.TextGone != nil && r.RefID == nil && r.State == nil && nonEmpty(r.TextGone):
		cond = &waitCondition{kind: "textGone", text: *r.TextGone}
	case r.Text == nil && r.TextGone == nil && r.RefID != nil && r.State != nil && nonEmpty(r.RefID):
		switch *r.State {
		case "visible", "hidden", "enabled", "disabled":
		default:
			return step{}, fmt.Errorf("unknown variant `%s`, expected one of `visible`, `hidden`, `enabled`, `disabled`", *r.State)
		}
		cond = &waitCondition{kind: "ref", refID: *r.RefID, state: *r.State}
	case r.Text == nil && r.TextGone == nil && r.RefID == nil && r.State == nil:
	default:
		return step{}, errors.New("wait requires exactly one condition: nonempty text, nonempty textGone, or refId with state (visible|hidden|enabled|disabled)")
	}
	switch {
	case r.Ms != nil && cond == nil && r.TimeoutMs == nil:
		return step{kind: stepWaitMs, ms: *r.Ms}, nil
	case r.Ms == nil && cond != nil:
		timeout := int64(defaultWaitTimeoutMs)
		if r.TimeoutMs != nil {
			timeout = *r.TimeoutMs
		}
		if timeout < 1 || timeout > maxWaitTimeoutMs {
			return step{}, fmt.Errorf("wait timeoutMs must be between 1 and %d", maxWaitTimeoutMs)
		}
		return step{kind: stepWaitFor, cond: *cond, timeoutMs: timeout}, nil
	case r.Ms == nil && cond == nil:
		return step{}, errors.New("wait requires a condition (text, textGone, or refId with state) or, in batch.flow, ms")
	default:
		return step{}, errors.New("wait takes either ms or a condition with optional timeoutMs, not both")
	}
}

func (s step) withinCeiling() (step, error) {
	if s.kind == stepObserve {
		o, err := s.observe.withinCeiling()
		s.observe = o
		return s, err
	}
	return s, nil
}

// label is what a step targeted, kept for its result entry.
func (s step) label() map[string]any {
	entry := map[string]any{"type": s.kindName()}
	switch s.kind {
	case stepRef, stepScroll:
		entry["refId"] = s.refID
	case stepNamed:
		entry["target"] = s.role + " " + strconv.Quote(s.name)
	}
	if (s.kind == stepRef || s.kind == stepNamed) && s.action.kind == actCheck {
		entry["checked"] = s.action.checked
	}
	switch {
	case s.kind == stepPress:
		entry["key"] = s.key
	case (s.kind == stepRef || s.kind == stepNamed) && s.action.kind == actPress:
		entry["key"] = s.action.key
	}
	return entry
}

// slim keeps only what the caller cannot infer from its own request.
func (s step) slim(value map[string]any) map[string]any {
	entry := s.label()
	switch s.kindName() {
	case "observe":
		entry["content"] = value["content"]
	case "navigate":
		text := textOf(value)
		entry["url"] = strings.TrimPrefix(text, "Navigated to ")
	case "dialog":
		entry["result"] = textOf(value)
	case "evaluate", "scroll":
		text := textOf(value)
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			entry["result"] = parsed
		} else {
			entry["result"] = text
		}
	case "wait":
		for _, k := range []string{"met", "ms", "condition", "lastError"} {
			if v, ok := value[k]; ok {
				entry[k] = v
			}
		}
	case "read_text":
		entry["text"] = value["text"]
	default: // element actions
		for _, k := range []string{"refId", "files", "changes"} {
			if v, ok := value[k]; ok {
				entry[k] = v
			}
		}
	}
	return entry
}

func isStaleScope(err error) bool {
	var tf ToolFailedError
	return errors.As(err, &tf) && strings.Contains(tf.Message, "Scoped ref ")
}

// runStep executes one step. act marks the model-facing act path: an act
// observation whose scope was re-rendered reads the page instead of failing
// the steps before it.
func (f *Facade) runStep(ctx context.Context, s session, st step, observeBudget int, act bool) (map[string]any, error) {
	single := func(tool string, args any) (map[string]any, error) {
		r, err := f.dispatch(ctx, tool, args, s.TabID, s.Browser)
		if err != nil {
			return nil, err
		}
		if err := failIfToolError(tool, r); err != nil {
			return nil, err
		}
		return map[string]any{"result": decode(r.Result)}, nil
	}
	switch st.kind {
	case stepObserve:
		content, err := f.observe(ctx, s, st.observe, observeBudget)
		if err != nil && act && isStaleScope(err) {
			page := st.observe
			page.RefID, page.Cursor = nil, nil
			content, err = f.observe(ctx, s, page, observeBudget)
			if err == nil {
				content = fmt.Sprintf("scope %s was replaced; observed page\n%s", *st.observe.RefID, content)
			}
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"content": content}, nil
	case stepGoto:
		value, err := single("navigate", map[string]any{"url": st.url})
		if err == nil {
			f.updateURL(s.ID, st.url)
		}
		return value, err
	case stepEval:
		return single("javascript_tool", javascriptArgs(st.code, true, st.frameID))
	case stepCSSClick:
		return single("javascript_tool", javascriptArgs(clickScript(st.css), false, st.frameID))
	case stepCSSFill:
		return single("javascript_tool", javascriptArgs(fillScript(st.css, st.value), false, st.frameID))
	case stepCSSSelect:
		return single("javascript_tool", javascriptArgs(selectScript(st.css, st.value), false, st.frameID))
	case stepPress:
		return f.actElement(ctx, s, map[string]any{}, refAction{kind: actPress, key: st.key})
	case stepRef:
		if act || st.action.kind == actPress || st.action.kind == actUpload {
			return f.actElement(ctx, s, map[string]any{"refId": st.refID}, st.action)
		}
		// batch.flow rejects refs at parse time; this path keeps the
		// extension's direct ref tools for completeness.
		switch st.action.kind {
		case actClick:
			return single("click_element", map[string]any{"refId": st.refID})
		case actCheck:
			return single("form_input", map[string]any{"refId": st.refID, "checked": st.action.checked})
		default:
			return single("form_input", map[string]any{"refId": st.refID, "value": st.action.value})
		}
	case stepNamed:
		return f.actElement(ctx, s, map[string]any{"role": st.role, "name": st.name}, st.action)
	case stepScroll:
		return single("scroll_element", map[string]any{"refId": st.refID, "direction": st.direction, "amount": st.amount})
	case stepWaitFor:
		return f.waitFor(ctx, s, st.cond, st.timeoutMs)
	case stepWaitMs:
		ms := min(st.ms, maxWaitMs)
		select {
		case <-ctx.Done():
			return nil, bridge.ErrCancelled
		case <-time.After(time.Duration(ms) * time.Millisecond):
			return map[string]any{"ms": ms}, nil
		}
	case stepReadText:
		if st.frameID == nil {
			if err := f.waitDocumentReady(ctx, s.TabID, s.Browser); err != nil {
				return nil, err
			}
			r, err := f.dispatch(ctx, "get_page_text", map[string]any{}, s.TabID, s.Browser)
			if err != nil {
				return nil, err
			}
			if err := failIfToolError("get_page_text", r); err != nil {
				return nil, err
			}
			return map[string]any{"text": textOf(decode(r.Result))}, nil
		}
		r, err := f.dispatch(ctx, "javascript_tool", javascriptArgs("document.body?.innerText ?? ''", true, st.frameID), s.TabID, s.Browser)
		if err != nil {
			return nil, err
		}
		if err := failIfToolError("javascript_tool", r); err != nil {
			return nil, err
		}
		text, err := javascriptStringResult(decode(r.Result))
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": text}, nil
	default: // dialog
		args := map[string]any{"accept": st.accept}
		if st.promptText != nil {
			args["promptText"] = *st.promptText
		}
		return single("dialog_answer", args)
	}
}

// actElement resolves the target, acts and waits for the page to settle in
// one extension call, returning refId and the visible changes.
func (f *Facade) actElement(ctx context.Context, s session, args map[string]any, action refAction) (map[string]any, error) {
	switch action.kind {
	case actClick:
		args["action"] = "click"
	case actFill:
		args["action"], args["value"] = "fill", action.value
	case actSelect:
		args["action"], args["value"] = "select", action.value
	case actCheck:
		args["action"], args["checked"] = "check", action.checked
	case actPress:
		args["action"], args["key"] = "press", action.key
	case actUpload:
		args["action"], args["paths"], args["drop"] = "upload", action.paths, action.drop
	}
	r, err := f.dispatch(ctx, "act_element", args, s.TabID, s.Browser)
	if err != nil {
		return nil, err
	}
	if err := failIfToolError("act_element", r); err != nil {
		return nil, err
	}
	text := textOf(decode(r.Result))
	var report map[string]any
	if json.Unmarshal([]byte(text), &report) != nil || report == nil {
		return nil, ToolFailedError{"act_element", "unexpected act_element result: " + text}
	}
	return report, nil
}

// waitFor waits until the condition holds or the timeout passes. Text
// conditions run on the watch probe (waitText); a ref condition polls the
// ref, and a check that fails transiently (a navigation in flight) counts as
// not yet met.
func (f *Facade) waitFor(ctx context.Context, s session, cond waitCondition, timeoutMs int64) (map[string]any, error) {
	started := time.Now()
	var met bool
	var lastError string
	var err error
	if cond.kind == "ref" {
		met, lastError, err = f.pollRefState(ctx, s, cond, started.Add(time.Duration(timeoutMs)*time.Millisecond))
	} else {
		met, lastError, err = f.waitText(ctx, s, cond, timeoutMs)
	}
	if err != nil {
		return nil, err
	}
	value := map[string]any{"met": met, "ms": time.Since(started).Milliseconds(), "condition": cond.describe()}
	if !met && lastError != "" {
		value["lastError"] = lastError
	}
	return value, nil
}

func (f *Facade) pollRefState(ctx context.Context, s session, cond waitCondition, deadline time.Time) (met bool, lastError string, err error) {
	for {
		ok, transient, err := f.refStateMet(ctx, s, cond)
		if err != nil || ok {
			return ok, "", err
		}
		lastError = transient
		now := time.Now()
		if !now.Before(deadline) {
			return false, lastError, nil
		}
		select {
		case <-ctx.Done():
			return false, "", bridge.ErrCancelled
		case <-time.After(min(waitPoll, deadline.Sub(now))):
		}
	}
}

// refStateMet: err means the wait cannot continue; transient names a check
// that failed and may succeed on the next poll.
func (f *Facade) refStateMet(ctx context.Context, s session, cond waitCondition) (met bool, transient string, err error) {
	r, err := f.dispatch(ctx, "get_element_info", map[string]any{"refId": cond.refID}, s.TabID, s.Browser)
	if err != nil {
		return false, "", err
	}
	if msg, failed := toolErrorMessage(r); failed {
		// A node that left the document is hidden; no other state can hold for it.
		if strings.Contains(msg, "Stale") {
			if cond.state == "hidden" {
				return true, "", nil
			}
			return false, "", ToolFailedError{"get_element_info", msg}
		}
		return false, msg, nil
	}
	var info map[string]any
	_ = json.Unmarshal([]byte(textOf(decode(r.Result))), &info)
	visible, disabled := info["visible"] == true, info["disabled"] == true
	switch cond.state {
	case "visible":
		return visible, "", nil
	case "hidden":
		return !visible, "", nil
	case "enabled":
		return !disabled, "", nil
	default:
		return disabled, "", nil
	}
}
