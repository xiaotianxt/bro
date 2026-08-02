# bro Agent Notes

This repo ships bro: a Rust-native MCP server for controlling a local browser
through a minimal WebExtension adapter.

## Boundaries

- Keep the Rust core and bro WebExtension protocol small and compatible with
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
- Extension tool errors become MCP tool results with `isError=true`; transport/protocol failures remain Rust errors.

## Verification

Run before handoff:

```bash
make check
```
