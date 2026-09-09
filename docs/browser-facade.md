# Browser Facade

The browser facade is the agent-facing layer above raw tab and CDP tools. Its
purpose is to shorten common browser workflows without baking in website policy.
The browser execution layer remains a minimal WebExtension adapter; bro does
not claim a 100% Rust browser runtime.

## Batch Extraction

`browser.batch.extract` opens independent URLs in background tabs, extracts
visible text, then closes tabs by default. Links are opt-in so shopping/search
pages do not flood the agent with navigation and ad URLs.

Minimal input:

```json
{
  "urls": [
    "https://example.com/a",
    "https://example.com/b"
  ]
}
```

Useful options:

- `inputs`: array of `{ "id": "...", "url": "..." }` when stable result IDs
  matter
- `concurrency`: defaults to 6, clamped to 16
- `maxChars`: defaults to 8000, clamped to 60000
- `maxLinks`: defaults to 20, clamped to 200
- `includeA11y`: defaults to false; when true, accessibility tree is used as a
  fallback only when DOM extraction is not ready
- `includeLinks`: defaults to false; enable it only when links are part of the
  answer or follow-up crawl
- `cleanup`: defaults to true

`urls` and `inputs` are mutually exclusive.

## Batch Flow

`browser.batch.flow` opens independent URLs in owned tabs, runs the same ordered
flow steps on each tab, and closes the tabs by default. Use it when every page
needs the same interaction before data can be read, such as clicking a common
reviews button, waiting for a modal, and returning a structured `eval` result.

Minimal input:

```json
{
  "inputs": [
    { "id": "a", "url": "https://example.com/a" },
    { "id": "b", "url": "https://example.com/b" }
  ],
  "steps": [
    { "type": "wait", "ms": 1000 },
    { "type": "eval", "code": "document.title" }
  ]
}
```

Useful options:

- `concurrency`: defaults to 6, clamped to 16
- `timeoutMs`: defaults to 12000 per URL, clamped to 60000
- `cleanup`: defaults to true
- `active`: defaults to false

Each item returns the per-step result list, `stoppedAt` when a step fails, and
the item error. The tool keeps browser mechanics generic; selectors and scripts
remain task-local policy supplied by the caller.

## Single Extraction

`browser.extract` is the one-URL version. It returns:

- `status`: `ok`, `partial`, or `failed`
- `text`
- `links`
- `diagnostics`

Diagnostics include the source used, readiness, elapsed time, and fallback
attempts. Empty diagnostic fields are omitted from the JSON result.

## Current Tab Extraction

`browser.current.extract` reads the current/default active tab without first
calling `browsers_context` or `tabs_context`. Use it when the user says a page
is already open or when the task is to inspect the current logged-in page.

```json
{
  "maxChars": 8000,
  "includeLinks": false
}
```

The extension includes the resolved `tabId` in the extraction payload when
available, so the facade can still use fallback readers inside the same MCP
tool call.

## Console Capture

`browser.console.capture` keeps console monitoring, trigger execution, message
collection, and cleanup inside one MCP call. Use it when a click or evaluated
expression is expected to emit a log or exception.

```json
{
  "url": "https://example.com",
  "code": "document.querySelector('#trigger').click()",
  "timeoutMs": 5000
}
```

The trigger may be an expression or a zero-argument function and returned
Promises are awaited. Use raw `read_console_messages` only for deliberate
interactive monitoring.

## Network Capture

`browser.network.capture` keeps the whole debugging transaction inside one MCP
call so Manifest V3 service-worker suspension and model think time cannot discard
monitoring state between tools.

```json
{
  "url": "https://httpbin.org/html",
  "code": "fetch('/anything?bro=benchmark').then(r => r.json())",
  "urlIncludes": "/anything?bro=benchmark",
  "includeResponseBodies": true
}
```

The facade opens an owned background tab, waits for initial page readiness,
enables CDP network events, evaluates and awaits the trigger expression, waits
for a matching request to finish, includes bounded response bodies, and cleans
up by default. A zero-argument function expression is also accepted and invoked.
Headers and post bodies remain opt-in because they are sensitive and verbose.
`maxBodyChars` is a total budget shared by all returned bodies.

Use raw `read_network_requests` and `get_response_body` only for deliberate
interactive diagnostics where losing extension-memory state is acceptable.

## Flow

Use `browser.flow.*` for sequential interaction with one leased tab.

The following ref-first workflow is available in v1.1.0 and later; server and
extension must be upgraded together.

1. `browser.flow.start` opens a tab and returns `sessionId`.
2. `browser.flow.observe` defaults to a compact accessibility snapshot, including
   iframe trees and Shadow DOM labels. `mode:text` explicitly reads main-frame text.
3. `browser.flow.act` runs ordered `goto`, awaited `eval`, `click`, `fill`,
   `select`, ref-only `scroll`, `wait`, and `read_text` steps. For click/fill/select, pass the exact
   `refId` from the latest snapshot instead of manually locating frames.
4. Observe application outcomes, then call `browser.flow.finish` to release
   state and close the tab.

`fill` uses the native input/textarea value setter and dispatches input and
change events so controlled frameworks observe the update. `select` validates
the option value, uses the native select setter, and dispatches the same events.
Eval code is a JavaScript expression; wrap multiple statements in an IIFE rather
than using a top-level `return`.

`scroll` requires a snapshot `refId`, accepts direction and 1–10000 CSS pixels,
foregrounds the target, and waits for rendering before returning measured
movement/boundary data. Combine it with `read_text` steps to verify intermediate
visible UI without new model turns or invalidating refs. This does not wait for
arbitrary network-loaded content; use explicit readiness conditions for that.
See [Scroll interaction](scroll-interaction.md).

If a step fails, `browser.flow.act` stops at that step, returns prior results and
the failure location, and marks the outer MCP result as an error.

A ref already identifies its tab, frame, document and node. Do not combine it
with `css` or `frameId`. New snapshots replace previous refs; navigation or DOM
replacement requires a fresh observation. Ref-based select accepts an option
value or a unique visible label. Ref clicks use trusted input and foreground
the tab/window; they do not fall back to JavaScript clicks.

For deliberate CSS/eval workflows, `frames_list` and explicit `frameId` remain
available, including out-of-process frames. `read_text` without a frame ID is
still main-frame-only. `browser.batch.flow` creates new tabs and accepts CSS/eval
templates, not refs obtained on another tab.

See [Frame-aware ref interaction](ref-interaction.md) for identity/actionability
contracts, limits, and the reproducible real-browser and subagent tests.

## Design Rule

The facade may compose generic browser mechanics. It must not learn website
semantics such as "how Reddit search works" or "how LinkedIn renders posts".
Those belong in downstream skills or user workflows.
