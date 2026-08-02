# bro

Rust-native MCP server for controlling a real local browser through a minimal
WebExtension bridge.

bro is built for agents that need a shorter browser interaction loop:

- open many URLs in background tabs and extract useful text/links in parallel
- keep a single tab leased for sequential click/fill/read flows
- use a logged-in Chromium-family browser without sending browsing data through
  a cloud relay
- keep the MCP server, API policy, concurrency, and tests in Rust

The browser runtime itself is still a WebExtension because Chromium exposes
`chrome.tabs`, `chrome.debugger`, content scripts, and service workers only to
the extension environment. bro keeps that layer intentionally thin.

## Acknowledgement

bro is inspired by and initially prototyped against
[OpenBrowserMCP](https://github.com/thezzisu/openbrowsermcp). OpenBrowserMCP
proved the local WebSocket bridge + browser extension shape; bro takes that
idea into a Rust-native MCP server with a smaller agent-facing API, tighter
regression tests, and a minimal extension adapter. OpenBrowserMCP is
Apache-2.0, and this repository keeps the Apache-2.0 license and attribution in
[NOTICE](NOTICE).

## Architecture

```text
MCP client
  -> bro Rust server (:3500 /mcp, /ws, /health, /status)
  -> bro WebExtension adapter
  -> Chromium-family browser tab
```

The Rust server owns:

- MCP Streamable HTTP
- WebSocket bridge registry
- tool schema and routing
- default-first browser facade tools
- batch scheduling and cleanup policy
- regression tests and release artifacts

The extension owns:

- connecting to `ws://127.0.0.1:3500/ws`
- authenticating with the local token
- executing browser primitives via WebExtension APIs and CDP

## Quick Start

Install with Homebrew:

```bash
brew install xiaotianxt/tap/bro
brew services start bro
bro setup codex
bro setup browser
```

Install the optional Codex/agent skill for bro-specific browser workflows:

```bash
npx -y github:xiaotianxt/skills bro-browser
```

After the npm package is published, the equivalent command is:

```bash
npx -y @xiaotianxt/skills bro-browser
```

The service runs `bro serve` locally and exposes MCP at
`http://127.0.0.1:3500/mcp`. `bro setup codex` updates
`~/.codex/config.toml` to connect Codex to that local MCP endpoint with the
bearer token from `~/.bro/settings.json`. Restart Codex after running it.

`bro setup browser` copies the token to your clipboard, opens the browser
extension page, and reveals the unpacked extension directory. In the browser,
enable Developer mode, choose Load unpacked, select the shown directory, then
open bro Options and paste the token.

Use `brew services restart bro` after upgrading.

For source development:

```bash
git clone https://github.com/xiaotianxt/bro.git
cd bro
cargo run -- serve
```

The first run creates `~/.bro/settings.json`:

```json
{
  "token": "..."
}
```

Existing settings are read without modification. If the file is malformed or
contains an empty token, bro reports the error and leaves the file unchanged.

Build the extension:

```bash
pnpm install
pnpm --filter @bro/shared build
pnpm --filter @bro/extension typecheck
pnpm --filter @bro/extension test
pnpm --filter @bro/extension build
```

For source checkouts, pass the local extension directory explicitly:

```bash
cargo run -- setup browser --extension-dir extension/dist
```

## MCP Configuration

Run bro as a local service, then point your MCP client at the HTTP endpoint with
the local bearer token from `~/.bro/settings.json`.

For Codex, prefer the setup command:

```bash
bro setup codex
```

It writes a `bro` MCP server entry like this:

```toml
[mcp_servers.bro]
url = "http://127.0.0.1:3500/mcp"
[mcp_servers.bro.http_headers]
Authorization = "Bearer <token from ~/.bro/settings.json>"
```

The setup command does not print the token. If you configure another MCP client
manually, send the same token as an `Authorization: Bearer ...` header.

Codex also supports `bearer_token_env_var`, but `bro setup codex` uses a static
local header so the configuration does not depend on a particular shell startup
file.

The MCP client should connect to this endpoint. It should not spawn the server
per request; keep `bro serve` running through Homebrew services or another
local process supervisor. Do not commit browser output, cookies, signed URLs, or
tokens.

## Browser Extension

Homebrew installs the unpacked bro extension under `share/bro/extension`.

```bash
bro setup browser
```

The command:

- finds the installed extension directory
- copies the local bro token to the clipboard when the OS clipboard tool is
  available
- opens `chrome://extensions/` when possible
- reveals the extension directory in the file manager when possible

Chromium-family browsers still require a user gesture to load unpacked
extensions. In the browser:

1. Enable Developer mode.
2. Choose Load unpacked.
3. Select the extension directory printed by `bro setup browser`.
4. Open bro Options.
5. Paste the copied token and save.

The extension accepts only loopback `ws://` server URLs. Its token is stored
locally in the extension profile and is not synced between browsers. A token
saved by an older version is moved out of sync storage on first use. Connected
status is shown only after the server authenticates the extension.

Verify the connection:

```bash
curl -fsS http://127.0.0.1:3500/status
bro call browsers_context
```

`extensionCount` should be at least `1`.

`browsers_context` also includes best-effort native metadata under
`nativeInfo` when the local server can identify the browser process. On macOS
and Unix-like systems this includes fields such as `appName`, `processId`,
`executablePath`, `userDataDir`, `profilePath`, `cookieStorePath`, and
`safeStorageService`. Use `nativeInfo` for cookie/storage export workflows;
`browserInfo` is only the browser identity visible to the WebExtension.

## Main Tools

- `browser.extract`: open one URL, extract visible text, close by default
- `browser.current.extract`: extract the current/default active tab in one call
- `browser.batch.extract`: extract many URLs in parallel
- `browser.batch.run`: open many URLs, read plain text, close by default
- `browser.batch.flow`: run the same ordered interaction on many URLs in
  parallel, close by default
- `browser.flow.start`: lease one tab for sequential work
- `browser.flow.observe`: read leased-tab text or accessibility tree
- `browser.flow.act`: run ordered generic steps such as `goto`, `click`, `fill`
- `browser.flow.finish`: release and optionally close the leased tab

Use `browser.batch.flow` when each page needs the same interaction before
reading data, for example opening a reviews modal on every product page and
then returning a structured `eval` result. It keeps the repeated workflow inside
one MCP call with bounded per-URL timeouts and cleanup, instead of requiring the
agent to start, act on, and finish many separate flow sessions.

Raw browser primitives such as `tabs_create`, `tabs_close`, `read_page`,
`javascript_tool`, `click_element`, `fill_element`, and `computer` remain
available for lower-level work.

Extraction defaults are intentionally compact for agent workflows:

- text is capped at 8,000 characters by default
- links are omitted unless `includeLinks:true`
- accessibility-tree fallback is omitted unless `includeA11y:true`
- screenshots default to lower JPEG quality; pass `quality` only when visual
  detail matters

## Development

```bash
pnpm install --frozen-lockfile
make check
```

Run live dynamic-site regression tests when a local bro server and extension are
connected:

```bash
make live-test
```

The live test opens Reddit, LinkedIn, X, and Threads search pages in background
tabs and checks that expected text/links still extract correctly.

## Releases

Tagged releases build GitHub-hosted binaries for:

- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-pc-windows-msvc`
- `aarch64-pc-windows-msvc`

The Homebrew formula in `xiaotianxt/tap` installs the GitHub release binary for
the current macOS or Linux architecture, installs the matching extension asset,
and exposes `brew services start bro`.

Maintainers release from a clean `main` checkout with
`scripts/release.sh --version <version>`. The script runs the checks, creates and
pushes the tag, waits for the GitHub release artifacts, updates the Homebrew tap,
and verifies the installed package.

## Security Notes

bro controls a logged-in browser. Keep it local.

- The server binds to `127.0.0.1` by default.
- The WebSocket bridge requires the token from `~/.bro/settings.json`.
- Do not expose port `3500` to untrusted networks.
- Do not commit browser output, cookies, signed URLs, or tokens.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
