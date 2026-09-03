# Extension Adapter

bro uses a minimal Chromium-family WebExtension adapter. The Rust server owns
MCP transport, auth, tool schemas, routing, facade behavior, batching, cleanup,
and tests. The extension owns only the browser APIs that Rust cannot call from a
normal local process: tabs, debugger/CDP attachment, content scripts, downloads,
notifications, and extension options.

The adapter connects to `ws://127.0.0.1:3500/ws`, sends the local token from the
options page, receives generic tool calls, executes browser primitives, and
returns MCP-style content. It should stay policy-free: no site-specific research
logic, no cloud relay, and no final-answer generation.

Options accept only `ws://` URLs on `localhost`, `127.0.0.1`, or `[::1]`. The
token stays in local extension storage. The extension refuses to connect unless
Chromium first restricts that storage to trusted extension contexts. Older
synced tokens are migrated once and removed from sync storage. The extension
reports connected only after the Rust server acknowledges authentication.

## User Scripts

The Options page and the `userscripts_*` MCP tools share one implementation over
`chrome.userScripts`. The page supports listing, creating, editing, and deleting
inline scripts at full width. Low-frequency connection settings stay collapsed;
execution world, frame behavior, and excluded match patterns live under
Advanced options. A short editable description appears below each script ID so
users can review purpose before editing or deleting a script.

The extension also stores the registered definitions in `chrome.storage.local`.
On startup it restores any definitions missing from Chrome's dynamic script
registry, which protects installed scripts across extension updates.

Chrome requires **Allow User Scripts** to be enabled for the extension in
`chrome://extensions`. File-backed scripts can be listed and deleted, but the
Options page does not edit extension package files.

## Build

```bash
pnpm install
pnpm --filter @bro/shared build
pnpm --filter @bro/extension typecheck
pnpm --filter @bro/extension test
pnpm --filter @bro/extension build
```

For Homebrew installs, `bro setup browser` reveals the installed extension
directory and copies the token to the clipboard. For source checkouts, run:

```bash
cargo run -- setup browser --extension-dir extension/dist
```

Load that directory as an unpacked extension in a Chromium-family browser. Open
the extension options page and paste the token.

## Attribution

The adapter descends from the Apache-2.0 OpenBrowserMCP WebExtension design and
keeps protocol compatibility where useful. New package names and user-facing
project names use `bro`; OpenBrowserMCP is credited in the repository README and
NOTICE.
