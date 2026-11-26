package e2e

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const pinnedExtensionID = "ibnjnpacbcpiodnhpgmnohhnhgpkmieg"

// The browser launches bro with the caller's origin and speaks
// length-prefixed JSON on stdin/stdout; the extension gets the token.
func TestNativeHostHandsTheExtensionTheToken(t *testing.T) {
	home := t.TempDir()
	writeSettings(t, home)
	var in bytes.Buffer
	req := []byte(`{"type":"pair"}`)
	_ = binary.Write(&in, binary.LittleEndian, uint32(len(req)))
	in.Write(req)
	cmd := exec.Command(broBin, "chrome-extension://"+pinnedExtensionID+"/")
	cmd.Env = append(os.Environ(), "HOME="+home)
	cmd.Stdin = &in
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("native host: %v", err)
	}
	var n uint32
	r := bytes.NewReader(out)
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil || int(n) != r.Len() {
		t.Fatalf("reply frame: n=%d rest=%d err=%v", n, r.Len(), err)
	}
	var reply struct{ Token, Version, Error string }
	if err := json.Unmarshal(out[4:], &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Token != testToken || reply.Error != "" || reply.Version == "" {
		t.Fatalf("reply = %+v", reply)
	}
}

// A stdio client reaches the server through `bro mcp` without a token in its
// config, and keeps working across a server restart.
func TestStdioBridgeRelaysAndSurvivesAServerRestart(t *testing.T) {
	s := startServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.Command(broBin, "mcp", "--port", fmt.Sprint(s.Port))
	cmd.Env = append(os.Environ(), "HOME="+s.Home)
	stderr := &lockedBuffer{}
	cmd.Stderr = stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "e2e-stdio", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatalf("connect: %v\n%s", err, stderr.String())
	}
	defer session.Close()

	listOpen := func() {
		t.Helper()
		tools, err := session.ListTools(ctx, nil)
		if err != nil {
			t.Fatalf("list tools: %v\n%s", err, stderr.String())
		}
		for _, tool := range tools.Tools {
			if tool.Name == "browser.open" {
				return
			}
		}
		t.Fatalf("browser.open missing from %d tools", len(tools.Tools))
	}
	listOpen()
	r, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "browsers_context", Arguments: map[string]any{}})
	if err != nil || r.IsError {
		t.Fatalf("browsers_context: %v %+v", err, r)
	}

	s.Stop()
	startServerAt(t, s.Home, s.Port)
	listOpen()

	if strings.Contains(stderr.String(), testToken) {
		t.Error("bro mcp printed the token")
	}
}

// While the server is down, a request fails with an answer that says how to
// start it instead of hanging or killing the client.
func TestStdioBridgeExplainsADownServer(t *testing.T) {
	home := t.TempDir()
	writeSettings(t, home)
	cmd := exec.Command(broBin, "mcp", "--port", fmt.Sprint(freePort(t)))
	cmd.Env = append(os.Environ(), "HOME="+home)
	cmd.Stdin = strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("bro mcp: %v", err)
	}
	contains(t, string(out), `"id":1`)
	contains(t, string(out), "bro setup")
}

// `bro setup` without a service installs the extension where upgrades keep
// it, registers the native host for an installed browser, and configures a
// detected MCP client, all inside HOME.
func TestSetupInstallsExtensionNativeHostAndClients(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows registers the native host in the registry")
	}
	home := t.TempDir()
	writeSettings(t, home)
	pkg := filepath.Join(t.TempDir(), "extension")
	if err := os.MkdirAll(pkg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkg, "manifest.json"), []byte(`{"version":"9.9.9"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	chromeData := filepath.Join(home, ".config", "google-chrome")
	if runtime.GOOS == "darwin" {
		chromeData = filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
	}
	for _, dir := range []string{chromeData, filepath.Join(home, ".cursor")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command(broBin, "setup", "--no-service", "--no-open", "--clients", "cursor", "--port", fmt.Sprint(freePort(t)), "--json")
	// An empty PATH keeps setup away from the real clipboard, browser and
	// MCP clients.
	env := []string{"HOME=" + home, "PATH=" + t.TempDir(), "BRO_EXTENSION_DIR=" + pkg}
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	if strings.Contains(string(out), testToken) {
		t.Fatal("setup printed the token")
	}
	installed, err := os.ReadFile(filepath.Join(home, ".bro", "extension", "manifest.json"))
	if err != nil || string(installed) != `{"version":"9.9.9"}` {
		t.Fatalf("installed manifest = %q, %v", installed, err)
	}
	host, err := os.ReadFile(filepath.Join(chromeData, "NativeMessagingHosts", "com.xiaotianxt.bro.json"))
	if err != nil {
		t.Fatal(err)
	}
	contains(t, string(host), "chrome-extension://"+pinnedExtensionID+"/")
	cursor, err := os.ReadFile(filepath.Join(home, ".cursor", "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(cursor, &cfg); err != nil {
		t.Fatal(err)
	}
	bro := cfg.MCPServers["bro"]
	if bro.Command == "" || bro.Args[0] != "mcp" || strings.Contains(string(cursor), testToken) {
		t.Fatalf("cursor config = %s", cursor)
	}
}
