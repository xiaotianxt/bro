package facade

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// jsonText encodes v compactly with sorted keys and no HTML escaping.
func jsonText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(fmt.Sprintf("encode %T: %v", v, err))
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// plain is a string as is, anything else as JSON.
func plain(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return jsonText(v)
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// extractText finds the first text payload: a string, an object's text, the
// joined content[].text, or (depth-first, keys sorted) a nested one.
func extractText(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		return t, true
	case map[string]any:
		if s, ok := t["text"].(string); ok {
			return s, true
		}
		if content, ok := t["content"].([]any); ok {
			var parts []string
			for _, item := range content {
				if m, ok := item.(map[string]any); ok {
					if s, ok := m["text"].(string); ok {
						parts = append(parts, s)
					}
				}
			}
			if len(parts) > 0 {
				return strings.Join(parts, "\n"), true
			}
		}
		for _, k := range sortedKeys(t) {
			if s, ok := extractText(t[k]); ok {
				return s, true
			}
		}
	case []any:
		for _, item := range t {
			if s, ok := extractText(item); ok {
				return s, true
			}
		}
	}
	return "", false
}

func textOf(v any) string {
	s, _ := extractText(v)
	return s
}

func findStringKey(v any, key string) (string, bool) {
	switch t := v.(type) {
	case map[string]any:
		if s, ok := t[key].(string); ok {
			return s, true
		}
		for _, k := range sortedKeys(t) {
			if s, ok := findStringKey(t[k], key); ok {
				return s, true
			}
		}
	case []any:
		for _, item := range t {
			if s, ok := findStringKey(item, key); ok {
				return s, true
			}
		}
	}
	return "", false
}

func asInt(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || f != float64(int64(f)) {
		return 0, false
	}
	return int64(f), true
}

func findIntKey(v any, key string) (int64, bool) {
	switch t := v.(type) {
	case map[string]any:
		if n, ok := asInt(t[key]); ok {
			return n, true
		}
		for _, k := range sortedKeys(t) {
			if n, ok := findIntKey(t[k], key); ok {
				return n, true
			}
		}
	case []any:
		for _, item := range t {
			if n, ok := findIntKey(item, key); ok {
				return n, true
			}
		}
	}
	return 0, false
}

func extractTabID(v any) (int64, bool) {
	if n, ok := findIntKey(v, "tabId"); ok {
		return n, true
	}
	if n, ok := findIntKey(v, "id"); ok {
		return n, true
	}
	text, ok := extractText(v)
	if !ok {
		return 0, false
	}
	for _, line := range strings.Split(text, "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), "Created tab:")
		if !ok {
			continue
		}
		rest = strings.TrimLeft(rest, " \t")
		end := 0
		for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
			end++
		}
		if n, err := strconv.ParseInt(rest[:end], 10, 64); err == nil {
			return n, true
		}
	}
	return 0, false
}

// javascriptStringResult reads a javascript_tool reply: a JSON string is
// unquoted, other JSON is re-encoded, anything else is the raw text.
func javascriptStringResult(v any) (string, error) {
	text, ok := extractText(v)
	if !ok {
		return "", ToolFailedError{"javascript_tool", "frame read returned no text"}
	}
	var parsed any
	if json.Unmarshal([]byte(text), &parsed) != nil {
		return text, nil
	}
	if s, ok := parsed.(string); ok {
		return s, nil
	}
	return jsonText(parsed), nil
}

func javascriptArgs(code string, awaitPromise bool, frameID *string) map[string]any {
	args := map[string]any{"code": code, "awaitPromise": awaitPromise}
	if frameID != nil {
		args["frameId"] = *frameID
	}
	return args
}

type textQuality struct {
	ready bool
	score int
}

func hasPageText(text string) bool { return quality(text, defaultTextReadyMin).ready }

func quality(text string, minChars int) textQuality {
	text = strings.TrimSpace(text)
	if text == "" || text == "(no text content found)" || text == "Skip to main content" {
		return textQuality{}
	}
	chars := utf8.RuneCountInString(text)
	lines := 0
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) != "" {
			lines++
		}
	}
	tokens := 0
	for _, token := range strings.Fields(text) {
		if strings.IndexFunc(token, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) >= 0 {
			tokens++
		}
	}
	shell := isProbableNavShell(text)
	score := chars + lines*12 + tokens*4
	if shell {
		score = max(score-200, 0)
	}
	return textQuality{ready: chars >= minChars && tokens >= 12 && !shell, score: score}
}

// isLoadingPlaceholder is short text announcing content still on its way.
func isLoadingPlaceholder(text string) bool {
	text = strings.TrimSpace(text)
	lower := strings.ToLower(text)
	if utf8.RuneCountInString(text) >= 200 {
		return false
	}
	for _, marker := range []string{"loading", "please wait", "just a moment"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return strings.HasSuffix(text, "...") || strings.HasSuffix(text, "…")
}

func isProbableNavShell(text string) bool {
	lower := strings.ToLower(text)
	shell := false
	for _, marker := range []string{"skip to main content", "skip to navigation", "collapse navigation"} {
		if strings.Contains(lower, marker) {
			shell = true
		}
	}
	hits := 0
	for _, marker := range []string{"home", "notifications", "messaging", "my network", "for business", "primary content"} {
		if strings.Contains(lower, marker) {
			hits++
		}
	}
	content := false
	for _, marker := range []string{"feed post", "reaction button", "comment", "repost", "followers"} {
		if strings.Contains(lower, marker) {
			content = true
		}
	}
	return (shell && utf8.RuneCountInString(text) < defaultTextReadyMin) || (hits >= 4 && !content)
}

func truncateRunes(text string, n int) string {
	if utf8.RuneCountInString(text) <= n {
		return text
	}
	r := []rune(text)
	return string(r[:n])
}

// textPresentScript compares rendered main-frame text case- and
// whitespace-insensitively: CSS text-transform changes innerText but not the
// accessible name a model copies from an observation.
func textPresentScript(text string) string {
	return "(() => { const n = (s) => s.replace(/\\s+/g, ' ').trim().toLowerCase(); return n(document.body?.innerText ?? '').includes(n(" + jsonText(text) + ")); })()"
}

func clickScript(css string) string {
	return `(() => {
const selector = ` + jsonText(css) + `;
const element = document.querySelector(selector);
if (!element) throw new Error(` + "`No element matches selector: ${selector}`" + `);
element.click();
return true;
})()`
}

func fillScript(css, value string) string {
	return `(() => {
const selector = ` + jsonText(css) + `;
const value = ` + jsonText(value) + `;
const element = document.querySelector(selector);
if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
  throw new Error(` + "`No text input matches selector: ${selector}`" + `);
}
const prototype = element instanceof HTMLInputElement
  ? HTMLInputElement.prototype
  : HTMLTextAreaElement.prototype;
const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
element.focus();
if (setter) setter.call(element, value);
else element.value = value;
element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
element.dispatchEvent(new Event("change", { bubbles: true }));
return true;
})()`
}

func selectScript(css, value string) string {
	return `(() => {
const selector = ` + jsonText(css) + `;
const value = ` + jsonText(value) + `;
const element = document.querySelector(selector);
if (!(element instanceof HTMLSelectElement)) {
  throw new Error(` + "`No select element matches selector: ${selector}`" + `);
}
if (!Array.from(element.options).some((option) => option.value === value)) {
  throw new Error(` + "`Select option value not found: ${value}`" + `);
}
const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
if (setter) setter.call(element, value);
else element.value = value;
element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
element.dispatchEvent(new Event("change", { bubbles: true }));
return true;
})()`
}
