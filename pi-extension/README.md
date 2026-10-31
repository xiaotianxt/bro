# @xiaotianxt/pi-bro

Native Pi tools for the local [bro](https://github.com/xiaotianxt/bro) browser MCP server.

The adapter keeps one authenticated MCP connection per Pi session, discovers tool schemas from bro itself, and exposes them with a `bro_` namespace. Common high-level browser tools are active immediately; lower-level tools can be enabled with `bro_search_tools`.

## Requirements

- `bro serve` listening on `127.0.0.1:3500`
- a valid `~/.bro/settings.json`
- the bro WebExtension connected when browser operations are needed
- Pi 0.84.4 or newer

The bearer token is read directly from `~/.bro/settings.json`. It is not copied into Pi settings, tool arguments, or logs.

## Install

Install the tagged bro repository as a Pi package:

```bash
pi install git:github.com/xiaotianxt/bro@v1.4.1
```

For development from a checkout:

```bash
pi install /absolute/path/to/bro
```

Then start a new Pi session or run `/reload`. Upgrade the bro server and browser
extension together and reload the browser extension as well. Tool descriptions
come from the running server, not this adapter's package version. When switching
from a development checkout to a tagged install, remove the old local package
entry with `pi remove /absolute/path/to/bro` to avoid loading both copies.

## Behavior

- MCP tool names are normalized, for example `browser.batch.extract` becomes `bro_browser_batch_extract`.
- With 1.4, the server marks the default tools: search, extract/current.extract/batch.extract/batch.flow, and `browser.open/observe/act/close`. Older servers keep the legacy defaults. Internal tools are not registered in Pi; legacy `browser.flow.*` stays discoverable.
- `bro_search_tools` loads server-owned capability packs (tabs, frames, accessibility, console, visual, upload, shortcuts, user scripts). Search `CDP extension recovery` (v1.2.0+) for extension diagnosis/pause/resume, or `1Password login` (v1.3.0+) for same-site, non-CDP login filling that never submits; see [security boundaries](../docs/onepassword-login.md).
- `browser.open` receives Pi's session identity and label automatically; no session naming calls are needed.
- Ref input emulates page focus without activating the user's tab; reserve `tabs_activate` for genuine foreground work.
- MCP errors become failed Pi tool results. Text output is bounded to Pi's 50 KB / 2,000-line limit.
- Session shutdown closes unfinished owned targets and Pi-owned tabs, reporting failures; `/reload` preserves them.

Routing: known URLs → `browser.extract` / `browser.batch.extract`; the same interaction on several pages → `browser.batch.flow`; one interactive page → `browser.open`, then `browser.act` with `observe` steps, then `browser.close`. See [Browser facade](../docs/browser-facade.md).

## Development

```bash
pnpm --filter @xiaotianxt/pi-bro typecheck
pnpm --filter @xiaotianxt/pi-bro test
```

Run the opt-in live transport test against a local bro server with:

```bash
BRO_LIVE_TEST=1 pnpm --filter @xiaotianxt/pi-bro test
```
