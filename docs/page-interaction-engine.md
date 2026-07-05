# Page Interaction Engine

## Summary

bro should add a browser-side Page Interaction Engine that improves page
reading and operation reliability while preserving the current product
strengths: local browser control, background execution, parallel batching, small
bridge protocol, and Rust-owned facade policy.

The engine is not a new agent loop. It is a generic page model plus a
verification-oriented action layer.

```text
Rust facade / MCP tools
  -> extension tool registry
  -> Page Interaction Engine
       -> snapshot/read model
       -> element identity model
       -> CDP-first action executor
       -> post-action verification
  -> Chromium tab / CDP / content script helpers
```

The design borrows proven mechanics from browser-use and Playwright:

- browser-use: combine DOMSnapshot, DOM tree, accessibility tree, shadow DOM,
  iframe state, backend node IDs, paint order, and action watchdogs.
- Playwright: treat actionability as a first-class concept: visible, stable,
  enabled, receives events, focused, then verify the result.
- Codex Browser Use: expose multiple interaction surfaces over one tab
  lifecycle: Playwright-style locators, DOM-node CUA, coordinate CUA, raw CDP
  capability, screenshots, dialogs, tab claiming, and explicit tab finalization.
- page-agent: use concise LLM-facing interactive HTML as one rendering format,
  but do not adopt its in-extension LLM loop.

## Problem

bro is strong at parallel background browsing, but weak at understanding and
operating modern dynamic pages.

Current failure modes:

- pages with shadow DOM expose poor text and poor interactable structure
- iframes and nested scroll containers are hard to read and operate
- virtualized feeds hide content outside the current viewport
- custom controls look like generic divs
- React, rich text, and contenteditable inputs often need more than setting
  `.value`
- click targets can be occluded by overlays or child elements
- action results are returned as text without enough machine-readable evidence
- waits are mostly caller-driven instead of tied to page state changes

The durable fix is not a bigger prompt or site-specific policy. The owner layer
is the generic browser mechanism inside the extension.

## Goals

- Preserve background-tab and batch execution behavior.
- Improve page observation for dynamic pages without site-specific logic.
- Make element references more durable across multi-step MCP workflows.
- Make click, fill, scroll, and select operations CDP-first and verified.
- Return structured diagnostics that agents can use to recover.
- Keep Rust as the facade and policy owner.
- Keep extension APIs generic and small.

## Non-Goals

- No LLM agent loop inside the extension.
- No Playwright runtime embedded in bro.
- No site-specific recipes in the bridge or engine.
- No persistent browsing trace storage by default.
- No claim that every page can be automated without fallback or user help.

## Source Facts

Current bro architecture:

- Rust owns MCP transport, auth, facade behavior, batching, cleanup, routing,
  and response limits.
- The extension owns Chrome APIs, debugger/CDP, content scripts, page-side JS,
  and tool execution.
- Current `read_page` injects an accessibility-tree helper and returns a text
  tree keyed by `ref_N`.
- Current extraction has DOM quiet readiness and keeps batch/background behavior.
- Current actions already use CDP for mouse/keyboard primitives, but the DOM
  tools still rely heavily on content-script `refId` lookup and direct DOM
  mutation.

Relevant outside designs:

- browser-use now uses a CDP-native actor/watchdog layer. It collects
  `DOMSnapshot.captureSnapshot`, `DOM.getDocument({ pierce: true })`, and
  `Accessibility.getFullAXTree`, then builds enhanced nodes with
  `backendNodeId`, bounds, AX data, computed styles, iframe/shadow structure,
  and selector maps.
- browser-use click execution scrolls elements into view, computes visible
  quads, checks occlusion, dispatches CDP mouse events, and falls back to JS
  click when required.
- Playwright's practical reliability comes from locator actionability checks and
  auto-wait semantics, not from selectors alone.
- page-agent's strongest reusable output is simplified interactive HTML, not
  its full `PageAgentCore`.
- Codex Browser Use exposes a useful product shape for browser automation:
  `domSnapshot()` as locator ground truth, locators for semantic operations,
  DOM-node CUA as fallback, coordinate CUA for visual cases, raw CDP as an
  advanced capability, and session/tab finalization to avoid leaving automation
  clutter behind.

## Architecture

### Reference Model: Codex Browser Use

