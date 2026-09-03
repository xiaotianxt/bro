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
pi install git:github.com/xiaotianxt/bro@v1.0.1
```

For development from a checkout:

```bash
pi install /absolute/path/to/bro
```

Then start a new Pi session or run `/reload`.

## Behavior

- MCP tool names are normalized, for example `browser.batch.extract` becomes `bro_browser_batch_extract`.
- Common facade and flow tools are active by default.
- `bro_search_tools` enables additional tools through Pi's dynamic tool loading.
- Pi's session ID is supplied to bro tab-lifecycle tools when the caller omits `sessionId`.
- MCP errors become failed Pi tool results rather than successful text containing an error.
- Text output is bounded to Pi's 50 KB / 2,000-line tool limit.
- Session shutdown finalizes Pi-owned tabs and unfinished browser flows; `/reload` preserves them for the continuing session.

## Development

```bash
pnpm --filter @xiaotianxt/pi-bro typecheck
pnpm --filter @xiaotianxt/pi-bro test
```

Run the opt-in live transport test against a local bro server with:

```bash
BRO_LIVE_TEST=1 pnpm --filter @xiaotianxt/pi-bro test
```
