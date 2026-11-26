// Command bro is the local MCP server for controlling a browser through the
// bro WebExtension.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/xiaotianxt/bro/internal/credentials"
	"github.com/xiaotianxt/bro/internal/nativehost"
	"github.com/xiaotianxt/bro/internal/server"
	"github.com/xiaotianxt/bro/internal/settings"
	"github.com/xiaotianxt/bro/internal/setup"
	"github.com/xiaotianxt/bro/internal/stdiobridge"
)

// version is the release version; scripts/check-version.mjs keeps it in step
// with the extension and the Homebrew formula.
const version = "2.3.0"

const defaultPort = 3500

const usage = `bro: local MCP core for browser automation

Usage:
  bro [serve] [--port N]                 start the HTTP/WebSocket/MCP server
  bro call TOOL [JSON] [--json] [--port N]
                                         call a tool on the local server
  bro watch JSON | --id WATCHID [--cursor N] [--once] [--port N]
                                         stream a browser.watch as JSON lines;
                                         exit 0 when met, 1 on another end,
                                         3 after one change with --once
  bro mcp [--port N]                     serve MCP over stdio, relayed to
                                         the local server
  bro doctor [--json] [--port N]         read-only diagnostics
  bro setup [--clients LIST] [--browser APP] [--extension-dir DIR]
            [--no-service] [--no-open] [--wait DURATION] [--port N] [--json]
                                         install everything: background
                                         service, extension, MCP clients
                                         (LIST: auto, none, or any of
                                         codex,claude-code,claude-desktop,cursor)
  bro setup codex [--config PATH] [--port N] [--json]
                                         point Codex at the local server
  bro setup browser [--browser APP] [--extension-dir DIR] [--copy-token]
                    [--no-open] [--json]
                                         prepare the extension and open setup
  bro --version
`

func main() {
	err := run(os.Args[1:])
	var exit exitError
	if errors.As(err, &exit) {
		if exit.err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", exit.err)
		}
		os.Exit(exit.code)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if nativehost.IsLaunch(args) {
		return nativeHost()
	}
	if len(args) == 0 {
		return serve(nil)
	}
	switch args[0] {
	case "--version", "-V", "version":
		fmt.Printf("bro %s%s\n", version, credentials.VersionSuffix)
		return nil
	case "--help", "-h", "help":
		fmt.Print(usage)
		return nil
	case "serve":
		return serve(args[1:])
	case "call":
		return call(args[1:])
	case "watch":
		return watchCmd(args[1:])
	case "mcp":
		return mcpStdio(args[1:])
	case "doctor":
		return doctor(args[1:])
	case "setup":
		if len(args) > 1 && args[1] == "codex" {
			return setupCodex(args[2:])
		}
		if len(args) > 1 && args[1] == "browser" {
			return setupBrowser(args[2:])
		}
		return setupAll(args[1:])
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}
}

