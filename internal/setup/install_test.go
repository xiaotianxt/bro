package setup

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/xiaotianxt/bro/internal/nativehost"
)

func TestStablePathMapsAHomebrewKegToItsOptLink(t *testing.T) {
	prefix := t.TempDir()
	keg := filepath.Join(prefix, "Cellar", "bro", "2.3.0", "bin", "bro")
	opt := filepath.Join(prefix, "opt", "bro", "bin", "bro")
	if got := stablePath(keg); got != keg {
		t.Fatalf("without an opt link: %s", got)
	}
	if err := os.MkdirAll(filepath.Dir(opt), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(opt, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := stablePath(keg); got != opt {
		t.Fatalf("stablePath = %s, want %s", got, opt)
	}
	other := filepath.Join(prefix, "bin", "bro")
	if got := stablePath(other); got != other {
		t.Fatalf("non-keg path changed: %s", got)
	}
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInstallExtensionMirrorsThePackagedTree(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src"), filepath.Join(dir, "dst")
	writeTree(t, src, map[string]string{"manifest.json": `{"version":"1"}`, "chunks/a.js": "a"})
	if changed, err := InstallExtension(src, dst); err != nil || !changed {
		t.Fatalf("first install: changed=%v err=%v", changed, err)
	}
	if changed, err := InstallExtension(src, dst); err != nil || changed {
		t.Fatalf("same tree: changed=%v err=%v", changed, err)
	}
	// An upgrade drops a file and changes another: the copy matches exactly.
	if err := os.RemoveAll(src); err != nil {
		t.Fatal(err)
	}
	writeTree(t, src, map[string]string{"manifest.json": `{"version":"2"}`, "chunks/b.js": "b"})
	if changed, err := InstallExtension(src, dst); err != nil || !changed {
		t.Fatalf("upgrade: changed=%v err=%v", changed, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "chunks", "a.js")); !os.IsNotExist(err) {
		t.Fatalf("stale file survived the upgrade: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(dst, "manifest.json")); string(data) != `{"version":"2"}` {
		t.Fatalf("manifest = %s", data)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("staging directories left behind: %v", entries)
	}
}

func TestInstallNativeHostRegistersOnlyInstalledBrowsers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows registers through the registry")
	}
	appData := t.TempDir()
	browsers := linuxBrowsers
	if runtime.GOOS == "darwin" {
		browsers = macBrowsers
	}
	present := browsers[0]
	if err := os.MkdirAll(filepath.Join(appData, filepath.FromSlash(present.dataDir)), 0o755); err != nil {
		t.Fatal(err)
	}
	report, err := InstallNativeHost("/opt/bro/bin/bro", appData)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Browsers) != 1 || report.Browsers[0] != present.Name {
		t.Fatalf("browsers = %v", report.Browsers)
	}
	data, err := os.ReadFile(filepath.Join(appData, filepath.FromSlash(present.dataDir), "NativeMessagingHosts", nativehost.Name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Name           string   `json:"name"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if m.Name != nativehost.Name || m.Path != "/opt/bro/bin/bro" || m.Type != "stdio" ||
		len(m.AllowedOrigins) != 1 || m.AllowedOrigins[0] != "chrome-extension://"+nativehost.ExtensionIDs[0]+"/" {
		t.Fatalf("manifest = %+v", m)
	}
	if _, err := os.Stat(filepath.Join(appData, filepath.FromSlash(browsers[1].dataDir))); !os.IsNotExist(err) {
		t.Fatalf("created a directory for an absent browser: %v", err)
	}
}

// The pinned ID must be the one Chrome derives from the manifest key, or the
// native host would refuse the extension it is meant for.
func TestExtensionIDMatchesTheManifestKey(t *testing.T) {
	data, err := os.ReadFile("../../extension/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if got := extensionIDFromKey(t, m.Key); got != nativehost.ExtensionIDs[0] {
		t.Fatalf("manifest key gives %s, pinned %s", got, nativehost.ExtensionIDs[0])
	}
}

func TestConfigureJSONClientKeepsOtherServers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "claude_desktop_config.json")
	if err := os.WriteFile(path, []byte(`{"globalShortcut":"x","mcpServers":{"other":{"command":"o"},"bro":{"command":"/old/bro","args":["mcp"]}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	updated, existed, err := ConfigureJSONClient(path, "/opt/bro/bin/bro", []string{"mcp"})
	if err != nil || !updated || !existed {
		t.Fatalf("updated=%v existed=%v err=%v", updated, existed, err)
	}
	var doc map[string]any
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	servers := doc["mcpServers"].(map[string]any)
	if doc["globalShortcut"] != "x" || servers["other"] == nil || servers["bro"].(map[string]any)["command"] != "/opt/bro/bin/bro" {
		t.Fatalf("config = %s", data)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	if updated, _, err := ConfigureJSONClient(path, "/opt/bro/bin/bro", []string{"mcp"}); err != nil || updated {
		t.Fatalf("second run: updated=%v err=%v", updated, err)
	}
}

func TestConfigureJSONClientRefusesAFileItCannotParse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	if err := os.WriteFile(path, []byte(`{"mcpServers": {,}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ConfigureJSONClient(path, "/bro", []string{"mcp"}); err == nil {
		t.Fatal("expected an error")
	}
	if data, _ := os.ReadFile(path); string(data) != `{"mcpServers": {,}}` {
		t.Fatalf("file changed: %s", data)
	}
}

func TestServiceDefinitionsQuoteArguments(t *testing.T) {
	args := []string{"/Users/a b/bro&co", "serve"}
	if plist := launchdPlist(args, "/tmp/log"); !strings.Contains(plist, "<string>/Users/a b/bro&amp;co</string>") {
		t.Fatalf("plist:\n%s", plist)
	}
	if unit := systemdUnit([]string{"/home/a b/100%/bro", "serve"}); !strings.Contains(unit, `ExecStart="/home/a b/100%%/bro" "serve"`) {
		t.Fatalf("unit:\n%s", unit)
	}
}

func extensionIDFromKey(t *testing.T, key string) string {
	t.Helper()
	der, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	var id strings.Builder
	for _, c := range hex.EncodeToString(sum[:16]) {
		v := strings.IndexRune("0123456789abcdef", c)
		id.WriteByte(byte('a' + v))
	}
	return id.String()
}

func TestHomebrewManagedFollowsTheOptLinkIntoTheKeg(t *testing.T) {
	prefix := t.TempDir()
	keg := filepath.Join(prefix, "Cellar", "bro", "2.3.0")
	if err := os.MkdirAll(filepath.Join(keg, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(keg, "bin", "bro"), nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(prefix, "opt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(keg, filepath.Join(prefix, "opt", "bro")); err != nil {
		t.Fatal(err)
	}
	manual := filepath.Join(t.TempDir(), "opt", "bro", "bin", "bro")
	if !HomebrewManaged(filepath.Join(prefix, "opt", "bro", "bin", "bro")) || HomebrewManaged(manual) {
		t.Fatal("HomebrewManaged misclassified a path")
	}
}
