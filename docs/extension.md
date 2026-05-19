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

## Build

```bash
npm --prefix packages/shared install
npm --prefix packages/shared run build
npm --prefix extension install
npm --prefix extension run typecheck
npm --prefix extension run build
```

Load `extension/dist/` as an unpacked extension in a Chromium-family browser.
Open the extension options page and paste the token from
`~/.bro/settings.json`.

## Attribution

The adapter descends from the Apache-2.0 OpenBrowserMCP WebExtension design and
keeps protocol compatibility where useful. New package names and user-facing
project names use `bro`; OpenBrowserMCP is credited in the repository README and
NOTICE.