func flags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parse parses flags that may follow positional arguments, returning the positionals.
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, fmt.Errorf("%s: %w\n\n%s", fs.Name(), err, usage)
		}
		if fs.NArg() == 0 {
			return positional, nil
		}
		positional = append(positional, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

func noPositionals(fs *flag.FlagSet, args []string) error {
	rest, err := parse(fs, args)
	if err == nil && len(rest) > 0 {
		err = fmt.Errorf("%s: unexpected argument %q", fs.Name(), rest[0])
	}
	return err
}

func serve(args []string) error {
	fs := flags("serve")
	port := fs.Int("port", defaultPort, "")
	if err := noPositionals(fs, args); err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	s, err := settings.LoadOrCreate()
	if err != nil {
		return fmt.Errorf("failed to load settings: %w", err)
	}
	log.Info("starting server", "bind", fmt.Sprintf("127.0.0.1:%d", *port), "settings", s.Path)
	// An upgrade replaces the packaged extension; the installed copy follows
	// so the extension can reload into the matching version.
	if updated, err := setup.SyncInstalledExtension(); err != nil {
		log.Warn("failed to update the installed extension", "error", err.Error())
	} else if updated {
		log.Info("updated the installed extension")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return server.Serve(ctx, *port, server.Config{Token: s.Token, Version: version, Log: log})
}

func writeJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

// connect opens an MCP session to the local server with the settings token.
func connect(ctx context.Context, port int) (*mcp.ClientSession, error) {
	s, err := settings.Load()
	if err != nil {
		return nil, fmt.Errorf("failed to load settings: %w", err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "bro-cli", Version: version}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   fmt.Sprintf("http://127.0.0.1:%d/mcp", port),
		HTTPClient: &http.Client{Transport: bearer{s.Token}},
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to bro on port %d: %w", port, err)
	}
	return session, nil
}

func call(args []string) error {
	fs := flags("call")
	port := fs.Int("port", defaultPort, "")
	asJSON := fs.Bool("json", false, "")
	positional, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(positional) < 1 || len(positional) > 2 {
		return fmt.Errorf("call requires TOOL and optional JSON arguments\n\n%s", usage)
	}
	arguments := map[string]any{}
	if len(positional) == 2 {
		var value any
		if err := json.Unmarshal([]byte(positional[1]), &value); err != nil {
			return fmt.Errorf("failed to parse tool arguments JSON: %w", err)
		}
		object, ok := value.(map[string]any)
		if !ok {
			return errors.New("tool arguments must be a JSON object")
		}
		arguments = object
	}
	ctx := context.Background()
	session, err := connect(ctx, *port)
	if err != nil {
		return err
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: positional[0], Arguments: arguments})
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(map[string]any{"result": result})
	}
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			fmt.Println(text.Text)
			continue
		}
		data, err := json.Marshal(content)
		if err != nil {
			return err
		}
		fmt.Println(string(data))
	}
	return nil
}

func doctor(args []string) error {
	fs := flags("doctor")
	port := fs.Int("port", defaultPort, "")
	asJSON := fs.Bool("json", false, "")
	if err := noPositionals(fs, args); err != nil {
		return err
	}
	path, err := settings.DefaultPath()
	if err != nil {
		return err
	}
	present := false
	if _, err := os.Stat(path); err == nil {
		if _, err := settings.Load(); err != nil {
			return fmt.Errorf("failed to load settings: %w", err)
		}
		present = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("failed to inspect settings file %s: %w", path, err)
	}
	bind := fmt.Sprintf("127.0.0.1:%d", *port)
	if *asJSON {
		return writeJSON(struct {
			SettingsPath string `json:"settingsPath"`
			TokenPresent bool   `json:"tokenPresent"`
			BindAddress  string `json:"bindAddress"`
		}{path, present, bind})
	}
	token := "missing"
	if present {
		token = "present"
	}
	fmt.Printf("settings: %s\ntoken: %s\nbind: %s\n", path, token, bind)
	return nil
}

func setupCodex(args []string) error {
	fs := flags("setup codex")
	port := fs.Int("port", defaultPort, "")
	config := fs.String("config", "", "")
	asJSON := fs.Bool("json", false, "")
	if err := noPositionals(fs, args); err != nil {
		return err
	}
	s, err := settings.LoadOrCreate()
	if err != nil {
		return fmt.Errorf("failed to load settings: %w", err)
	}
	path := *config
	if path == "" {
		if path, err = setup.DefaultCodexConfigPath(); err != nil {
			return err
		}
	}
	report, err := setup.ConfigureCodex(path, s.Token, fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(report)
	}
	state := "already current"
	if report.Updated {
		state = "updated"
	}
	fmt.Printf("Codex MCP config: %s\nbro MCP URL: %s\nconfig: %s\nrestart Codex to load the MCP server.\n", report.ConfigPath, report.ServerURL, state)
	return nil
}

func setupBrowser(args []string) error {
	fs := flags("setup browser")
	browser := fs.String("browser", "", "")
	extensionDir := fs.String("extension-dir", "", "")
	copyToken := fs.Bool("copy-token", false, "")
	noOpen := fs.Bool("no-open", false, "")
	asJSON := fs.Bool("json", false, "")
	if err := noPositionals(fs, args); err != nil {
		return err
	}
	s, err := settings.LoadOrCreate()
	if err != nil {
		return fmt.Errorf("failed to load settings: %w", err)
	}
	report, err := setup.PrepareBrowser(s.Token, *extensionDir, *copyToken)
	if err != nil {
		return err
	}
	if !*noOpen {
		setup.OpenExtensionSetup(&report, *browser)
	}
	if *asJSON {
		return writeJSON(report)
	}
	printBrowserReport(report, !*noOpen)
	return nil
}

