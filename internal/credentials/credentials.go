// Package credentials implements scoped 1Password reads and private browser
// fill. Provider output and secret values never enter public tool arguments,
// results, logs or errors: every error is a fixed string.
package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/net/idna"
	"golang.org/x/net/publicsuffix"

	"github.com/xiaotianxt/bro/internal/bridge"
)

// failure is a fixed, value-free message.
type failure string

func (f failure) Error() string { return string(f) }

const errArgs failure = "Invalid login tool arguments"

func parse(args map[string]any, out any) error {
	data, err := json.Marshal(args)
	if err != nil {
		return errArgs
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(out) != nil {
		return errArgs
	}
	return nil
}

// item holds provider-owned strings; it is never logged or returned whole.
type item struct {
	ID                    string `json:"id"`
	Title                 string `json:"title"`
	AdditionalInformation string `json:"additional_information"`
	Vault                 struct {
		ID string `json:"id"`
	} `json:"vault"`
	URLs []struct {
		Href string `json:"href"`
	} `json:"urls"`
	Fields []struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	} `json:"fields"`
	Category string `json:"category"`
}

type page struct {
	scheme, host string
	port         string // effective port
}

func (p page) origin() string {
	defaultPort := map[string]string{"https": "443", "http": "80"}[p.scheme]
	if p.port == defaultPort {
		return p.scheme + "://" + p.host
	}
	return p.scheme + "://" + p.host + ":" + p.port
}

func checkedURL(input string) (page, error) {
	u, err := url.Parse(input)
	if err != nil || u.Scheme == "" || u.Opaque != "" {
		return page{}, failure("Expected an absolute HTTPS URL")
	}
	if u.User != nil {
		return page{}, failure("URL must not contain credentials")
	}
	host := strings.ToLower(u.Hostname())
	scheme := strings.ToLower(u.Scheme)
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if scheme != "https" && (scheme != "http" || !local) {
		return page{}, failure("HTTPS is required except on literal loopback hosts")
	}
	if host == "" {
		return page{}, failure("URL has no hostname")
	}
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		host = ascii
	} else if !strings.Contains(host, ":") {
		return page{}, failure("Expected an absolute HTTPS URL")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"https": "443", "http": "80"}[scheme]
	}
	return page{scheme: scheme, host: host, port: port}, nil
}

// match is ordered best first: an exact origin outranks a sibling host.
type match int

const (
	noMatch match = iota
	exact
	sameSite
)

func (m match) label() string {
	if m == exact {
		return "exact-origin"
	}
	return "same-site"
}

// site is the registrable domain (eTLD+1) from the Public Suffix List,
// private section included, so a.github.io and b.github.io are different
// sites. IP addresses and bare public suffixes have none and only match
// exactly.
func site(p page) string {
	if strings.HasPrefix(p.host, "[") || isIPv4(p.host) {
		return ""
	}
	domain, err := publicsuffix.EffectiveTLDPlusOne(p.host)
	if err != nil {
		return ""
	}
	return domain
}

func isIPv4(host string) bool {
	return strings.Count(host, ".") == 3 && strings.Trim(host, "0123456789.") == ""
}

// websiteMatch mirrors 1Password's default "Fill anywhere on this website":
// the saved and page URLs share scheme, effective port and registrable domain.
func websiteMatch(href string, p page) match {
	// 1Password stores bare hosts such as pnc.com and treats them as HTTPS.
	saved, err := checkedURL(href)
	if err != nil {
		if saved, err = checkedURL("https://" + href); err != nil {
			return noMatch
		}
	}
	if saved.origin() == p.origin() {
		return exact
	}
	if saved.scheme == p.scheme && saved.port == p.port && site(saved) != "" && site(saved) == site(p) {
		return sameSite
	}
	return noMatch
}

func itemMatch(it *item, p page) match {
	best := noMatch
	for _, u := range it.URLs {
		if m := websiteMatch(u.Href, p); m != noMatch && (best == noMatch || m < best) {
			best = m
		}
	}
	return best
}

