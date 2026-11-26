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

	"github.com/xiaotianxt/bro/internal/settings"
)

// CodexReport is the result of `bro setup codex`.
type CodexReport struct {
	ConfigPath      string `json:"configPath"`
	ServerURL       string `json:"serverUrl"`
	Updated         bool   `json:"updated"`
	RestartRequired bool   `json:"restartRequired"`
}

// BrowserReport is the result of preparing the browser extension.
type BrowserReport struct {
	// ExtensionDir is the folder the browser loads: ~/.bro/extension for a
	// packaged install, or the --extension-dir given.
	ExtensionDir     string           `json:"extensionDir"`
	ExtensionUpdated bool             `json:"extensionUpdated"`
	NativeHost       NativeHostReport `json:"nativeHost"`
	TokenCopied      bool             `json:"tokenCopied"`
	PathCopied       bool             `json:"pathCopied"`
	// The two below are set by OpenExtensionSetup.
	ExtensionPageOpened  bool `json:"extensionPageOpened"`
	ExtensionDirRevealed bool `json:"extensionDirRevealed"`
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

// PrepareBrowser puts the extension where the browser can keep loading it and
// registers the native host that hands the extension its token. A packaged
// extension is copied to ~/.bro/extension, which outlives upgrades; an
// explicit directory (a source checkout) is loaded in place. The clipboard
// gets the folder path, or the token with copyToken for an extension that
// cannot pair through the native host.
func PrepareBrowser(token, explicitDir string, copyToken bool) (BrowserReport, error) {
	var report BrowserReport
	src, err := resolveExtensionDir(explicitDir)
	if err != nil {
		return report, err
	}
	report.ExtensionDir = src
	if explicitDir == "" {
		if report.ExtensionDir, err = ExtensionHome(); err != nil {
			return report, err
		}
		if report.ExtensionUpdated, err = InstallExtension(src, report.ExtensionDir); err != nil {
			return report, err
		}
	}
	exe, err := StableExecutable()
	if err != nil {
		return report, err
	}
	appData, err := AppDataDir()
	if err != nil {
		return report, err
	}
	if report.NativeHost, err = InstallNativeHost(exe, appData); err != nil {
		return report, err
	}
	if copyToken {
		report.TokenCopied = copyToClipboard(token)
	} else {
		report.PathCopied = copyToClipboard(report.ExtensionDir)
	}
	return report, nil
}

// ExtensionHome is ~/.bro/extension, the folder a packaged install loads.
func ExtensionHome() (string, error) {
	dir, err := settings.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "extension"), nil
}

// SyncInstalledExtension refreshes ~/.bro/extension from the extension
// packaged with this binary, if the user installed one there. It reports
// whether files changed; a running extension picks them up when it reloads.
func SyncInstalledExtension() (bool, error) {
	dst, err := ExtensionHome()
	if err != nil {
		return false, err
	}
	if !validExtensionDir(dst) {
		return false, nil
	}
	src, ok := PackagedExtensionDir()
	if !ok {
		return false, nil
	}
	return InstallExtension(src, dst)
}

// OpenExtensionSetup opens the browser's extensions page and shows the
// extension folder, for loading it unpacked.
func OpenExtensionSetup(report *BrowserReport, browser string) {
	report.ExtensionPageOpened = openExtensionsPage(browser)
	report.ExtensionDirRevealed = reveal(report.ExtensionDir)
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
	if dir, ok := PackagedExtensionDir(); ok {
		return dir, nil
	}
	if cwd, err := os.Getwd(); err == nil {
		if dir := filepath.Join(cwd, "extension", "dist"); validExtensionDir(dir) {
			return dir, nil
		}
	}
	return "", errors.New("bro extension directory not found; install bro with Homebrew or the install script, or pass --extension-dir")
}

// PackagedExtensionDir is the extension shipped with this bro binary:
// $BRO_EXTENSION_DIR, share/bro/extension beside a Homebrew or prefix
// install, or extension/ beside an unpacked release archive.
func PackagedExtensionDir() (string, bool) {
	var candidates []string
	if env := os.Getenv("BRO_EXTENSION_DIR"); env != "" {
		candidates = append(candidates, env)
	}
	if exe, err := os.Executable(); err == nil {
		for _, e := range []string{exe, resolvedPath(exe)} {
			dir := filepath.Dir(e)
			candidates = append(candidates, filepath.Join(filepath.Dir(dir), "share", "bro", "extension"), filepath.Join(dir, "extension"))
		}
	}
	candidates = append(candidates, "/opt/homebrew/share/bro/extension", "/usr/local/share/bro/extension", "/home/linuxbrew/.linuxbrew/share/bro/extension")
	for _, c := range candidates {
		if validExtensionDir(c) {
			return c, true
		}
	}
	return "", false
}

func resolvedPath(exe string) string {
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return exe
	}
	return resolved
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

// reveal selects the folder itself, so it can be dragged onto the
// extensions page.
func reveal(dir string) bool {
	switch runtime.GOOS {
	case "darwin":
		return succeeds("open", "-R", dir)
	case "windows":
		return succeeds("explorer", "/select,", dir)
	default:
		return succeeds("xdg-open", filepath.Dir(dir))
	}
}
