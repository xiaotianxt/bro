// Package catalog is bro's MCP tool surface. tools.json holds each tool's
// model- and adapter-facing definition (description, schema, _meta); this file
// decides how a call is routed.
package catalog

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed tools.json
var toolsJSON []byte

// Route says who handles a tool call.
type Route int

const (
	// Forward sends the call to the extension unchanged except for browserId.
	Forward Route = iota
	// ForwardTab is Forward with tabId moved into the envelope; tabId is required.
	ForwardTab
	FileUpload
	BrowsersContext
	FindLogins
	InspectLogin
	FillLogin
	BatchFlow
	Extract
	BatchExtract
	ConsoleCapture
	NetworkCapture
	Open
	Attach
	Observe
	Act
	Click
	Fill
	Press
	Close
)

var routes = map[string]Route{
	"browsers_context":        BrowsersContext,
	"onepassword_find_logins": FindLogins,
	"login_form_inspect":      InspectLogin,
	"onepassword_fill_login":  FillLogin,
	"browser.batch.flow":      BatchFlow,
	"browser.extract":         Extract,
	"browser.batch.extract":   BatchExtract,
	"browser.console.capture": ConsoleCapture,
	"browser.network.capture": NetworkCapture,
	"browser.open":            Open,
	"browser.attach":          Attach,
	"browser.observe":         Observe,
	"browser.act":             Act,
	"browser.click":           Click,
	"browser.fill":            Fill,
	"browser.press":           Press,
	"browser.close":           Close,
	"file_upload":             FileUpload,
	// Tab tools: tabId travels in the envelope.
	"computer": ForwardTab, "navigate": ForwardTab, "resize_window": ForwardTab,
	"read_page": ForwardTab, "find": ForwardTab, "frames_list": ForwardTab,
	"debugger_diagnose": ForwardTab, "javascript_tool": ForwardTab, "get_page_text": ForwardTab,
	"get_element_info": ForwardTab, "wait_for_element": ForwardTab,
	"read_console_messages": ForwardTab, "read_network_requests": ForwardTab,
}

// Tools returns the tool definitions in published order.
func Tools() []*mcp.Tool {
	var tools []*mcp.Tool
	if err := json.Unmarshal(toolsJSON, &tools); err != nil {
		panic(fmt.Sprintf("embedded tools.json is invalid: %v", err))
	}
	return tools
}

// RouteFor returns the route of a published tool; every tool in tools.json
// without an explicit route is forwarded as is.
func RouteFor(name string) Route { return routes[name] }

// CanonicalUploadPath checks one upload path and returns its canonical form,
// so the browser reads exactly the regular file checked here. The browser
// runs on this machine (bro binds to localhost), so these paths are its paths.
// tool names the caller in errors.
func CanonicalUploadPath(tool, raw string) (string, error) {
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("%s path must be absolute: %s", tool, raw)
	}
	canonical, err := filepath.EvalSymlinks(raw)
	if err == nil {
		canonical, err = filepath.Abs(canonical)
	}
	if err != nil {
		return "", fmt.Errorf("%s cannot open %s: %v", tool, raw, err)
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", fmt.Errorf("%s cannot open %s: %v", tool, raw, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s path is not a regular file: %s", tool, raw)
	}
	return canonical, nil
}

var known = func() map[string]bool {
	set := map[string]bool{}
	for _, tool := range Tools() {
		set[tool.Name] = true
	}
	return set
}()

// Known reports whether name is a published tool.
func Known(name string) bool { return known[name] }
