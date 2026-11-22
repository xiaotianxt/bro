# Go Migration

The Rust core (`src/`) is being replaced by a Go implementation with the same
external contract: the `bro` binary name, CLI, `~/.bro/settings.json`, the
`/ws` extension protocol, and MCP Streamable HTTP at `/mcp`. The extension,
`packages/shared`, and the Pi adapter are TypeScript and do not move.

The rewrite also shrinks the tool surface. Debt here is mostly API surface
(several generations of overlapping tools) and one oversized facade, not the
language; porting without shrinking would carry it over.

## Method: freeze the contract, then swap the implementation

1. **Contract suite first, green on Rust.** `e2e/` is a black-box Go test
   suite. It starts whatever binary `BRO_BIN` names with an isolated `HOME`,
   connects a fake extension to `/ws`, and drives `/mcp` with the official Go
   MCP SDK. It asserts only what clients and the extension can observe. It must
   pass against the Rust binary before any Go server code exists, which proves
   it catches regressions.
2. **Go implementation until the suite is green**, then `make live-refs`
   (real browser) against the Go binary.
3. **Cutover in one change**: delete `src/`, `tests/*.rs`, `Cargo.*`; switch
   `release.sh`, the Homebrew formula and `scripts/check-version.mjs` to the Go
   build.

Run the contract suite:

```bash
make e2e                      # builds the Rust binary and runs e2e/
BRO_BIN=/path/to/bro go test ./e2e/...
```

## Tool surface

Decided from 8,088 recorded agent calls (Claude Code, Pi, Codex; 2026-07 to
2026-11) plus a check of what the Pi adapter calls on its own. Frequency
reflects what agents were shown, so a tool fully covered by a newer one is
removed regardless of its count.

The MCP surface goes from 62 tools to 43. `e2e/testdata/tools.json`
snapshots the 43 kept tools (names, descriptions, schemas, `_meta`).

Removed from the MCP surface (no contract tests, not implemented in Go). The
facade still dispatches extension tools such as `extract_page` internally;
only their direct MCP exposure goes:

| Tool | Replacement |
|---|---|
| `browser.flow.start/observe/act/finish` | `browser.open/observe/act/close` (same executor) |
| `browser.batch.run` | `browser.batch.extract` |
| `agent_done`, `tabs_claim`, `tabs_create_mcp`, `tabs_context_mcp` | `browser.open`/`attach`/`close` |
| `scroll_element`, `gif_creator`, `shortcuts_list`, `shortcuts_execute`, `get_response_body`, `extract_page` | none; never called |

Merged:

- `browser.current.extract` into `browser.extract` (extract a given or the
  default tab when no URL is passed).
- `click_element`, `fill_element`, `form_input` into `browser.click` /
  `browser.fill` (use `browser.attach` for a tab bro did not open).

Kept although rarely seen in transcripts: `session_name` and `tabs_finalize`
(called by the Pi adapter itself at session start/end, hidden from models), the
1Password tools, `extensions_*`, and `browser.attach` (new in 1.8).

The Pi adapter (`DEFAULT_ACTIVE_UPSTREAM_TOOLS`, `PI_SESSION_TOOLS`, legacy
`browser.flow.finish` cleanup) and the `bro-browser` skill must drop removed
tools in the same release.

## Tests after cutover

- `e2e/` fake-extension contracts: fast, in CI, the main regression gate.
- `make live-refs`: real browser, before handoff. `tests/live_*.rs` fold into it.
- Go unit tests only for pure functions with many edge cases (settings file
  permissions, allowed MCP hosts, upload path canonicalization, 1Password site
  matching). Rust tests that assert parsing or rendering internals are not
  ported; the schema snapshot and e2e cover them.

Not covered by e2e: the 15 s/45 s extension heartbeat (too slow for the suite);
it gets a Go unit test with an injected interval.

## Rust behavior the Go server should not copy

Found while writing the contracts; each is outside the suite on purpose.

- An MCP client that disconnects during `browser.open` leaves the late tab
  open and owned, with a target nobody knows (no `tabs_close` follows).
  Closing a session should cancel its in-flight calls so the late-allocation
  cleanup runs.
- Logs carry ANSI color codes even when stderr is not a terminal (for example
  under `brew services`).
- `browser.extract` and `browser.batch.extract` send the model the full result
  JSON, diagnostics included, as text. The contracts check structured content
  only, so the Go server can send compact text.

## Known gaps

- `bro setup codex` edits `config.toml` with `toml_edit`, preserving comments.
  Go has no maintained format-preserving TOML editor; the Go version replaces
  only the `[mcp_servers.bro]` table text.
- Rust tests used a paused clock. Black-box tests shorten time through tool
  arguments (`timeoutMs`) instead of test-only server switches.
