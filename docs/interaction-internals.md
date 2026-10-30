# Interaction Internals

Developer contracts behind `browser.open/observe/act/close`, `browser.batch.*`
and legacy `browser.flow.*`. The model-facing usage is in
[Browser facade](browser-facade.md); keep invariants here so the injected
prompt stays small.

## Targets and authority

`browser.open` returns `targetId`, pinned to the authenticated browser
connection and tab even if the default browser later changes. Reconnection
invalidates that authority: an old target cannot act on or close a replacement
connection's reused tab ID. `ownerSessionId`/`label` are ownership identity
(Pi supplies them), never the target handle. Borrowing existing user tabs is
not part of this API.

## Readiness

URL navigation waits for the intended document's DOMContentLoaded, not
network idle. Redirects are preserved. A failed readiness wait prevents
dependent steps. Fragment navigation keeps the document identity and must
establish its readiness too; `interactive` alone is insufficient while deferred
scripts run. Navigation out of a browser-internal source uses webNavigation
document identity without weakening debugger-access checks.

`browser.open` defers readiness (`tabs_create` `deferReadiness`): the tab is
registered and owned before navigation is dispatched, and open returns once it
is, so close, Pi shutdown cleanup and late-allocation reclaim apply unchanged.
The target's first observe or act settles it: a main-frame probe polls every
250 ms, up to 4000 ms, until the document left `about:blank`, passed
DOMContentLoaded (`readyState` is not `loading`), and shows readable text (the
same 120-character rule as text observation). At the cap the call proceeds and
shows whatever the page has; it never fails for slowness. A page that loaded
during the model's turn costs one probe. Every other caller (batch, extract,
`flow.start`) still waits for readiness inside `tabs_create` and closes the tab
when it fails; the extension keeps `allowNotReady` for compatibility, unused by
the facade. Application
readiness is an explicit act `wait` condition or observe/evaluate contract.

## Act execution and results

The whole input is validated before effects. A runtime failure or request
cancellation stops subsequent steps; cancellation does not undo dispatched
effects. There is no branch/loop/rollback language or implicit action replay.
Empty evaluation code is invalid; empty evaluation values are valid results.

Results are split by audience:

- `content` text (what the model reads): the failure line first, so it
  survives error truncation, then `targetId`, then one line per completed step
  (`clicked kqx12`, `navigated: URL`, `evaluated: VALUE`, `observed:` + text).
- `structuredContent`: `{targetId, status, stoppedAt?, results[]}` where each
  result is `{type, refId?, checked?, url?, result?, content?, error?}`.
  Adapters track targets from `browser.open`/`browser.close` structured content.

Connection identity (`browserId`), cleanup flags and per-step acknowledgements
are deliberately absent: `status: ok` means the steps executed, not that the
site's postcondition holds. `browser.observe` returns the observation text as
content and `{targetId, content}` as structured content.

Observe budgets: standalone 8000 characters, 3000 inside act/flow.act, 8000 in
batch.flow. Facade ceilings (observe, act, batch.flow): `maxChars` above 20000
is rejected, matching the schema, and a11y budgets above 12000 are reduced to
12000. Text is the cheap way to read content; a11y exists to find refs, and
models otherwise request 16000–20000 a11y characters by habit. Legacy
`flow.observe`/`flow.act` keep the 1.3 bound of 60000.

Truncated a11y output reports the effective budget and `cursor=N` (node lines
emitted so far); frame headers are always repeated so a continued page keeps
its context. The footer then lists, as refs, the unread landmarks that are not
nested in another landmark and unread level 1–3 headings, in document order,
within min(600, maxChars/10) characters reserved from the budget, so a caller
can scope instead of rereading with a bigger budget. `find` has no outline.
Cursor pages reconstruct a whole read exactly (no node line dropped or
repeated). A budget that cannot fit the next node line fails instead of
returning a cursor that never advances.
Text mode keeps its 12000-character default; `maxChars` bounds it and `cursor`
is a character offset (a continuation skips the readiness retry, since a tail
may legitimately be short). Only `refId/filter/depth/compact` are a11y-only.

If the frame inventory changes while an a11y observation collects (the
document navigated or a frame was replaced), the read is retried once on the
new inventory and its text starts `document changed during observe; reread`.
Nothing was rendered or published by the failed attempt. A second change fails
the observation. A scoped read whose scope left with the old document fails as
`Scoped ref …`, so act's page fallback still applies.

Every failure to resolve an observation scope starts `Scoped ref <ref>`. In
`browser.act` only, such a failure re-reads the page with the same budget and
filter (scope and cursor dropped) and prefixes `scope <ref> was replaced;
observed page`: observation is read-only, so failing would discard the record
of the steps already executed. Standalone observe and legacy flow.act still fail.

