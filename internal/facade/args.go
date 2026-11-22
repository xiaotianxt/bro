package facade

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// parseArgs decodes tool arguments strictly: unknown fields are rejected.
func parseArgs(args map[string]any, out any) error {
	data, err := json.Marshal(args)
	if err != nil {
		return invalid("%v", err)
	}
	return decodeStrict(data, out)
}

func decodeStrict(data []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return invalid("%s", strings.TrimPrefix(err.Error(), "json: "))
	}
	return nil
}

// fields checks a decoded object against its allowed keys and required ones.
func fields(obj map[string]json.RawMessage, allowed []string, required ...string) error {
	set := map[string]bool{}
	for _, k := range allowed {
		set[k] = true
	}
	for k := range obj {
		if !set[k] {
			return fmt.Errorf("unknown field `%s`, expected one of %s", k, strings.Join(allowed, ", "))
		}
	}
	for _, k := range required {
		if _, ok := obj[k]; !ok {
			return fmt.Errorf("missing field `%s`", k)
		}
	}
	return nil
}

func checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return invalid("invalid navigation URL: %v", err)
	}
	if u.Scheme == "" {
		return invalid("invalid navigation URL: relative URL without a base")
	}
	return nil
}

// observeOptions are a11y or text observation parameters.
type observeOptions struct {
	Mode     string // "a11y" or "text"
	RefID    *string
	Filter   string
	Depth    int
	MaxChars *int
	Cursor   *int
	Compact  bool
}

type rawObserve struct {
	Mode     *string `json:"mode"`
	RefID    *string `json:"refId"`
	Filter   *string `json:"filter"`
	Depth    *int    `json:"depth"`
	MaxChars *int    `json:"maxChars"`
	Cursor   *int    `json:"cursor"`
	Compact  *bool   `json:"compact"`
}

var observeFields = []string{"mode", "refId", "filter", "depth", "maxChars", "cursor", "compact"}

func (raw rawObserve) options() (observeOptions, error) {
	o := observeOptions{Mode: "a11y", Filter: "all", Depth: 20, Compact: true, RefID: raw.RefID, MaxChars: raw.MaxChars, Cursor: raw.Cursor}
	if raw.Mode != nil {
		if *raw.Mode != "a11y" && *raw.Mode != "text" {
			return o, fmt.Errorf("unknown variant `%s`, expected `text` or `a11y`", *raw.Mode)
		}
		o.Mode = *raw.Mode
	}
	if raw.Filter != nil {
		if *raw.Filter != "all" && *raw.Filter != "interactive" {
			return o, fmt.Errorf("unknown variant `%s`, expected `all` or `interactive`", *raw.Filter)
		}
		o.Filter = *raw.Filter
	}
	if o.Mode == "text" && (raw.RefID != nil || raw.Filter != nil || raw.Depth != nil || raw.Compact != nil) {
		return o, fmt.Errorf("refId/filter/depth/compact require mode a11y")
	}
	if raw.Depth != nil {
		o.Depth = *raw.Depth
	}
	if raw.Compact != nil {
		o.Compact = *raw.Compact
	}
	if o.Depth < 1 || o.Depth > 100 ||
		(raw.MaxChars != nil && (*raw.MaxChars < 1 || *raw.MaxChars > 60000)) ||
		(raw.Cursor != nil && (*raw.Cursor < 0 || *raw.Cursor > 1_000_000)) ||
		(raw.RefID != nil && strings.TrimSpace(*raw.RefID) == "") {
		return o, fmt.Errorf("observation requires depth 1–100, maxChars 1–60000, cursor 0–1000000 and a nonempty refId when supplied")
	}
	return o, nil
}

// withinCeiling rejects over-ceiling budgets, matching the schema; a11y above
// its cap is reduced.
func (o observeOptions) withinCeiling() (observeOptions, error) {
	if o.MaxChars != nil && *o.MaxChars > maxObserveChars {
		return o, invalid("maxChars is at most %d; read long content with mode text and cursor", maxObserveChars)
	}
	if o.Mode == "a11y" && o.MaxChars != nil && *o.MaxChars > maxA11yObserveChars {
		capped := maxA11yObserveChars
		o.MaxChars = &capped
	}
	return o, nil
}

// readPageArgs are the extension's read_page arguments.
func (o observeOptions) readPageArgs() map[string]any {
	args := map[string]any{"filter": o.Filter, "depth": o.Depth, "compact": o.Compact}
	if o.RefID != nil {
		args["refId"] = *o.RefID
	}
	if o.MaxChars != nil {
		args["maxChars"] = *o.MaxChars
	}
	if o.Cursor != nil {
		args["cursor"] = *o.Cursor
	}
	return args
}

// observeOption parses open/attach `observe`: false skips the first
// observation; true or absent observes with defaults; an object observes
// with those options.
func observeOption(raw json.RawMessage) (*observeOptions, error) {
	trimmed := bytes.TrimSpace(raw)
	switch {
	case len(trimmed) == 0 || string(trimmed) == "null" || string(trimmed) == "true":
		trimmed = []byte("{}")
	case string(trimmed) == "false":
		return nil, nil
	case trimmed[0] != '{':
		return nil, invalid("observe must be a boolean or an observation object")
	}
	var r rawObserve
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return nil, invalid("observe: %s", strings.TrimPrefix(err.Error(), "json: "))
	}
	o, err := r.options()
	if err != nil {
		return nil, invalid("observe: %v", err)
	}
	o, err = o.withinCeiling()
	if err != nil {
		return nil, err
	}
	return &o, nil
}
