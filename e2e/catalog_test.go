package e2e

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite e2e/testdata snapshots")

// removedTools leave the surface with the Go server (docs/go-migration.md).
// They are excluded from the snapshot so it gates both implementations; the
// merged ones change kept schemas, which shows up as a reviewed snapshot diff.
var removedTools = map[string]bool{
	"browser.flow.start": true, "browser.flow.observe": true, "browser.flow.act": true, "browser.flow.finish": true,
	"browser.batch.run": true, "agent_done": true, "tabs_claim": true, "tabs_create_mcp": true, "tabs_context_mcp": true,
	"scroll_element": true, "gif_creator": true, "shortcuts_list": true, "shortcuts_execute": true,
	"get_response_body": true, "extract_page": true,
	// Merged into browser.extract / browser.click / browser.fill.
	"browser.current.extract": true, "click_element": true, "fill_element": true, "form_input": true,
}

// Tool names, descriptions, schemas and _meta are model- and adapter-facing:
// the Pi adapter reads capability and default-catalog metadata from _meta.
func TestToolCatalogSnapshot(t *testing.T) {
	s := startServer(t)
	c := s.client(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := c.session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	kept := map[string]any{}
	for _, tool := range list.Tools {
		if !removedTools[tool.Name] {
			kept[tool.Name] = tool
		}
	}
	got, err := json.MarshalIndent(kept, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	path := filepath.Join("testdata", "tools.json")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to create it)", err)
	}
	if string(got) != string(want) {
		var gotTools, wantTools map[string]json.RawMessage
		_ = json.Unmarshal(got, &gotTools)
		_ = json.Unmarshal(want, &wantTools)
		var diff []string
		for name := range gotTools {
			if string(gotTools[name]) != string(wantTools[name]) {
				diff = append(diff, name)
			}
		}
		for name := range wantTools {
			if _, ok := gotTools[name]; !ok {
				diff = append(diff, name+" (missing)")
			}
		}
		sort.Strings(diff)
		t.Fatalf("tool catalog differs from %s for %v; review and rerun with -update", path, diff)
	}
}
