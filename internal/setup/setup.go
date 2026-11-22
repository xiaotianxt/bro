// Package setup configures MCP clients and helps load the browser extension.
package setup

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// CodexReport is the result of `bro setup codex`.
type CodexReport struct {
	ConfigPath      string `json:"configPath"`
	ServerURL       string `json:"serverUrl"`
	Updated         bool   `json:"updated"`
	RestartRequired bool   `json:"restartRequired"`
}

// BrowserReport is the result of `bro setup browser`.
type BrowserReport struct {
	ExtensionDir         string `json:"extensionDir"`
	TokenCopied          bool   `json:"tokenCopied"`
	ExtensionPageOpened  bool   `json:"extensionPageOpened"`
	ExtensionDirRevealed bool   `json:"extensionDirRevealed"`
}

// DefaultCodexConfigPath is $CODEX_HOME/config.toml or ~/.codex/config.toml.
func DefaultCodexConfigPath() (string, error) {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return filepath.Join(home, "config.toml"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex", "config.toml"), nil
}

// ConfigureCodex points [mcp_servers.bro] at the local server with a bearer
// header, preserving the rest of the file (comments included). The edit is
// textual, so the result is parsed back and checked before it is written.
func ConfigureCodex(path, token, bind string) (CodexReport, error) {
	serverURL := "http://" + bind + "/mcp"
	report := CodexReport{ConfigPath: path, ServerURL: serverURL, RestartRequired: true}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return report, fmt.Errorf("failed to read %s: %w", path, err)
	}
	existing := string(data)
	var doc map[string]any
	if err := toml.Unmarshal(data, &doc); err != nil {
		return report, fmt.Errorf("failed to parse TOML %s: %w", path, err)
	}
	if v, ok := doc["mcp_servers"]; ok {
		servers, isTable := v.(map[string]any)
		if !isTable {
			return report, errors.New("mcp_servers must be a TOML table")
		}
		if b, ok := servers["bro"]; ok {
			if _, isTable := b.(map[string]any); !isTable {
				return report, errors.New("mcp_servers.bro must be a TOML table")
			}
		}
	}
	next := editCodexConfig(existing, serverURL, "Bearer "+token)
	if err := verifyCodexConfig(next, serverURL, "Bearer "+token); err != nil {
		// Never echo the file: it now holds the token.
		return report, fmt.Errorf("could not update %s automatically (%v); set [mcp_servers.bro] url = %q and [mcp_servers.bro.http_headers] Authorization by hand", path, err, serverURL)
	}
	report.Updated = next != existing
	if !report.Updated {
		return report, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return report, fmt.Errorf("failed to create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(next), 0o600); err != nil {
		return report, fmt.Errorf("failed to write %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return report, fmt.Errorf("failed to secure %s: %w", path, err)
	}
	return report, nil
}

func tomlString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`).Replace(s) + `"`
}

// headerName returns the table name of a `[name]` line, or "" for other lines.
func headerName(line string) string {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "[") || strings.HasPrefix(t, "[[") {
		return ""
	}
	end := strings.Index(t, "]")
	if end < 0 {
		return ""
	}
	parts := strings.Split(t[1:end], ".")
	for i, p := range parts {
		parts[i] = strings.Trim(strings.TrimSpace(p), `"'`)
	}
	return strings.Join(parts, ".")
}

func isHeader(line string) bool { return strings.HasPrefix(strings.TrimSpace(line), "[") }

func keyName(line string) string {
	k, _, ok := strings.Cut(line, "=")
	if !ok {
		return ""
	}
	return strings.Trim(strings.TrimSpace(k), `"'`)
}

func editCodexConfig(existing, serverURL, authorization string) string {
	lines := strings.Split(strings.TrimRight(existing, "\n"), "\n")
	if strings.TrimSpace(existing) == "" {
		lines = nil
	}
	headers := []string{"[mcp_servers.bro.http_headers]", "Authorization = " + tomlString(authorization)}
	var out []string
	section := ""
	found := false
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if isHeader(line) {
			section = headerName(line)
			if section == "mcp_servers.bro.http_headers" {
				// Dropped; rewritten after [mcp_servers.bro].
				for i+1 < len(lines) && !isHeader(lines[i+1]) {
					i++
				}
				continue
			}
			out = append(out, line)
			if section == "mcp_servers.bro" {
				found = true
				out = append(out, "url = "+tomlString(serverURL))
				var body []string
				for i+1 < len(lines) && !isHeader(lines[i+1]) {
					i++
					switch keyName(lines[i]) {
					case "url", "bearer_token_env_var", "http_headers":
					default:
						body = append(body, lines[i])
					}
				}
				trailing := 0
				for trailing < len(body) && strings.TrimSpace(body[len(body)-1-trailing]) == "" {
					trailing++
				}
				out = append(out, body[:len(body)-trailing]...)
				out = append(out, "")
				out = append(out, headers...)
				if i+1 < len(lines) {
					out = append(out, "")
				}
			}
			continue
		}
		out = append(out, line)
	}
	if !found {
		if len(out) > 0 {
			out = append(out, "")
		}
		out = append(out, "[mcp_servers.bro]", "url = "+tomlString(serverURL), "")
		out = append(out, headers...)
	}
	for len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n") + "\n"
}

