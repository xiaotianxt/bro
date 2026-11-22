package facade

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

func str(v any) string {
	s, _ := v.(string)
	return s
}

// RenderAct is the model-facing text for a browser.act result: the failure
// first (it survives error truncation), then the target, then one line per
// completed step.
func RenderAct(value map[string]any) string {
	value = toObject(value)
	results, _ := value["results"].([]any)
	entry := func(i int) map[string]any {
		m, _ := results[i].(map[string]any)
		return m
	}
	completed := len(results)
	var lines []string
	if n, ok := asInt(value["stoppedAt"]); ok {
		completed = int(n)
		e := entry(completed)
		target := ""
		if t := str(e["refId"]); t != "" {
			target = " " + t
		} else if t := str(e["target"]); t != "" {
			target = " " + t
		}
		kind, msg := str(e["type"]), str(e["error"])
		if kind == "" {
			kind = "step"
		}
		if _, ok := e["error"].(string); !ok {
			msg = "unknown error"
		}
		lines = append(lines, fmt.Sprintf("failed at step %d (%s%s): %s", completed+1, kind, target, msg))
	}
	lines = append(lines, "targetId: "+str(value["targetId"]))
	for i := range completed {
		e := entry(i)
		refID := str(e["refId"])
		element := refID
		if t, ok := e["target"].(string); ok {
			element = refID + " (" + t + ")"
		}
		kind := str(e["type"])
		changed := changesLine(kind, e["changes"])
		var line string
		switch kind {
		case "click":
			line = "clicked " + element + changed
		case "fill":
			line = "filled " + element + changed
		case "select":
			line = "selected " + element + changed
		case "check":
			if e["checked"] == false {
				line = "unchecked " + element + changed
			} else {
				line = "checked " + element + changed
			}
		case "upload":
			files, _ := e["files"].([]any)
			names := make([]string, len(files))
			for i, f := range files {
				names[i] = plain(f)
			}
			line = "uploaded " + strings.Join(names, ", ") + " to " + element + changed
		case "press":
			if element == "" {
				line = "pressed " + plain(e["key"]) + changed
			} else {
				line = "pressed " + plain(e["key"]) + " on " + element + changed
			}
		case "scroll":
			line = scrollLine(refID, e["result"])
		case "navigate":
			line = "navigated: " + plain(e["url"])
		case "evaluate":
			line = "evaluated: " + plain(e["result"])
		case "observe":
			line = "observed:\n" + plain(e["content"])
		case "wait":
			line = waitLine(e)
		case "dialog":
			line = "dialog: " + plain(e["result"])
		default:
			line = kind + ": " + jsonText(e)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n") + closedLine(value)
}

// changesLine is `→ opened …; alert …; text …` after an element action. A
// click with no visible effect says so, which tells the caller it likely
// missed; a fill or check usually changes nothing visible and then reports
// nothing.
func changesLine(kind string, changes any) string {
	report, ok := changes.(map[string]any)
	if !ok {
		return ""
	}
	list := func(key string) []string {
		items, _ := report[key].([]any)
		out := make([]string, len(items))
		for i, item := range items {
			out[i] = plain(item)
		}
		return out
	}
	var parts []string
	if u, ok := report["navigated"].(string); ok {
		parts = append(parts, "navigated to "+u)
	}
	if u, ok := report["navigating"].(string); ok {
		parts = append(parts, "navigating to "+u)
	}
	for _, kv := range [][2]string{{"opened", "opened"}, {"closed", "closed"}, {"alerts", "alert"}, {"dialogs", "dialog"}} {
		for _, item := range list(kv[0]) {
			parts = append(parts, kv[1]+" "+item)
		}
	}
	if added := list("added"); len(added) > 0 {
		for i, text := range added {
			added[i] = strconv.Quote(text)
		}
		parts = append(parts, "text "+strings.Join(added, ", "))
	}
	if controls := list("controls"); len(controls) > 0 {
		parts = append(parts, "controls "+strings.Join(controls, ", "))
	}
	if more, ok := report["moreControls"].(string); ok {
		parts = append(parts, more)
	}
	settled := ""
	if v, ok := report["settledMs"]; ok {
		settled = plain(v)
	}
	quiet := "settled"
	if report["quiet"] == false {
		quiet = "still changing"
	}
	switch {
	case len(parts) == 0 && kind != "click" && kind != "press":
		return ""
	case len(parts) == 0:
		return fmt.Sprintf(" → no visible change (%s %sms)", quiet, settled)
	default:
		return fmt.Sprintf(" → %s (%s %sms)", strings.Join(parts, "; "), quiet, settled)
	}
}

func waitLine(e map[string]any) string {
	ms, condition := plain(e["ms"]), plain(e["condition"])
	if e["met"] == true {
		return fmt.Sprintf("waited %sms until %s", ms, condition)
	}
	line := fmt.Sprintf("wait not met after %sms: %s", ms, condition)
	if msg, ok := e["lastError"].(string); ok {
		line += " (last check failed: " + strings.TrimPrefix(msg, "Error: ") + ")"
	}
	return line + "; continuing"
}

// scrollLine names the element that actually moved, which may be an ancestor
// or the document rather than the requested ref.
func scrollLine(refID string, result any) string {
	r, _ := result.(map[string]any)
	scrolled := refID
	if s, ok := r["scrolled"].(string); ok {
		scrolled = s
	}
	line := "scrolled " + scrolled
	if scrolled != refID {
		line += " (from " + refID + ")"
	}
	delta, _ := r["delta"].(map[string]any)
	var moved []string
	for _, axis := range [][2]string{{"dx", "x"}, {"dy", "y"}} {
		if d, ok := delta[axis[1]].(float64); ok {
			if d = math.Round(d); d != 0 {
				moved = append(moved, axis[0]+"="+strconv.FormatFloat(d, 'f', -1, 64))
			}
		}
	}
	if len(moved) == 0 {
		line += " without moving"
	} else {
		line += " " + strings.Join(moved, " ")
	}
	if r["boundary"] == true {
		line += "; at the end"
	}
	return line
}

// RenderObserve is the model-facing text for a browser.observe result.
func RenderObserve(value map[string]any) string {
	return plain(value["content"]) + closedLine(value)
}

func closedLine(value map[string]any) string {
	switch {
	case value["closed"] == true:
		return "\nclosed " + plain(value["targetId"])
	case value["released"] == true:
		return "\nreleased " + plain(value["targetId"]) + "; its tab stays open"
	}
	if msg, ok := value["closeError"].(string); ok {
		return "\nclose failed: " + msg + "; retry with browser.close"
	}
	return ""
}

// RenderOpen is the ids on one line, then the first observation.
func RenderOpen(value map[string]any) string {
	content, ok := value["content"]
	if !ok {
		return jsonText(value)
	}
	return fmt.Sprintf("targetId: %s  url: %s\n\n%s", plain(value["targetId"]), plain(value["url"]), plain(content))
}
