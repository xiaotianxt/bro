# Extension Adapter

bro uses a minimal Chromium-family WebExtension adapter. The Go server owns
MCP transport, auth, tool schemas, routing, facade behavior, batching, cleanup,
and tests. The extension owns only the browser APIs that Go cannot call from a
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
reports connected only after the server acknowledges authentication.

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

## Temporary Extension Pause

Settings and `extensions_status` / `extensions_pause` / `extensions_resume`
provide an explicit, profile-wide pause with a recovery journal and alarm.
The `management` permission is required. `debugger_diagnose` inspects best-effort
frame origins without CDP; empty inventories are inconclusive. See
[extension pause](extension-pause.md) for authorization, recovery limits and the
isolated cross-extension regression test.

## Build

```bash
pnpm install
pnpm --filter @bro/shared build
pnpm --filter @bro/extension typecheck
pnpm --filter @bro/extension test
pnpm --filter @bro/extension build
```

For packaged installs, `bro setup` copies the extension to `~/.bro/extension`
and registers the native messaging host `com.xiaotianxt.bro` that hands the
extension its token. For source checkouts, load the build in place:

```bash
make build && bin/bro setup browser --extension-dir extension/dist
```

Load that directory as an unpacked extension in a Chromium-family browser.

## Pairing and Updates

The manifest `key` pins the extension ID to `ibnjnpacbcpiodnhpgmnohhnhgpkmieg`,
whatever folder it loads from. The Chrome Web Store copy has the store-assigned
ID `egeefldabokambagodmbjnahnagobakb`, because store uploads cannot carry a key.
The native host's `allowed_origins` admits only those two IDs
(`internal/nativehost`). When no token is stored, or the server closed
the last socket with a policy violation before acknowledging it, the bridge
client sends `{"type":"pair"}` with `chrome.runtime.sendNativeMessage` and
stores the token it gets. A browser without the host keeps the typed token.

After each authenticated connect the extension compares its running version
with `manifest.json` on disk and reloads when they differ. `bro serve`
refreshes `~/.bro/extension` from the packaged copy at start, so an upgrade
followed by a service restart moves the extension to the new version.

The Chrome Web Store rejects a `key` in uploads and assigns the listing its own
ID. The release's `bro-extension-store-<tag>.zip` drops the key; a listing's ID
must be added to `nativehost.ExtensionIDs` for its installs to pair.

## Attribution

The adapter descends from the Apache-2.0 OpenBrowserMCP WebExtension design and
keeps protocol compatibility where useful. New package names and user-facing
project names use `bro`; OpenBrowserMCP is credited in the repository README and
NOTICE.