func verifyCodexConfig(text, serverURL, authorization string) error {
	var doc struct {
		MCPServers map[string]map[string]any `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal([]byte(text), &doc); err != nil {
		return errors.New("the edited file does not parse")
	}
	bro := doc.MCPServers["bro"]
	headers, _ := bro["http_headers"].(map[string]any)
	if bro["url"] != serverURL || headers["Authorization"] != authorization {
		return errors.New("an unsupported layout defines mcp_servers.bro")
	}
	if _, ok := bro["bearer_token_env_var"]; ok {
		return errors.New("bearer_token_env_var is still set")
	}
	return nil
}

// Browser copies the token, opens the extensions page and reveals the
// unpacked extension so the user can load it.
func Browser(token, extensionDir, browser string, open bool) (BrowserReport, error) {
	dir, err := resolveExtensionDir(extensionDir)
	if err != nil {
		return BrowserReport{}, err
	}
	report := BrowserReport{ExtensionDir: dir, TokenCopied: copyToClipboard(token)}
	if open {
		report.ExtensionPageOpened = openExtensionsPage(browser)
		report.ExtensionDirRevealed = reveal(dir)
	}
	return report, nil
}

func validExtensionDir(path string) bool {
	info, err := os.Stat(filepath.Join(path, "manifest.json"))
	return err == nil && info.Mode().IsRegular()
}

func resolveExtensionDir(explicit string) (string, error) {
	if explicit != "" {
		if !validExtensionDir(explicit) {
			return "", fmt.Errorf("%s does not contain manifest.json", explicit)
		}
		return explicit, nil
	}
	var candidates []string
	if env := os.Getenv("BRO_EXTENSION_DIR"); env != "" {
		candidates = append(candidates, env)
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(filepath.Dir(exe)), "share", "bro", "extension"))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "extension", "dist"))
	}
	candidates = append(candidates, "/opt/homebrew/share/bro/extension", "/usr/local/share/bro/extension", "/home/linuxbrew/.linuxbrew/share/bro/extension")
	for _, c := range candidates {
		if validExtensionDir(c) {
			return c, nil
		}
	}
	return "", errors.New("bro extension directory not found; install bro with Homebrew or pass --extension-dir")
}

func succeeds(name string, args ...string) bool {
	return exec.Command(name, args...).Run() == nil
}

func copyToClipboard(token string) bool {
	pipe := func(name string, args ...string) bool {
		cmd := exec.Command(name, args...)
		cmd.Stdin = strings.NewReader(token)
		return cmd.Run() == nil
	}
	switch runtime.GOOS {
	case "darwin":
		return pipe("pbcopy")
	case "windows":
		return pipe("clip")
	default:
		return pipe("wl-copy") || pipe("xclip", "-selection", "clipboard")
	}
}

func openExtensionsPage(browser string) bool {
	const url = "chrome://extensions/"
	switch runtime.GOOS {
	case "darwin":
		if browser != "" {
			return succeeds("open", "-a", browser, url)
		}
		if succeeds("open", url) {
			return true
		}
		for _, app := range []string{"Helium", "Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge", "Arc"} {
			if succeeds("open", "-a", app, url) {
				return true
			}
		}
		return false
	case "windows":
		if browser != "" {
			return succeeds(browser, url)
		}
		return succeeds("cmd", "/C", "start", "", url)
	default:
		if browser != "" {
			return succeeds(browser, url)
		}
		return succeeds("xdg-open", url)
	}
}

func reveal(dir string) bool {
	manifest := filepath.Join(dir, "manifest.json")
	switch runtime.GOOS {
	case "darwin":
		return succeeds("open", "-R", manifest)
	case "windows":
		return succeeds("explorer", "/select,", manifest)
	default:
		return succeeds("xdg-open", dir)
	}
}