func printBrowserReport(report setup.BrowserReport, opened bool) {
	fmt.Printf("bro extension folder: %s\n", report.ExtensionDir)
	if len(report.NativeHost.Browsers) > 0 {
		fmt.Printf("automatic pairing: registered for %s\n", strings.Join(report.NativeHost.Browsers, ", "))
	} else {
		fmt.Println("automatic pairing: no supported browser found; paste the token from ~/.bro/settings.json into bro Options")
	}
	if report.TokenCopied {
		fmt.Println("token: copied to clipboard")
	}
	if !opened {
		return
	}
	pick := func(ok bool, yes, no string) string {
		if ok {
			return yes
		}
		return no
	}
	fmt.Println()
	fmt.Println("Load the extension once:")
	fmt.Printf("  1. %s\n", pick(report.ExtensionPageOpened, "In the extensions page that just opened, turn on Developer mode.", "Open chrome://extensions in your browser and turn on Developer mode."))
	fmt.Printf("  2. %s\n", pick(report.ExtensionDirRevealed, "Drag the selected \"extension\" folder from the file manager window onto that page.", "Click Load unpacked and choose the folder above."))
	if report.PathCopied {
		fmt.Println("     (Or click Load unpacked, press Cmd+Shift+G / Ctrl+L, and paste: the folder path is on your clipboard.)")
	}
	fmt.Println("bro pairs with the extension by itself; upgrades update this folder in place.")
}

func setupAll(args []string) error {
	fs := flags("setup")
	port := fs.Int("port", defaultPort, "")
	clients := fs.String("clients", "auto", "")
	browser := fs.String("browser", "", "")
	extensionDir := fs.String("extension-dir", "", "")
	noService := fs.Bool("no-service", false, "")
	noOpen := fs.Bool("no-open", false, "")
	interactive := isTerminal(os.Stdin) && isTerminal(os.Stdout)
	defaultWait := time.Duration(0)
	if interactive {
		defaultWait = 10 * time.Minute
	}
	wait := fs.Duration("wait", defaultWait, "")
	asJSON := fs.Bool("json", false, "")
	if err := noPositionals(fs, args); err != nil {
		return err
	}
	selected, err := selectClients(*clients)
	if err != nil {
		return err
	}
	say := func(format string, a ...any) {
		if !*asJSON {
			fmt.Printf(format+"\n", a...)
		}
	}
	s, err := settings.LoadOrCreate()
	if err != nil {
		return fmt.Errorf("failed to load settings: %w", err)
	}
	exe, err := setup.StableExecutable()
	if err != nil {
		return err
	}
	type report struct {
		Service   *setup.ServiceReport `json:"service,omitempty"`
		Browser   setup.BrowserReport  `json:"browser"`
		Clients   []setup.ClientReport `json:"clients"`
		Extension extensionState       `json:"extension"`
	}
	var r report

	// The remaining steps do not depend on the service, so its failure is
	// reported at the end instead of stopping them.
	var serviceErr error
	if !*noService {
		svc, err := setup.EnsureService(exe, *port, version)
		r.Service = &svc
		if err != nil {
			serviceErr = fmt.Errorf("background service: %w", err)
			say("✗ %v", serviceErr)
		} else {
			say("✓ bro %s is running in the background (%s, %s)", svc.Version, svc.Manager, svc.Action)
		}
	}

	if r.Browser, err = setup.PrepareBrowser(s.Token, *extensionDir, false); err != nil {
		return fmt.Errorf("browser extension: %w", err)
	}
	if len(r.Browser.NativeHost.Browsers) > 0 {
		say("✓ automatic pairing registered for %s", strings.Join(r.Browser.NativeHost.Browsers, ", "))
	} else {
		say("! no supported browser found for automatic pairing; paste the token from %s into bro Options", s.Path)
	}

	r.Clients = []setup.ClientReport{}
	for _, name := range selected {
		c, err := setup.ConfigureClient(name, exe, s.Token, *port)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		r.Clients = append(r.Clients, c)
		switch {
		case c.State == "not found":
		case c.RestartRequired:
			say("✓ %s: %s (restart %s to load bro)", c.Client, c.State, c.Client)
		default:
			say("✓ %s: %s", c.Client, c.State)
		}
	}

	r.Extension = readExtensionState(*port)
	if !r.Extension.Connected && !*noOpen {
		setup.OpenExtensionSetup(&r.Browser, *browser)
		if !*asJSON {
			fmt.Println()
			printBrowserReport(r.Browser, true)
		}
	}
	if !r.Extension.Connected && *wait > 0 {
		say("\nWaiting for the extension to connect (Ctrl+C to stop waiting)…")
		deadline := time.Now().Add(*wait)
		for !r.Extension.Connected && time.Now().Before(deadline) {
			time.Sleep(time.Second)
			r.Extension = readExtensionState(*port)
		}
	}
	switch {
	case r.Extension.Connected:
		say("✓ the bro extension is connected")
	case *noService || serviceErr != nil:
	default:
		say("! the extension is not connected yet; it connects as soon as it is loaded")
	}
	if len(r.Extension.Legacy) > 0 {
		say("! an older bro extension (%s) is also connected; remove it in the extensions page once the new one works, after copying any user scripts from its Options page into the new one's", strings.Join(r.Extension.Legacy, ", "))
	}
	if *asJSON {
		if err := writeJSON(r); err != nil {
			return err
		}
	}
	return serviceErr
}

