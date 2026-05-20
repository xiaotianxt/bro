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
```

The service runs `bro serve` locally and exposes MCP at
`http://127.0.0.1:3500/mcp`. Use `brew services restart bro` after upgrading.

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

Build the extension:

```bash
npm --prefix packages/shared install
npm --prefix packages/shared run build
npm --prefix extension install
npm --prefix extension run typecheck
npm --prefix extension run build
```

Load `extension/dist/` as an unpacked extension in a Chromium-family browser,
open the extension options, and paste the token from `~/.bro/settings.json`.

## MCP Configuration

Run bro as a local service, then point your MCP client at the HTTP endpoint and
send the local bearer token from `~/.bro/settings.json`.

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.bro]
url = "http://127.0.0.1:3500/mcp"
bearer_token_env_var = "BRO_MCP_TOKEN"
```

Start Codex with the token in the environment:

```bash
export BRO_MCP_TOKEN="$(jq -r .token ~/.bro/settings.json)"
```

The MCP client should connect to this endpoint. It should not spawn the server
per request; keep `bro serve` running through Homebrew services or another
local process supervisor. Other MCP clients should send the same token as an
`Authorization: Bearer ...` header. Do not hard-code or commit the token.

## Main Tools

- `browser.extract`: open one URL, extract visible text/links, close by default
- `browser.batch.extract`: extract many URLs in parallel
- `browser.batch.run`: open many URLs, read plain text, close by default
- `browser.flow.start`: lease one tab for sequential work
- `browser.flow.observe`: read leased-tab text or accessibility tree
- `browser.flow.act`: run ordered generic steps such as `goto`, `click`, `fill`
- `browser.flow.finish`: release and optionally close the leased tab

Raw browser primitives such as `tabs_create`, `tabs_close`, `read_page`,
`javascript_tool`, `click_element`, and `fill_element` remain available for
lower-level work.

## Development

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test

npm --prefix packages/shared run typecheck
npm --prefix packages/shared run build
npm --prefix extension run typecheck
npm --prefix extension run build
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
the current macOS or Linux architecture and exposes `brew services start bro`.

## Security Notes

bro controls a logged-in browser. Keep it local.

- The server binds to `127.0.0.1` by default.
- The WebSocket bridge requires the token from `~/.bro/settings.json`.
- Do not expose port `3500` to untrusted networks.
- Do not commit browser output, cookies, signed URLs, or tokens.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