Act `wait` takes exactly one condition and no fixed delay: `text` appears or
`textGone` disappears in the main frame's rendered text (`innerText`, compared
case- and whitespace-insensitively, because CSS text-transform changes
`innerText` but not the accessible name a model copies), or `refId` reaches
`state` visible/hidden/enabled/disabled (`get_element_info`). It polls every
250 ms up to `timeoutMs` (default 5000, at most 15000) and returns as soon as
the condition holds. Not meeting it is a step result (`met: false`, rendered
`wait not met after N ms: …; continuing`), not a failure, so later observe
steps still show the page. A check that fails transiently (a navigation in
flight) counts as not yet met, and the last such error is reported on timeout.
A ref that left the document satisfies `hidden` and fails the other states,
which can never hold for it. `ms` is rejected in act; batch.flow and legacy
flow.act keep `wait` `ms` with their 0–30000 ms clamp and reject conditions.

Every CDP command shares one 5000 ms reply bound, and a timeout detaches the
debugger so the next command reattaches cleanly; raising it would delay that
recovery for all commands. An evaluation that hits it fails with "the
expression awaited too long or the page's main thread was busy" and points to
a condition wait step: in the 1.4 F evaluation every such timeout was a
`setTimeout` sleep of 8–10 s used as a wait.

## Covered controls and `check`

Trusted ref clicks keep occlusion checks. A hit is accepted when it is the
target, a flat-tree descendant (slotted content included), a composed ancestor
below `<body>`, or a `<label>` whose control is the target: input there reaches
the control. A hit on `<html>`/`<body>` or nothing means the point shows no
content (offscreen, clipped, zero-size) and fails as "not visible at its click
point", never as covered. A rejected hit is re-measured once after scrolling
into view and two animation frames; there is no further retry and no guessed
coordinate. When the hit still lands on another element, no input is
dispatched; the extension resolves the hit element and its outermost
fixed/sticky/dialog ancestor with `DOM.describeNode`, registers both as
ordinary refs, and names them in the error. If that diagnosis finds the target
itself (it re-rendered between tests), the error says it moved, not covered.

Ref scroll moves the element a user scroll at the ref would move: the ref, or
its nearest composed ancestor that overflows on that axis with
`overflow: auto|scroll|overlay` (only the ref itself may be `hidden`), else the
frame's document scroller. The result names it (`document` or a fresh ref) and
fails only when nothing on that axis can scroll.

`check` maps to `form_input` with `checked`. It accepts only native checkbox
and radio inputs (custom ARIA controls must be clicked), treats a visually
hidden input as visible when one of its labels is, and uses the element's
activation behavior (`click`/`input`/`change`) rather than pointer input. A
checked radio cannot be unchecked directly. The final state is verified.

## Refs

Refs are `<epoch><sequence>`, e.g. `kqx297`: a three-letter random epoch per
registry plus a sequence that is never reissued within that epoch. After a
service-worker restart the registry is empty and has a new epoch, so an old
ref fails with "from an earlier page registry" instead of resolving to a
different node. Across restarts, a colliding epoch (1/17576) still requires the
same tab to have re-issued that sequence number; target authority adds a
second guard, because a restart also replaces the bridge connection.

The volatile registry keeps at most 10,000 refs across tabs, evicting the
oldest issued first (handles in the response being published are protected).
Reads do not refresh age. Identity, frame and failure contracts are in
[Frame-aware ref interaction](ref-interaction.md).

## Cleanup ownership

`browser.close` closes only the owned tab and releases its target; failed
cleanup retains the handle for retry. Pi closes unfinished targets at session
shutdown and restores them across reload; already-closed tabs count as cleaned.

Facade allocation keeps cleanup responsibility even when a caller is dropped or
a batch item times out before the creation reply. A late allocation is
reclaimed on its original connection. Batch cleanup transfers responsibility to
one spawned task before any await; timeout results report scheduled, not
completed, cleanup. Failures emit a structured warning with tab and target IDs;
there is no automatic retry. The 30-second bridge bound and 2-second cleanup
bound still apply: a lost reply or disconnected browser is not proof that an
effect was undone.

## Legacy flow compatibility

`browser.flow.start/observe/act/finish` keep their 1.3 signatures and result
envelopes (`sessionId`, `goto`/`eval` names, CSS targets, `wait`, `read_text`,
optional cleanup). They share the same ownership state, executor, readiness and
ref registry; they are not a second engine, and are discoverable but not active
by default. `fill` uses native setters and dispatches input/change; `select`
accepts an option value or unique visible label. `scroll` requires a ref,
accepts 1–10000 CSS pixels, emulates focus without activation and returns
measured movement. `browser.batch.flow` accepts CSS/eval templates, not refs.
