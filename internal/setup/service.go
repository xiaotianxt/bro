package setup

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// LaunchdLabel names bro's launchd agent and systemd unit.
const LaunchdLabel = "com.xiaotianxt.bro"

// Health is what GET /health reports. Older servers report no version,
// which never matches, so setup restarts them.
type Health struct {
	Status         string `json:"status"`
	Version        string `json:"version"`
	ExtensionCount int    `json:"extensionCount"`
}

// ReadHealth asks the server on port for /health.
func ReadHealth(port int) (Health, error) {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if err != nil {
		return Health{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Health{}, fmt.Errorf("/health returned HTTP %d", resp.StatusCode)
	}
	var h Health
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return Health{}, fmt.Errorf("/health returned invalid JSON: %w", err)
	}
	return h, nil
}

// ServiceReport is the result of making sure bro runs in the background.
type ServiceReport struct {
	Manager string `json:"manager"`
	Action  string `json:"action"`
	Version string `json:"version"`
	// Definition is the launchd plist or systemd unit bro wrote, if any.
	Definition string `json:"definition,omitempty"`
}

// EnsureService starts or restarts bro's background server so that version
// answers on port, using Homebrew services for a Homebrew install, a launchd
// agent on macOS, or a systemd user unit on Linux.
func EnsureService(exe string, port int, version string) (ServiceReport, error) {
	report := ServiceReport{}
	before, beforeErr := ReadHealth(port)
	if beforeErr == nil && before.Version == version {
		report.Manager, report.Action, report.Version = managerName(exe), "already running", version
		return report, nil
	}
	report.Action = "started"
	if beforeErr == nil {
		report.Action = "restarted"
	}
	args := []string{exe, "serve"}
	if port != defaultPort {
		args = append(args, "--port", strconv.Itoa(port))
	}
	var err error
	switch report.Manager = managerName(exe); report.Manager {
	case "homebrew":
		if port != defaultPort {
			return report, fmt.Errorf("the Homebrew service always uses port %d; run bro setup without --port", defaultPort)
		}
		verb := "start"
		if beforeErr == nil {
			verb = "restart"
		}
		err = run("brew", "services", verb, "bro")
	case "launchd":
		report.Definition, err = startLaunchd(args)
	case "systemd":
		report.Definition, err = startSystemd(args)
	default:
		return report, fmt.Errorf("bro cannot install a background service on %s; keep `%s` running", runtime.GOOS, strings.Join(args, " "))
	}
	if err != nil {
		return report, err
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		h, err := ReadHealth(port)
		if err == nil && h.Version == version {
			report.Version = h.Version
			return report, nil
		}
		if time.Now().After(deadline) {
			if err == nil {
				return report, fmt.Errorf("port %d is served by bro %q, not %s; stop the other bro server", port, h.Version, version)
			}
			return report, fmt.Errorf("bro did not start on port %d: %w", port, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

const defaultPort = 3500

func managerName(exe string) string {
	switch {
	case HomebrewManaged(exe):
		return "homebrew"
	case runtime.GOOS == "darwin":
		return "launchd"
	case runtime.GOOS == "linux":
		return "systemd"
	default:
		return "none"
	}
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func launchdPlist(args []string, logPath string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + LaunchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
`)
	for _, a := range args {
		b.WriteString("    <string>" + xmlEscape(a) + "</string>\n")
	}
	b.WriteString(`  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>` + xmlEscape(logPath) + `</string>
  <key>StandardErrorPath</key>
  <string>` + xmlEscape(logPath) + `</string>
</dict>
</plist>
`)
	return b.String()
}

func startLaunchd(args []string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	plist := filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist")
	logPath := filepath.Join(home, ".bro", "bro.log")
	if err := writeFileAtomic(plist, []byte(launchdPlist(args, logPath)), 0o644); err != nil {
		return plist, err
	}
	domain := "gui/" + strconv.Itoa(os.Getuid())
	// bootout fails when the agent is not loaded; bootstrap then reports the
	// real problem, if any.
	_ = exec.Command("launchctl", "bootout", domain+"/"+LaunchdLabel).Run()
	return plist, run("launchctl", "bootstrap", domain, plist)
}

func systemdQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%").Replace(s) + `"`
}

func systemdUnit(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = systemdQuote(a)
	}
	return `[Unit]
Description=bro local browser MCP server

[Service]
ExecStart=` + strings.Join(quoted, " ") + `
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

func startSystemd(args []string) (string, error) {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, ".config")
	}
	unit := filepath.Join(dir, "systemd", "user", "bro.service")
	if err := writeFileAtomic(unit, []byte(systemdUnit(args)), 0o644); err != nil {
		return unit, err
	}
	for _, step := range [][]string{{"daemon-reload"}, {"enable", "bro.service"}, {"restart", "bro.service"}} {
		if err := run("systemctl", append([]string{"--user"}, step...)...); err != nil {
			return unit, err
		}
	}
	return unit, nil
}