func identifier(v string) bool {
	return len(v) == 26 && strings.Trim(v, "abcdefghijklmnopqrstuvwxyz0123456789") == ""
}

func scope(v *string) error {
	if v != nil && (*v == "" || strings.HasPrefix(*v, "-") || len(*v) > 256 || strings.IndexFunc(*v, unicode.IsControl) >= 0) {
		return failure("Invalid account or vault scope")
	}
	return nil
}

// opPath: launchd's PATH need not contain Homebrew. Never accept an
// executable path from a model-facing request or invoke a shell with
// provider arguments.
func opPath() string {
	if runtime.GOOS == "darwin" {
		for _, p := range []string{"/opt/homebrew/bin/op", "/usr/local/bin/op"} {
			if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() {
				return p
			}
		}
	}
	return "op"
}

func provider(ctx context.Context, arguments []string, account *string, limit int64) ([]byte, error) {
	if err := scope(account); err != nil {
		return nil, err
	}
	executable, err := providerExecutable()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	args := append(append([]string{}, arguments...), "--format", "json")
	if account != nil {
		args = append(args, "--account", *account)
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	env := []string{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "OP_INCLUDE_ARCHIVE=") {
			env = append(env, kv)
		}
	}
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, failure("1Password CLI output unavailable")
	}
	if err := cmd.Start(); err != nil {
		return nil, failure("1Password CLI unavailable to bro; install op or check its executable permissions")
	}
	output, readErr := io.ReadAll(io.LimitReader(stdout, limit+1))
	if int64(len(output)) > limit {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, failure("1Password output too large; narrow the vault scope")
	}
	waitErr := cmd.Wait()
	switch {
	case ctx.Err() != nil:
		return nil, failure("1Password CLI authorization/read timed out; no automatic retry")
	case readErr != nil:
		return nil, failure("1Password CLI read failed")
	case waitErr != nil:
		return nil, failure("1Password CLI refused the request. Unlock/approve CLI access in 1Password and verify the account, vault and item selection. Raw provider output was withheld.")
	}
	return output, nil
}

// Find lists Login items whose saved websites are on the page's site.
// Returns metadata only; no credential is read.
func Find(ctx context.Context, args map[string]any) (any, error) {
	var a struct {
		URL                   *string `json:"url"`
		Vault                 *string `json:"vault"`
		Account               *string `json:"account"`
		ConfirmMetadataSearch *bool   `json:"confirmMetadataSearch"`
	}
	if err := parse(args, &a); err != nil || a.URL == nil || a.ConfirmMetadataSearch == nil {
		return nil, errArgs
	}
	if !*a.ConfirmMetadataSearch {
		return nil, failure("Explicit confirmMetadataSearch is required to search login metadata locally")
	}
	p, err := checkedURL(*a.URL)
	if err != nil {
		return nil, err
	}
	if err := scope(a.Vault); err != nil {
		return nil, err
	}
	command := []string{"item", "list", "--categories", "Login"}
	if a.Vault != nil {
		command = append(command, "--vault", *a.Vault)
	}
	output, err := provider(ctx, command, a.Account, 4*1024*1024)
	if err != nil {
		return nil, err
	}
	var items []item
	if json.Unmarshal(output, &items) != nil {
		return nil, failure("Invalid 1Password metadata response")
	}
	type matched struct {
		kind match
		it   *item
	}
	var found []matched
	for i := range items {
		if m := itemMatch(&items[i], p); m != noMatch {
			found = append(found, matched{m, &items[i]})
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].kind < found[j].kind })
	candidates := []any{}
	for _, m := range found {
		// Username lets the user pick an account by name; it is metadata, not a secret.
		candidates = append(candidates, map[string]any{
			"itemId": m.it.ID, "vaultId": m.it.Vault.ID,
			"title":    truncate(m.it.Title, 120),
			"username": truncate(m.it.AdditionalInformation, 120),
			"match":    m.kind.label(),
		})
	}
	var siteValue any
	if s := site(p); s != "" {
		siteValue = s
	}
	result := map[string]any{"origin": p.origin(), "site": siteValue, "candidates": candidates, "matching": "same-site", "credentialsRead": false}
	if len(found) == 0 {
		// Without this, agents fall back to raw `op` output or native-UI automation.
		result["next"] = "No saved website is on this site, so no item can be filled here. Do not run op directly, list items by title, or drive the 1Password UI as a workaround. Tell the user, and ask them to add this site's URL to the intended item in 1Password (or fill it themselves), then search again."
	}
	return result, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// connection pins every private call of one operation to the browser's