func selectClients(list string) ([]string, error) {
	switch list {
	case "auto":
		return setup.Clients, nil
	case "none", "":
		return nil, nil
	}
	var out []string
	for _, name := range strings.Split(list, ",") {
		name = strings.TrimSpace(name)
		if !slices.Contains(setup.Clients, name) {
			return nil, fmt.Errorf("unknown MCP client %q; use auto, none, or any of %s", name, strings.Join(setup.Clients, ","))
		}
		out = append(out, name)
	}
	return out, nil
}

// extensionState is whether the extension bro pairs with is connected, and
// which other bro extension builds (loaded before the ID was pinned) are.
type extensionState struct {
	Connected bool     `json:"connected"`
	Legacy    []string `json:"legacy,omitempty"`
}

func readExtensionState(port int) extensionState {
	state := extensionState{}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/status", port))
	if err != nil {
		return state
	}
	defer resp.Body.Close()
	var status struct {
		Extensions []struct {
			ExtensionID string `json:"extensionId"`
		} `json:"extensions"`
	}
	if json.NewDecoder(resp.Body).Decode(&status) != nil {
		return state
	}
	for _, e := range status.Extensions {
		if slices.Contains(nativehost.ExtensionIDs, e.ExtensionID) {
			state.Connected = true
		} else if !slices.Contains(state.Legacy, e.ExtensionID) {
			state.Legacy = append(state.Legacy, e.ExtensionID)
		}
	}
	return state
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// nativeHost answers the extension's pairing request; the browser started
// this process and talks to it over stdin/stdout.
func nativeHost() error {
	return nativehost.Serve(os.Stdin, os.Stdout, version, func() (string, error) {
		s, err := settings.LoadOrCreate()
		return s.Token, err
	})
}

func mcpStdio(args []string) error {
	fs := flags("mcp")
	port := fs.Int("port", defaultPort, "")
	if err := noPositionals(fs, args); err != nil {
		return err
	}
	s, err := settings.LoadOrCreate()
	if err != nil {
		return fmt.Errorf("failed to load settings: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	b := &stdiobridge.Bridge{
		Endpoint: fmt.Sprintf("http://127.0.0.1:%d/mcp", *port),
		Token:    s.Token,
		Client:   &http.Client{},
	}
	return b.Run(ctx, os.Stdin, os.Stdout)
}
