package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const bind = "127.0.0.1:3500"

func configure(t *testing.T, path string) CodexReport {
	t.Helper()
	report, err := ConfigureCodex(path, "tok", bind)
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func TestConfigureCodexCreatesAPrivateConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "codex", "config.toml")
	if r := configure(t, path); !r.Updated || r.ServerURL != "http://127.0.0.1:3500/mcp" {
		t.Fatalf("report %+v", r)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "[mcp_servers.bro]\nurl = \"http://127.0.0.1:3500/mcp\"\n\n[mcp_servers.bro.http_headers]\nAuthorization = \"Bearer tok\"\n"
	if string(got) != want {
		t.Fatalf("config:\n%s\nwant:\n%s", got, want)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	if r := configure(t, path); r.Updated {
		t.Fatal("a current config was rewritten")
	}
}

func TestConfigureCodexReplacesOnlyBroConnectionKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	before := `# user settings
model = "o4"

[mcp_servers.bro]
url = "http://127.0.0.1:9999/mcp"
bearer_token_env_var = "BRO_TOKEN"
startup_timeout_sec = 20 # keep

[mcp_servers.bro.http_headers]
Authorization = "Bearer old"
X-Other = "dropped with the table"

[mcp_servers.other]
url = "http://example.test/mcp"
`
	if err := os.WriteFile(path, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	configure(t, path)
	got, _ := os.ReadFile(path)
	text := string(got)
	for _, want := range []string{"# user settings", `model = "o4"`, "startup_timeout_sec = 20 # keep", `url = "http://127.0.0.1:3500/mcp"`, `Authorization = "Bearer tok"`, "[mcp_servers.other]", `url = "http://example.test/mcp"`} {
		if !strings.Contains(text, want) {
			t.Errorf("config lost %q:\n%s", want, text)
		}
	}
	for _, gone := range []string{"9999", "BRO_TOKEN", "Bearer old"} {
		if strings.Contains(text, gone) {
			t.Errorf("config kept %q:\n%s", gone, text)
		}
	}
}

func TestConfigureCodexRefusesLayoutsItCannotEdit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	before := "mcp_servers = { bro = { url = \"http://old/mcp\" } }\n"
	if err := os.WriteFile(path, []byte(before), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := ConfigureCodex(path, "tok", bind)
	if err == nil || strings.Contains(err.Error(), "tok") {
		t.Fatalf("error %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != before {
		t.Fatalf("config changed:\n%s", got)
	}
}
