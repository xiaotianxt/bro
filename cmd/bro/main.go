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
	"syscall"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/xiaotianxt/bro/internal/credentials"
	"github.com/xiaotianxt/bro/internal/server"
	"github.com/xiaotianxt/bro/internal/settings"
	"github.com/xiaotianxt/bro/internal/setup"
)

// version is the release version; scripts/check-version.mjs keeps it in step
// with the extension and the Homebrew formula.
const version = "2.0.0"

const defaultPort = 3500

const usage = `bro: local MCP core for browser automation

Usage:
  bro [serve] [--port N]                 start the HTTP/WebSocket/MCP server
  bro call TOOL [JSON] [--json] [--port N]
                                         call a tool on the local server
  bro doctor [--json] [--port N]         read-only diagnostics
  bro setup codex [--config PATH] [--port N] [--json]
                                         point Codex at the local server
  bro setup browser [--browser APP] [--extension-dir DIR] [--no-open] [--json]
                                         open extension setup, copy the token
  bro --version
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
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
	case "doctor":
		return doctor(args[1:])
	case "setup":
		if len(args) > 1 && args[1] == "codex" {
			return setupCodex(args[2:])
		}
		if len(args) > 1 && args[1] == "browser" {
			return setupBrowser(args[2:])
		}
		return fmt.Errorf("setup requires codex or browser\n\n%s", usage)
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
	s, err := settings.Load()
	if err != nil {
		return fmt.Errorf("failed to load settings: %w", err)
	}
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "bro-cli", Version: version}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   fmt.Sprintf("http://127.0.0.1:%d/mcp", *port),
		HTTPClient: &http.Client{Transport: bearer{s.Token}},
	}, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to bro on port %d: %w", *port, err)
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
	noOpen := fs.Bool("no-open", false, "")
	asJSON := fs.Bool("json", false, "")
	if err := noPositionals(fs, args); err != nil {
		return err
	}
	s, err := settings.LoadOrCreate()
	if err != nil {
		return fmt.Errorf("failed to load settings: %w", err)
	}
	report, err := setup.Browser(s.Token, *extensionDir, *browser, !*noOpen)
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(report)
	}
	pick := func(ok bool, yes, no string) string {
		if ok {
			return yes
		}
		return no
	}
	fmt.Printf("bro extension: %s\n", report.ExtensionDir)
	fmt.Printf("token: %s\n", pick(report.TokenCopied, "copied to clipboard", "copy it from ~/.bro/settings.json"))
	fmt.Printf("browser extension page: %s\n", pick(report.ExtensionPageOpened, "opened", "open chrome://extensions/"))
	fmt.Printf("extension folder: %s\n", pick(report.ExtensionDirRevealed, "shown", "open the path above"))
	fmt.Println("In the browser: enable Developer mode, Load unpacked, select the extension folder, then open bro Options and paste the token.")
	return nil
}
