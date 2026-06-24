# Chrome Connector Parity

This document compares bro with the Codex Chrome connector and records the
browser-operation gaps bro should close without losing its batch/concurrent
strengths.

## Summary

Bro is stronger for high-throughput browser work: it has first-class batch
facades (`browser.batch.extract`, `browser.batch.run`, `browser.batch.flow`)
with bounded concurrency and default background-tab cleanup.

The official Chrome connector is stronger for explicit browser session
lifecycle: naming a session, claiming user-opened tabs, and finalizing tabs with
clear keep/close intent. Bro now exposes equivalent primitives:

- `session_name`
- `tabs_claim`
- `tabs_finalize`

## Capability Matrix

| Capability | Chrome connector | Bro before parity work | Bro after parity work |
| --- | --- | --- | --- |
| Use existing logged-in browser profile | Yes | Yes, through the bro WebExtension | Yes |
| List connected browser instances | Yes | Yes: `browsers_context` | Yes |
| Inspect already-open tabs | Yes | Yes: `tabs_context` | Yes |
| Claim an existing user tab | Yes: `claimTab` | Partial: operate by `tabId`, no lifecycle marker | Yes: `tabs_claim` |
| Name an automation session | Yes: `nameSession` | Partial: MCP tab groups used raw `sessionId` | Yes: `session_name` updates session state and tab group title |
| Create task-owned tabs | Yes | Yes: `tabs_create`, `tabs_create_mcp`, facade tools | Yes, with optional `sessionId` ownership tracking |
| Finalize tab lifecycle | Yes: `tabs.finalize({ keep })` | Partial: close individual tabs or `agent_done` | Yes: `tabs_finalize` closes owned tabs unless kept |
| Batch extract independent URLs | Not a primary surface | Yes | Yes |
| Batch run same flow on many URLs | Not a primary surface | Yes | Yes |
| Bounded concurrency | Not a primary surface | Yes, default 6 and max 16 | Yes |
| DOM text extraction facade | Yes via page APIs | Yes: `browser.extract` | Yes |
| Accessibility tree | Yes | Yes: `read_page` and extract fallback | Yes |
| Screenshots / low-level input | Yes | Yes: `computer` screenshot/input | Yes |
| Console/network diagnostics | Available through browser APIs | Yes: `read_console_messages`, `read_network_requests`, `get_response_body` | Yes |
| File upload | Yes | Yes: `file_upload`, `upload_image` | Yes |
| User-visible stop/indicator | Yes | Yes | Yes |
| Avoid reading cookies/password stores | Required safety rule | Required safety rule | Required safety rule |

## Remaining Gaps

Bro still intentionally differs from the official Chrome connector in a few
places:

- No dedicated Playwright object model. Bro exposes focused browser tools and
  JavaScript evaluation instead of a persistent Playwright `Page`.
- No built-in browser-client documentation bootstrap. Bro documents its tool
  surface through MCP tool schemas and the `bro-browser` skill.
- No policy engine for sensitive actions. Agents must continue to apply the
  skill safety rules before sending data, changing state, uploading files, or
  making purchases.

These gaps are acceptable unless a task specifically needs a persistent
Playwright-style page handle. Bro's durable advantage remains bounded parallel
browser work against real logged-in pages.

## Lifecycle Model

Use a stable `sessionId` for any multi-tab task.

1. Call `session_name` with a human-readable name.
2. Use `tabs_create` or `tabs_create_mcp` with that `sessionId` for task-owned
   tabs.
3. Use `tabs_claim` with that `sessionId` for user-opened tabs that must remain
   open by default.
4. Call `tabs_finalize` once at the end. It closes owned tabs not listed in
   `keep`, leaves claimed tabs open, and clears session tracking state.

Batch facade tools remain preferred for independent read/extract work because
they already own and clean up their tabs internally.