// current authenticated connection.
func connection(b *bridge.Bridge, browserID string, tabID int64) (bridge.Target, error) {
	if tabID <= 0 {
		return bridge.Target{}, failure("Explicit positive tabId is required")
	}
	if browserID == "" {
		return bridge.Target{}, failure("Pinned browser is not connected")
	}
	target, err := b.Bind(browserID)
	if err != nil {
		return bridge.Target{}, failure("Pinned browser is not connected")
	}
	return target, nil
}

func privateCall(ctx context.Context, b *bridge.Bridge, tool string, args any, target bridge.Target, tabID int64) (map[string]any, error) {
	reply, err := target.Dispatch(ctx, b, tool, args, &tabID)
	if err != nil {
		return nil, failure("Login browser operation failed; inspect state before any retry")
	}
	if reply.IsError {
		return nil, failure("Login browser operation failed; no credentials or raw error returned")
	}
	var envelope struct {
		Content []struct {
			Text *string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(reply.Result, &envelope) != nil || len(envelope.Content) == 0 || envelope.Content[0].Text == nil {
		return nil, failure("Invalid private login response")
	}
	var value map[string]any
	if json.Unmarshal([]byte(*envelope.Content[0].Text), &value) != nil || value == nil {
		return nil, failure("Invalid private login response")
	}
	return value, nil
}

func safeStatus(value map[string]any) (string, error) {
	status, _ := value["status"].(string)
	switch status {
	case "ready", "filled":
		return status, nil
	case "cancelled":
		return "", failure("Login authorization was cancelled or consumed; no automatic retry")
	case "origin_changed":
		return "", failure("Login origin changed; no fill authorized")
	case "stale_form":
		return "", failure("Login form changed; inspect a fresh form before choosing targets")
	case "expired":
		return "", failure("Login form expired; inspect again, do not replay automatically")
	case "field_not_empty":
		return "", failure("Target field is nonempty; refusing to overwrite user input")
	case "invalid_field":
		return "", failure("Invalid login field selection; use visible username/password fields, not new-password or OTP fields")
	case "fill_unverified":
		return "", failure("Fill dispatched but not verified; inspect outcome without reading field values, do not replay")
	default:
		return "", failure("Login operation unavailable or failed; no automatic fallback or retry")
	}
}

// tokenShaped: page-authored strings pass only in the token shapes the
// extension emits.
func tokenShaped(v string) bool {
	return len(v) >= 1 && len(v) <= 100 && strings.IndexFunc(v, func(r rune) bool {
		return !(r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'))
	}) < 0
}

// Inspect describes the main-frame login form by index and type only.
func Inspect(ctx context.Context, b *bridge.Bridge, args map[string]any) (any, error) {
	var a struct {
		BrowserID *string `json:"browserId"`
		TabID     *int64  `json:"tabId"`
	}
	if err := parse(args, &a); err != nil || a.BrowserID == nil || a.TabID == nil {
		return nil, errArgs
	}
	target, err := connection(b, *a.BrowserID, *a.TabID)
	if err != nil {
		return nil, err
	}
	value, err := privateCall(ctx, b, "__bro_login_inspect", map[string]any{}, target, *a.TabID)
	if err != nil {
		return nil, err
	}
	if _, err := safeStatus(value); err != nil {
		return nil, err
	}
	rawOrigin, ok := value["origin"].(string)
	if !ok {
		return nil, failure("Missing login origin")
	}
	p, err := checkedURL(rawOrigin)
	if err != nil {
		return nil, err
	}
	document, ok := value["documentId"].(string)
	if !ok {
		return nil, failure("Missing login document")
	}
	token, ok := value["formToken"].(string)
	if !ok {
		return nil, failure("Missing form token")
	}
	fields, ok := textFields(value, "fields")
	if !ok {
		return nil, failure("Missing login controls")
	}
	hidden, _ := textFields(value, "hiddenFields")
	switchers := []any{}
	rawSwitchers, _ := value["accountSwitchers"].([]any)
	for _, raw := range rawSwitchers[:min(len(rawSwitchers), 5)] {
		s, _ := raw.(map[string]any)
		kind, _ := s["kind"].(string)
		if kind != "select" && kind != "button" {
			continue
		}
		var css, option any
		if c, ok := s["css"].(string); ok {
			if id, ok := strings.CutPrefix(c, "#"); ok && tokenShaped(id) {
				css = c
			}
		}
		if o, ok := s["optionValue"].(string); ok && tokenShaped(o) {
			option = o
		}
		switchers = append(switchers, map[string]any{"kind": kind, "css": css, "optionValue": option})
	}
	has := func(list []map[string]any, password bool) bool {
		for _, f := range list {
			if (f["type"] == "password") == password {
				return true
			}
		}
		return false
	}
	result := map[string]any{"origin": p.origin(), "documentId": document, "formToken": token, "fields": fields,
		"hiddenFields": hidden, "accountSwitchers": switchers,
		"expiresInSeconds": 120, "scope": "main-frame", "valuesRead": false}
	if has(fields, true) && !has(fields, false) && (has(hidden, false) || len(switchers) > 0) {
		result["hint"] = "Username input is hidden: the page likely shows a remembered account. Fill the password alone for that account, or use an accountSwitchers control (select optionValue / click) to choose another user, then inspect again. Do not debug the DOM first."
	}
	if frames, ok := value["frames"].(float64); ok && len(fields) == 0 && frames >= 1 && frames == float64(int64(frames)) {
		result["frames"] = int64(frames)
		result["hint"] = "No fillable main-frame inputs, but the page has visible iframes: the login form is likely embedded (fill does not reach iframes). Navigate this tab to the site's top-level sign-in page and inspect again."
	}
	return result, nil
}

// textFields keeps only index and type: never labels, names, values or
// autocomplete text.
func textFields(value map[string]any, key string) ([]map[string]any, bool) {
	raw, ok := value[key].([]any)
	if !ok {
		return []map[string]any{}, false
	}
	fields := []map[string]any{}
	for _, f := range raw {
		m, _ := f.(map[string]any)
		index, ok := m["index"].(float64)
		if !ok || index < 0 || index != float64(int64(index)) {
			continue
		}
		switch kind, _ := m["type"].(string); kind {
		case "text", "email", "tel", "password":
			fields = append(fields, map[string]any{"index": int64(index), "type": kind})
		}
	}
	return fields, true
}

func expiry() int64 { return time.Now().UnixMilli() + 10_000 }

// Fill fills the selected login into the inspected form without submitting.
func Fill(ctx context.Context, b *bridge.Bridge, args map[string]any) (any, error) {
	var a struct {
		BrowserID      *string `json:"browserId"`
		TabID          *int64  `json:"tabId"`
		DocumentID     *string `json:"documentId"`
		FormToken      *string `json:"formToken"`
		ExpectedOrigin *string `json:"expectedOrigin"`
		ItemID         *string `json:"itemId"`
		VaultID        *string `json:"vaultId"`
		Account        *string `json:"account"`
		UsernameIndex  *uint   `json:"usernameIndex"`
		PasswordIndex  *uint   `json:"passwordIndex"`
		ConfirmFill    *bool   `json:"confirmFill"`
	}
	if err := parse(args, &a); err != nil || a.BrowserID == nil || a.TabID == nil || a.DocumentID == nil ||
		a.FormToken == nil || a.ExpectedOrigin == nil || a.ItemID == nil || a.VaultID == nil || a.ConfirmFill == nil {
		return nil, errArgs
	}
	if !*a.ConfirmFill {
		return nil, failure("Explicit confirmFill required for the selected login and origin")
	}
	if !identifier(*a.ItemID) || !identifier(*a.VaultID) {
		return nil, failure("Select exact itemId and vaultId returned by onepassword_find_logins")
	}
	if a.UsernameIndex == nil && a.PasswordIndex == nil {
		return nil, failure("Select at least one input index from login_form_inspect")
	}
	p, err := checkedURL(*a.ExpectedOrigin)
	if err != nil {
		return nil, err
	}
	expected := p.origin()
	if expected != *a.ExpectedOrigin {
		return nil, failure("expectedOrigin must be a canonical origin without a path or query")
	}
	target, err := connection(b, *a.BrowserID, *a.TabID)
	if err != nil {
		return nil, err
	}
	request := map[string]any{"expectedOrigin": expected, "documentId": *a.DocumentID,
		"formToken": *a.FormToken, "checkOnly": true, "expiresAt": expiry()}
	if a.UsernameIndex != nil {
		request["usernameIndex"] = *a.UsernameIndex
	}
	if a.PasswordIndex != nil {
		request["passwordIndex"] = *a.PasswordIndex
	}
	checked, err := privateCall(ctx, b, "__bro_login_fill", request, target, *a.TabID)
	if err != nil {
		return nil, err
	}
	if status, err := safeStatus(checked); err != nil {
		return nil, err
	} else if status != "ready" {
		return nil, failure("Invalid login preflight response")
	}
	output, err := provider(ctx, []string{"item", "get", *a.ItemID, "--vault", *a.VaultID, "--reveal"}, a.Account, 256*1024)
	if err != nil {
		return nil, err
	}
	var it item
	if json.Unmarshal(output, &it) != nil {
		return nil, failure("Invalid 1Password item response")
	}
	if it.ID != *a.ItemID || it.Vault.ID != *a.VaultID || it.Category != "LOGIN" {
		return nil, failure("Selected login does not match the requested item or vault; refusing to fill")
	}
	// Re-checked on the freshly read item: its saved URLs may have changed since discovery.
	matched := itemMatch(&it, p)
	if matched == noMatch {
		return nil, failure("Selected login's saved websites are not on this page's site; refusing to fill")
	}
	for _, sel := range []struct {
		index *uint
		id    string
	}{{a.UsernameIndex, "username"}, {a.PasswordIndex, "password"}} {
		if sel.index == nil {
			continue
		}
		var values []string
		for _, f := range it.Fields {
			if f.ID == sel.id && f.Value != "" {
				values = append(values, f.Value)
			}
		}
		if len(values) != 1 {
			return nil, failure("Selected login lacks a unique requested credential field. Passkeys are not supported by this password-fill path.")
		}
		request[sel.id] = values[0]
	}
	request["checkOnly"] = false
	request["expiresAt"] = expiry()
	result, err := privateCall(ctx, b, "__bro_login_fill", request, target, *a.TabID)
	if err != nil {
		return nil, err
	}
	if status, err := safeStatus(result); err != nil {
		return nil, err
	} else if status != "filled" {
		return nil, failure("Unexpected fill result; inspect state before any retry")
	}
	return map[string]any{"filled": true, "submitDispatched": false, "match": matched.label(),
		"note": "No submit was dispatched by bro. The destination site can read and react to filled values. Do not inspect values or capture secret-bearing logs/screenshots; verify navigation before submitting separately."}, nil
}
