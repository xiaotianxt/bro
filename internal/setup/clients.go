package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
)

// ClientReport is what setup did for one MCP client.
type ClientReport struct {
	Client string `json:"client"`
	Config string `json:"config,omitempty"`
	// State is "configured", "updated", "already configured" or "not found".
	State string `json:"state"`
	// RestartRequired is set when the client reads its config only at start.
	RestartRequired bool `json:"restartRequired,omitempty"`
}

// Client names accepted by `bro setup --clients`.
var Clients = []string{"codex", "claude-code", "claude-desktop", "cursor"}

// StdioArgs is how a stdio MCP client launches bro.
func StdioArgs(port int) []string {
	if port == defaultPort {
		return []string{"mcp"}
	}
	return []string{"mcp", "--port", strconv.Itoa(port)}
}

// ConfigureClient points one MCP client at bro if that client is installed.
func ConfigureClient(name, exe, token string, port int) (ClientReport, error) {
	report := ClientReport{Client: name, State: "not found"}
	home, err := os.UserHomeDir()
	if err != nil {
		return report, err
	}
	switch name {
	case "codex":
		if !exists(filepath.Join(home, ".codex")) && !onPath("codex") && os.Getenv("CODEX_HOME") == "" {
			return report, nil
		}
		path, err := DefaultCodexConfigPath()
		if err != nil {
			return report, err
		}
		r, err := ConfigureCodex(path, token, fmt.Sprintf("127.0.0.1:%d", port))
		report.Config = path
		if err != nil {
			return report, err
		}
		report.State, report.RestartRequired = changed(r.Updated, true), r.Updated
	case "claude-code":
		if !onPath("claude") {
			return report, nil
		}
		report.Config = "claude mcp (user scope)"
		// An existing entry may be one the user wrote; it is left alone.
		if exec.Command("claude", "mcp", "get", "bro").Run() == nil {
			report.State = "already configured"
			return report, nil
		}
		args := append([]string{"mcp", "add", "--scope", "user", "bro", "--", exe}, StdioArgs(port)...)
		if err := run("claude", args...); err != nil {
			return report, err
		}
		report.State, report.RestartRequired = "configured", true
	case "claude-desktop":
		dir, err := claudeDesktopDir(home)
		if err != nil || !exists(dir) {
			return report, err
		}
		report.Config = filepath.Join(dir, "claude_desktop_config.json")
		updated, existed, err := ConfigureJSONClient(report.Config, exe, StdioArgs(port))
		if err != nil {
			return report, err
		}
		report.State, report.RestartRequired = changed(updated, existed), updated
	case "cursor":
		dir := filepath.Join(home, ".cursor")
		if !exists(dir) {
			return report, nil
		}
		report.Config = filepath.Join(dir, "mcp.json")
		updated, existed, err := ConfigureJSONClient(report.Config, exe, StdioArgs(port))
		if err != nil {
			return report, err
		}
		report.State = changed(updated, existed)
	default:
		return report, fmt.Errorf("unknown MCP client %q; use one of %v", name, Clients)
	}
	return report, nil
}

func changed(updated, existed bool) string {
	switch {
	case !updated:
		return "already configured"
	case existed:
		return "updated"
	default:
		return "configured"
	}
}

func claudeDesktopDir(home string) (string, error) {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Claude"), nil
	case "windows":
		if dir := os.Getenv("APPDATA"); dir != "" {
			return filepath.Join(dir, "Claude"), nil
		}
		return "", errors.New("APPDATA is not set")
	default:
		return filepath.Join(home, ".config", "Claude"), nil
	}
}

// ConfigureJSONClient sets mcpServers.bro in a Claude Desktop or Cursor style
// JSON config to launch `exe args...`, keeping every other entry. It reports
// whether the file changed and whether a bro entry existed before.
func ConfigureJSONClient(path, exe string, args []string) (updated, existed bool, err error) {
	doc := map[string]json.RawMessage{}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return false, false, fmt.Errorf("failed to read %s: %w", path, err)
	case len(bytes.TrimSpace(data)) > 0:
		if err := json.Unmarshal(data, &doc); err != nil {
			return false, false, fmt.Errorf("%s is not a JSON object; add bro by hand: %w", path, err)
		}
	}
	servers := map[string]json.RawMessage{}
	if raw, ok := doc["mcpServers"]; ok {
		if err := json.Unmarshal(raw, &servers); err != nil {
			return false, false, fmt.Errorf("%s: mcpServers is not a JSON object: %w", path, err)
		}
	}
	want := map[string]any{"command": exe, "args": args}
	if raw, ok := servers["bro"]; ok {
		existed = true
		var have any
		if json.Unmarshal(raw, &have) == nil && reflect.DeepEqual(normalize(have), normalize(want)) {
			return false, true, nil
		}
	}
	entry, err := json.Marshal(want)
	if err != nil {
		return false, existed, err
	}
	servers["bro"] = entry
	if doc["mcpServers"], err = json.Marshal(servers); err != nil {
		return false, existed, err
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return false, existed, err
	}
	mode := fs.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	return true, existed, writeFileAtomic(path, append(out, '\n'), mode)
}

// normalize round-trips v through JSON so typed and decoded values compare.
func normalize(v any) any {
	data, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("encode %T: %v", v, err))
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		panic(fmt.Sprintf("decode %T: %v", v, err))
	}
	return out
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func onPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