Codex Browser Use is useful as an API and workflow reference, even if bro should
not copy its runtime.

Important patterns to adopt:

- One browser session owns tabs and must explicitly finalize them.
- User-owned tabs can be claimed instead of duplicated.
- A tab exposes multiple interaction surfaces:
  - Playwright-style locator API for semantic operations.
  - DOM-node CUA for direct node-id clicks/typing/scrolling from a visible DOM
    snapshot.
  - Coordinate CUA for visual fallback.
  - Raw CDP capability for advanced development and diagnostics.
  - Screenshots and dialog APIs as first-class observations.
- A DOM snapshot is treated as the source of truth for locator construction.
- Failed locators are not retried blindly; refresh the snapshot and rebuild the
  target.
- Before acting on a locator, confirm uniqueness when it is not obvious.
- After each action, collect the cheapest observation that answers the next
  decision: targeted state check, fresh DOM snapshot, screenshot, URL check, or
  CDP event read.
- Raw CDP event access uses cursors so action observation can be incremental
  instead of repeatedly dumping all state.

bro should translate these into MCP/facade semantics:

```text
Codex Browser Use       bro equivalent
------------------      -----------------------------------------
tab.playwright          semantic renderers + future locator helpers
tab.dom_cua             refId/nodeId actions from PageSnapshot
tab.cua                 existing computer coordinate tool
tab.capabilities.cdp    existing CDP session plus event buffering
browser.user.claimTab   tabs_claim
browser.tabs.finalize   tabs_finalize / browser.flow.finish
domSnapshot discipline  read_page snapshot version + stale detection
```

The main architectural lesson is to expose layered fallbacks intentionally,
instead of blending every strategy into one opaque tool.

### 1. Page Snapshot Layer

The engine should produce a structured `PageSnapshot` inside the extension.

The snapshot is the canonical read model. Text formats are renderers over this
model, not the source of truth.

```ts
interface PageSnapshot {
  tabId: number
  snapshotId: string
  url: string
  title: string
  viewport: {
    width: number
    height: number
    scrollX: number
    scrollY: number
    devicePixelRatio: number
  }
  readiness: {
    documentReadyState: string
    source: 'cdp_snapshot' | 'dom_script' | 'fallback'
    elapsedMs: number
    partial: boolean
    warnings: string[]
  }
  nodes: PageNode[]
  rootNodeIds: string[]
}

interface PageNode {
  nodeId: string
  refId?: string
  backendNodeId?: number
  frameId?: string
  parentNodeId?: string
  children?: string[]
  shadowRoot?: boolean
  iframe?: {
    sameOrigin: boolean
    contentRootNodeId?: string
    hiddenInteractiveHints?: HiddenElementHint[]
  }
  tag?: string
  role?: string
  name?: string
  text?: string
  attrs: Record<string, string>
  rect?: DOMRectLike
  visible: boolean
  enabled?: boolean
  editable?: boolean
  checked?: boolean
  selected?: boolean
  scrollable?: Scrollability
  topLayer?: boolean
  hasJsClickListener?: boolean
  occlusion?: 'unknown' | 'clear' | 'occluded'
  fingerprint: ElementFingerprint
}
```

The initial implementation can be smaller. The important invariant is that the
engine keeps a structured model and exposes renderers from it.

### 2. Snapshot Sources

Use a tiered source strategy.

Primary source for active or debuggable tabs:

- `DOMSnapshot.captureSnapshot`
- `DOM.getDocument({ depth: -1, pierce: true })`
- `Accessibility.getFullAXTree`
- `Page.getLayoutMetrics`

Fallback source:

- current content-script tree and DOM quiet extraction
- page-side JS traversal for environments where a CDP snapshot fails

The primary source should run CDP calls in parallel with bounded timeout. Heavy
optional probes, such as event-listener detection, must have budgets and skip
automatically on large pages.

### 3. Element Identity

Keep `refId` because MCP tools already use it and agents need a compact stable
handle.

Add `backendNodeId` and fingerprint internally.

```text
refId: stable within a tab/session for tool calls
backendNodeId: CDP action handle for the current document lifecycle
fingerprint: recovery handle when DOM changed or WeakRef is gone
index: optional short observation number for LLM-facing renderers
```

Fingerprint should avoid dynamic noise:

- tag
- role
- accessible name
- stable attributes: id, name, aria-label, placeholder, type, href path, test ids
- text prefix
- approximate rect
- ancestor hints

Dynamic classes and transient state should not dominate matching.

### 4. Renderers

The engine should expose several renderers over `PageSnapshot`.

`a11y_tree`

- compatible with current `read_page`
- still uses `ref_N`
- good for simple interactions and accessibility-oriented pages

`interactive_html`

- page-agent/browser-use style compact markup
- includes only meaningful text and interactable elements
- marks scroll containers with scroll hints
- includes form constraints such as required, pattern, min/max, accept,
  autocomplete, inputmode

Example:

```text
Current Page: [Checkout](https://example.com/checkout)
Page info: 1440x900 viewport, 1440x3800 page, 1.2 pages below

[0 ref_8]<input type="email" name="email" autocomplete="email" required placeholder="Email" />
[1 ref_9]<button>Continue</button>
|SCROLL ref_20|<div aria-label="Shipping options"> ... 6 items below ...
```

`text_extract`

- article/search-style text and links
- keeps current batch extraction use case fast
- should not flood agents with every DOM node

`json_debug`

- full diagnostics for tool authors and regression tests
- not the default agent-facing output

`screenshot_context`

- optional renderer/companion output for visual ambiguity
- includes screenshot dimensions and highlight metadata, not always the image
- used when DOM and visual layout disagree

### 5. Action Executor

Actions should use a shared executor instead of each tool hand-rolling page JS.

```text
resolve ref
  -> refresh or recover node if stale
  -> check actionability
  -> scroll into view
  -> choose coordinates or DOM method
  -> execute CDP-first action
  -> verify result
  -> fallback if needed
  -> return structured result
```

#### Click

Default path:

1. Resolve `refId` to `backendNodeId`.
2. `DOM.scrollIntoViewIfNeeded`.
3. Compute visible quad or rect.
4. Clamp click point to viewport.
5. Check `document.elementFromPoint` against the target or a valid descendant.
6. Use `Input.dispatchMouseEvent` move/press/release.
7. Observe URL, focus, dialog, download, checked state, and DOM mutation.
8. If CDP click does not affect expected state, fall back to `element.click()`
   for controls where JS activation is acceptable.

Locator discipline from Codex Browser Use applies to ref-based actions too:

- Do not act on ambiguous generated selectors.
- If a ref cannot be resolved, refresh the snapshot once and attempt
  fingerprint recovery.
- If recovery finds multiple candidates, return an ambiguity error with the
  top candidates rather than choosing the first match.

#### Fill

Default path:

1. Resolve element and validate editability.
2. Click/focus with CDP.
3. Clear using keyboard shortcut or DOM selection.
4. Insert via `Input.insertText` or key events.
5. Verify `value`, text content, or selection state.
6. For React/custom inputs, use native value setter plus input/change events as
   fallback.
7. For contenteditable, use `beforeinput`/`input` with selection and
   `execCommand('insertText')` fallback where still practical.

#### Select

Handle real `<select>` separately from custom comboboxes.

- Native select: set selected option and dispatch change, then verify value.
- Custom combobox: click opener, observe popup/listbox/menu, then click matching
  option by text/role.

#### Scroll

Scroll should support:

- page-level CDP gesture
- mouse wheel at coordinates
- element container scroll
- iframe content scroll where accessible
- fallback JS scroll

Return before/after scroll positions and whether more content appears available.

### 6. Actionability

Expose actionability as internal checks and optional diagnostics.

Checks:

- exists
- visible according to style and viewport
- non-zero rect
- enabled/not disabled
- editable for fill
- receives events at chosen point
- stable enough for action
- not blocked by modal overlay unless clicking overlay target

The action should return `isError=true` for protocol/actionability failures, not
pretend success because an event was dispatched.

### 7. Post-Action Observation

Each action should include bounded post-action observation.

Signals:

- URL changed
- page lifecycle changed
- CDP event cursor advanced
- DOM mutation count changed
- focused element changed
- element value/text/checked changed
- new popup/dialog/download
- network quiet if a CDP session has useful lifecycle events

Result shape:

