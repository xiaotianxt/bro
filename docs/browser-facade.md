# Browser Facade

The browser facade is the agent-facing layer above raw tab and CDP tools. It
shortens common browser workflows without baking in website policy. Developer
invariants (ownership, reconnect authority, ref retention, cleanup) live in
[Interaction internals](interaction-internals.md).

## Choosing a tool

- Known URLs, reading only: `browser.extract` (one) or `browser.batch.extract`
  (several, in parallel).
- The same interaction on several pages: `browser.batch.flow`.
- One interactive page: `browser.open` → `browser.observe` →
  `browser.click` / `browser.fill` / `browser.press` (or `browser.act` for
  several steps at once) → `browser.close`.
- A page the user already opened: `browser.current.extract`.
- Console or network evidence: `browser.console.capture` /
  `browser.network.capture`.

Tool search is for advanced capabilities, not ordinary page work.

## Interaction: open → observe → click/fill/press → close

`browser.open` takes a `url`, opens an owned background tab, and returns
`targetId` as soon as the page starts loading; the first observe or act waits
(up to 4 s) for the page to load and show text.

`browser.observe` reads the target as compact accessibility text with short
refs such as `kqx12`. Read content with `mode: text`; use a11y only to find
refs to act on:

```text
Frames: 1
Frame "MAIN" "https://shop.example/item"
  RootWebArea "Item"
    [kqx27] main ""
      [kqx130] radio "16GB RAM+512GB SSD" checked="false"
```

Options: `refId` scopes to that node's subtree; `filter: interactive` keeps
controls only; `depth`, `maxChars` (default 8000, at most 12000) and `compact`
bound output. Truncated output ends with `continue with cursor=N` and lists
unread sections as refs: scope to one with `refId`, or pass `cursor: N` with the
same scope for the next part. `mode: text` reads plain main-frame text instead
(`maxChars`, default 12000, at most 20000, and `cursor` apply).
A node keeps its ref across rereads; navigation or replacement needs a fresh
observation. A native date/time input is one node (`Date "Expires"`) filled
with an ISO value such as `2026-12-15`; its month/day/year parts are not
listed. A text line that repeats its parent's name is omitted.

`browser.act` runs 1–32 ordered steps on `targetId`:

- `navigate` (`url`) — waits for the new document
- `evaluate` (`code`, optional `frameId`) — awaited JavaScript expression;
  use an IIFE for statements
- `click`, `fill`/`select` (`value`), `check` — by `refId`, or by `role` +
  `name` resolved when the step runs (main frame; exact name, else a unique
  substring; ambiguity fails; a miss names same-named elements with other
  roles)
- `scroll` (`refId`, `direction`, `amount`) — moves the ref's nearest
  scrollable container, else the page
- `wait` (`text`, `textGone`, or `refId` + `state` visible/hidden/enabled/disabled;
  `timeoutMs` default 5000, at most 15000) — after a step that loads content,
  wait for what you expect instead of guessing a delay; not met in time is
  reported and later steps still run
- `check` (`checked` default true) — sets a native radio/checkbox without a
  pointer click, so it works under covering overlays
- `press` (`key`: Escape, Enter, Tab, ArrowDown, `Shift+Tab`…) — a trusted key
  press to the focused element, or to `refId` / `role` + `name` after focusing
  it; Escape closes panels that have no close button
- `observe` — same options as `browser.observe`; default `maxChars` 3000; if
  its `refId` scope was replaced, it observes the page and says so

All steps validate before any effect; the first failure stops the rest. Each
completed step reports one line, and failures come first:

Each click/fill/select/check waits until the main frame's DOM has been quiet
for 400 ms (at most 3 s) and reports what visibly changed: opened or closed
dialogs, menus and listboxes, new alerts and invalid fields, new text, and
navigation. A navigation the step started (a form post) holds the wait until
the new document arrives, else it reports `navigating to`. A click that opens a
layer also lists refs for the layer's controls (the first 12, then `observe
<layer ref> for N more`), so the next step can use them without observing. A
click with no visible change says so, which usually means it missed. Chain
dependent steps directly, with no delays and no `evaluate` to read the page
back:

```json
{"targetId":"TARGET","steps":[
  {"type":"click","role":"button","name":"Access"},
  {"type":"click","role":"menuitem","name":"Read and write"},
  {"type":"click","role":"button","name":"Generate token"}
]}
```

```text
targetId: flow-1c05d07adf32
clicked kqx130 (button "Access") → opened menu "Access"; controls kqx131 menuitem "Read-only", kqx132 menuitem "Read and write" (settled 420ms)
clicked kqx132 (menuitem "Read and write") → closed menu "Access"; text "Access: Read and write" (settled 450ms)
clicked kqx133 (button "Generate token") → alert Expiration date can't be blank (settled 610ms)
```

A change that starts after more than 400 ms of quiet (a slow request) is not
in the report; follow such a step with a `wait`. The report covers the main
frame only.
A covered click fails without dispatching and names the covering element and
its overlay as refs, for example `Target kqx130 is covered by kqx402 <input
placeholder="Enter your email"> inside overlay kqx400 <div role="dialog">`.
Dismiss the overlay (observe `kqx400` for its close control) or use `check` for
radios/checkboxes. There is no silent fallback to JavaScript clicks; `evaluate`
is the explicit escape hatch.

`browser.click`, `browser.fill` and `browser.press` run one act step each, with
the same targets and the same one-line report; they keep a single action as
small as `{"refId":"kqx12"}`. `targetId` is optional on observe, act and these
three: it defaults to the target this MCP session last opened or used.
`browser.close` still names its target.

`browser.close` closes the owned tab. Pi closes unfinished targets at session
end.

## Batch Flow

`browser.batch.flow` opens each URL in an owned background tab, runs the same
steps on every tab, and closes them. Steps use act's names: `navigate`,
`evaluate`, `click`/`fill`/`select` by `css`, `wait` (`ms`), `read_text`, and
unscoped `observe` (`goto`/`eval` remain accepted aliases). Refs cannot be used
because every tab is new.

```json
{
  "inputs": [
    { "id": "a", "url": "https://example.com/a" },
    { "id": "b", "url": "https://example.com/b" }
  ],
  "steps": [
    { "type": "click", "css": "#reviews" },
    { "type": "wait", "ms": 1000 },
    { "type": "evaluate", "code": "document.title" }
  ]
}
```

Options: `urls` instead of `inputs`, `concurrency` (default 6, max 16),
`timeoutMs` (default 12000 per URL), `cleanup` (default true), `active`
(default false). Each item returns its step results, plus `stoppedAt` and
`error` when a step failed.

## Batch Extraction

`browser.batch.extract` opens independent URLs in background tabs, extracts
visible text, and closes the tabs.

```json
{ "urls": ["https://example.com/a", "https://example.com/b"] }
```

Options: `inputs` (`{id, url}`, exclusive with `urls`), `concurrency` (default
6, max 16), `maxChars` (default 8000), `includeLinks` (default false; enable
only when links are part of the answer), `maxLinks` (default 20),
`includeA11y` (accessibility fallback when DOM text is not ready), `cleanup`.

## Single and Current-Tab Extraction

`browser.extract` is the one-URL version. It returns `status` (`ok`,
`partial`, `failed`), `text`, `links` and `diagnostics`.

`browser.current.extract` reads the current/default active tab in one call, for
pages the user already opened (`maxChars`, `includeLinks`).

## Console and Network Capture

`browser.console.capture` opens a URL, evaluates one trigger expression and
returns the console messages it produced, in one call:

```json
{ "url": "https://example.com", "code": "document.querySelector('#go').click()" }
```

`browser.network.capture` does the same for requests: it evaluates `code`,
waits for a request matching `urlIncludes`, and returns bounded response
bodies (`maxBodyChars` is shared by all bodies). Headers and post data are
opt-in. Both clean up by default; prefer them to the raw monitoring tools,
which lose state when the service worker suspends.

## Design Rule

The facade may compose generic browser mechanics. It must not learn website
semantics such as "how Reddit search works" or "how LinkedIn renders posts".
Those belong in downstream skills or user workflows.
