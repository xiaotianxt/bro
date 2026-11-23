# bro Agent Notes

This repo ships bro: a Go MCP server for controlling a local browser
through a minimal WebExtension adapter.

## Boundaries

- Keep the Go core and bro WebExtension protocol small and compatible with
  each other.
- Bind local services to `127.0.0.1` by default.
- Do not print authentication tokens. It is acceptable to print the settings file path.
- Do not put site-specific research policy in the bridge layer. Reddit/GitHub/forum workflows belong in extractor/workflow modules after the protocol bridge is stable.
- Prefer structured JSON output for diagnostics that agents consume.

## Invariants

- `~/.bro/settings.json` stores the local bearer token: `{ "token": "..." }`.
- WebSocket `/ws` accepts an extension only after the first frame is a valid authenticated `connect` message.
- `browserId` means extension `instanceId`.
- Default browser selection is the latest connected instance.
- Every pending tool call has a bounded timeout and is completed on extension disconnect.
- Extension tool errors become MCP tool results with `isError=true`; transport/protocol failures remain Go errors.

## Verification

Run before handoff:

```bash
make check
```

For extension behavior, also run the real-browser contracts in an isolated
profile. While iterating, run only the affected check by name substring; run
all of them once before handoff:

```bash
make live-refs CHROME_BIN=/path/to/chromium CHECKS="T:"
```

`make check` runs its parts at once and prints each part's output as one
block. `CHECKS` takes a name substring or several joined by `|`
(`CHECKS="R:|WATCH:"`). Checks marked `exclusive` in `scripts/live-refs.mjs`
run alone; the rest run `LIVE_CONCURRENCY` (default 4) at a time on one MCP
session, which is real agent usage. Mark a check exclusive only when it
activates or closes tabs, takes window focus, asserts which tab is active,
or loads the extension so heavily that other calls stall; a check that fails
only under concurrency is a finding to explain, not a reason to serialize it.
Chrome freezes background tabs once it holds more than about six, so a
concurrent suite freezes bro's targets the way an agent's many tabs do; `FROZEN:`
freezes them on purpose through DevTools and discards them through
`chrome://discards`, which the suite enables in its profile.

To confirm a flake, run N whole suites at once (each has its own Chrome,
profile, bro port and output directory) and read the passes per check. Heavy
runs go to the mini; give each session its own `BRO_REMOTE_DIR`:

```bash
BRO_REMOTE_DIR=dev/bro-remote-mine scripts/remote.sh make live-refs-repeat N=3 CHROME_BIN=/Applications/Helium.app/Contents/MacOS/Helium
```