```ts
interface ActionResult {
  ok: boolean
  action: 'click' | 'fill' | 'select' | 'scroll'
  snapshotId?: string
  refId?: string
  method: 'cdp' | 'dom_fallback' | 'hybrid'
  before?: ActionObservation
  after?: ActionObservation
  verification: {
    passed: boolean
    signals: string[]
    warnings: string[]
  }
  error?: {
    code: string
    message: string
    recoverable: boolean
  }
}
```

MCP tools can render this as concise text by default, but facade tools should be
able to consume the structured result.

## Tool Surface

Keep existing tools compatible.

Enhance:

- `read_page`
  - add `mode`: `a11y` | `interactive_html` | `text` | `json_debug`
  - keep default compatible initially
  - return a `snapshotId` in machine-readable output modes
- `click_element`
  - keep `refId`
  - optionally accept `snapshotId` for stale-action diagnostics
  - return structured metadata as JSON or concise text
- `fill_element`
  - keep `refId`, `text`
  - optionally accept `snapshotId`
  - verify final value/text
- `scroll_element`
  - keep `refId`, `direction`
  - add container-aware behavior
- `get_element_info`
  - source from `PageSnapshot`
  - include actionability diagnostics
- `wait_for_element`
  - use snapshot refresh and fingerprint matching

Future optional additions, following Codex Browser Use without committing to the
full surface immediately:

- `page.locator_preview`: resolve a semantic query to unique candidate refs
- `page.cdp.events`: read bounded CDP event buffers for diagnostics
- `page.screenshot_context`: screenshot plus highlighted refs for visual
  disambiguation

Add internal extension tools only if needed:

- `page.snapshot`
- `page.render`
- `page.action`

Avoid exposing too many new public MCP tools until the internal engine has
settled.

## Rust/Extension Boundary

Extension owns:

- CDP snapshot collection
- bounded CDP event buffering for action observation
- page model construction
- element ref registry
- action execution
- post-action browser signals

Rust owns:

- public MCP schemas
- facade defaults
- batch scheduling
- flow session state
- response size limits
- cleanup
- policy about whether to call observe/action/extract

This preserves the existing architecture rule: the extension performs browser
mechanisms; Rust owns product behavior.

## Implementation Plan

### Phase 1: Page Snapshot MVP

Add `extension/src/background/page-engine/`.

Minimum files:

- `snapshot.ts`
- `types.ts`
- `renderers/a11y.ts`
- `renderers/interactive-html.ts`
- `identity.ts`

MVP behavior:

- build nodes using current content script plus CDP layout metrics
- keep current `refId` map
- generate `snapshotId`
- render current a11y output from snapshot
- add `interactive_html` output behind `read_page.mode`

Verification:

- existing `read_page` output stays compatible
- `pnpm --filter @bro/extension typecheck`
- focused tests for rendering and ref parsing

### Phase 2: CDP Snapshot Enrichment

Add CDP primary collector:

- `DOMSnapshot.captureSnapshot`
- `DOM.getDocument({ depth: -1, pierce: true })`
- `Accessibility.getFullAXTree`
- `Page.getLayoutMetrics`

Merge into `PageSnapshot`:

- `backendNodeId`
- AX role/name/properties
- bounds and computed visibility
- shadow DOM
- same-origin iframe content when available

Fallback to Phase 1 collector on failure.

Verification:

- fixture pages with shadow DOM, iframe, hidden elements, scroll containers
- budget tests for large DOMs
- diagnostics show source and partial warnings

### Phase 3: Action Executor

Add:

- `actions/resolve.ts`
- `actions/actionability.ts`
- `actions/click.ts`
- `actions/fill.ts`
- `actions/scroll.ts`
- `actions/verify.ts`

Migrate `click_element`, `fill_element`, and `scroll_element` onto executor.

Keep old implementation as a temporary fallback until live tests pass.

Add Codex-style action discipline:

- reject stale `snapshotId` when the caller provides one and the page clearly
  changed
- refresh snapshot before retrying stale or missing refs
- return ambiguity instead of using positional fallback silently
- use targeted post-action checks before taking expensive full snapshots

Verification:

- React input fixture
- checkbox/radio fixture
- contenteditable fixture
- occluded button fixture
- scrollable container fixture
- dynamic route change fixture

### Phase 4: Facade Integration

Update Rust facade behavior:

- `browser.flow.observe` can request `interactive_html`
- `browser.flow.act` gets structured action results
- batch extraction remains text-first and fast
- batch flow can use verified actions when steps are click/fill/scroll
- `tabs_claim` and `tabs_finalize` stay the lifecycle model for user/current
  browser tabs; richer engine state should be cleaned up when these run

Verification:

- existing `browser.batch.extract` speed does not regress materially
- flow sessions get better recovery diagnostics

### Phase 5: Dynamic Page Quality

Add bounded advanced probes:

- event listener detection with element count budget
- virtualized list hints
- table/form-specific renderers
- hidden interactive hints above/below viewport
- cross-origin iframe placeholder with frame URL/title when available

Verification:

- live regression pages for search/social/SaaS-like dynamic layouts
- no site-specific logic in engine

## Performance Budget

Defaults should protect batch execution.

Suggested budgets:

- normal snapshot: 500-1500 ms target
- hard snapshot guard: 3000 ms for interactive observe
- batch extraction should keep current text path unless `mode` asks for rich
  snapshot
- event listener detection skipped above 10k elements or 300 ms
- max nodes serialized to agent output: clamp by chars and node count
- CDP calls parallelized when independent
- CDP event buffers are bounded by count and age; cursors are best-effort
  diagnostics, not durable logs

The engine must surface `partial: true` with warnings instead of blocking
indefinitely.

## Failure Behavior

Failure classes:

- `snapshot_timeout`
- `snapshot_partial`
- `element_not_found`
- `element_stale`
- `not_actionable`
- `occluded`
- `not_editable`
- `cdp_action_failed`
- `verification_failed`
- `ambiguous_target`
- `stale_snapshot`

Recoverable failures should include hints:

- refresh observation
- scroll container
- use a different ref
- refresh snapshot and rebuild the target
- click parent/child candidate
- wait for page quiet

## Security And Privacy

- Do not print tokens or secret field values.
- Mark sensitive fill values so logs can redact text.
- Do not persist snapshots by default.
- Do not persist CDP event buffers beyond the live tab/session.
- Do not send page snapshots anywhere except through requested MCP tool output.
- Keep site-specific workflow knowledge out of the extension.

## Testing Strategy

Unit tests:

- attribute filtering and fingerprint stability
- renderer output clamps
- ref/index parsing
- actionability decisions
- error classification

Browser fixture tests:

- shadow DOM button/input
- same-origin iframe form
- nested scroll container
- occluded element
- custom select/listbox
- React controlled input
- contenteditable editor
- virtualized list sample

Live regression tests:

- dynamic search/social pages already used by bro
- current batch extraction tests
- flow observe/act tests

Required pre-handoff checks remain:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
pnpm --filter @bro/shared build
pnpm --filter @bro/extension typecheck
pnpm --filter @bro/extension build
```

## Success Metrics

Reading:

- `read_page mode=interactive_html` identifies controls on shadow DOM and
  dynamic pages where current a11y output is noisy or empty.
- `get_element_info` explains why an element can or cannot be clicked/filled.
- Dynamic pages return scroll/hidden-content hints instead of flat text only.

Operation:

- React controlled input fill verifies final value.
- contenteditable fill verifies final text.
- click handles occlusion with a clear error or fallback.
- scroll targets the correct container when the document itself does not move.

Operational:

- batch extraction remains fast by default.
- failures are diagnostic, not silent.
- extension remains policy-free.

## Open Decisions

1. Should `read_page` default stay `a11y` until a release boundary, or switch to
   `interactive_html` once fixtures pass?
2. Should public tools expose structured JSON by default or only when
   `format=json` is requested?
3. How much cross-origin iframe content should bro attempt through CDP targets
   before marking it as a placeholder?
4. Should action verification use network quiet by default, or only DOM/URL/focus
   signals to preserve speed?
5. Should bro expose a public locator helper, or keep locators internal and only
   expose refs from `read_page`?

## Recommended Next Step

Build Phase 1 and Phase 3 together for the narrowest high-value slice:

- `read_page mode=interactive_html`
- shared `PageSnapshot` with current ref registry
- CDP-first `click_element`
- verified `fill_element`
- container-aware `scroll_element`

This slice directly addresses the current pain while keeping the architecture
reviewable. CDP snapshot enrichment can then replace the MVP collector without
changing public tool semantics.
