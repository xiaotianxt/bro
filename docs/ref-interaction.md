# Frame-aware ref interaction

Introduced in **v1.1.0**. Upgrade the server and browser extension together. Existing ephemeral refs must be replaced by a fresh observation after upgrade; use `mode: "text"` explicitly when main-frame plain text is required.

> Follow-up, 2026-09-09: the [24-subagent cross-tool comparison](../benchmarks/pi-agent/results/2026-09-09-ref-tools-comparison.md)
> found background scroll-event/UI propagation lag and one missed nested click.
> The scroll lifecycle/workflow fix and matched retest are now documented in
> [Scroll interaction](scroll-interaction.md). The missed nested click remains
> a separate investigation; neither is hidden with success-only counters.

## User-facing workflow

No new MCP tools are added. `browser.flow.observe` now defaults to a compact native accessibility snapshot containing frame trees, Shadow DOM controls, labels, values and relevant states. `mode: "text"` remains an explicit main-frame text option.

Use the returned opaque refs directly in the existing flow operations:

```json
{"sessionId":"FLOW","steps":[
  {"type":"fill","refId":"REF_FROM_OBSERVATION","value":"Luna"},
  {"type":"select","refId":"ANOTHER_REF","value":"Gamma"},
  {"type":"click","refId":"COMMIT_REF"}
]}
```

The refs identify their own frames. Do not supply `css` or `frameId` with `refId`. CSS operations with optional explicit frame IDs still work. Ref-based selection accepts an option value or a unique enabled visible label.

Typical sequence:

```text
flow.start → flow.observe → flow.act(refs) → flow.observe → flow.finish
```

Ref-only `scroll` steps are also supported in `flow.act`; pair them with
`read_text` to verify intermediate UI states in one call without replacing refs.
See [Scroll interaction](scroll-interaction.md) for foreground/rendering semantics
and structured movement/boundary results.

`read_page`, `find`, `form_input`, `fill_element`, `click_element`, `scroll_element`, `get_element_info`, `wait_for_element`, `file_upload` and `upload_image` share the same ref identity/resolution mechanism. `read_page` defaults to `filter: all`, `compact: true`, `depth: 20`, and a shared 16,000-character budget. Use `filter: interactive` for a shorter controls-only view. `compact: false` retains unnamed structural nodes. Scope `refId` narrows to its AX subtree **within its owning document**; omit it for all frame trees.

## Identity and failure contracts

- Refs are opaque `ref_<snapshot nonce>_<index>` handles, not selectors or page attributes. Do not synthesize them.
- A snapshot replaces earlier refs for that tab. `find` also creates a new snapshot. Batch several actions against one observation; observe again when new nodes are needed.
- Each handle binds to **tab + frame + document loader + browser backend node ID**.
- A ref from another tab or earlier snapshot fails. Cross-document navigation and disconnected/replaced nodes fail rather than falling back to a guessed selector, copied attribute, or a new node with the same label.
- Service-worker restart loses the volatile registry and yields an explicit stale/unknown-ref error. There is no attempt to resurrect uncertain identity.
- `browser.batch.flow` creates new tabs and cannot reuse existing snapshot refs. It accepts CSS/eval templates; the server rejects ref steps before creating tabs.
- Flow argument validation completes before any step executes. Invalid `css + refId`, `refId + frameId`, missing targets, or missing values cannot produce partially executed flows. Runtime failure still stops subsequent steps and propagates MCP failure.
- Clicks foreground the tab/window, check actionability and occlusion, and dispatch trusted CDP input. There is **no JavaScript-click or coordinate-tool fallback**. Internally computed coordinates are part of the ref executor, not an agent-selected alternative target.
- Ancestor iframe geometry is transformed into top-level CSS coordinates. Rendering is synchronized after scrolling before hit testing and dispatch; clicks are never replayed as a timing workaround.
- Form setters reject disabled, inert, read-only and hidden targets in their owning document; invalid select options fail. Clicks additionally check ancestor iframe hit surfaces. Form events are composed across Shadow DOM boundaries and use native setters for controlled-form compatibility. These checks are not a claim of atomic actionability across concurrently changing frame ancestors.
- A click response proves dispatch, not the website's application-level postcondition. Observe the resulting state. Native coordinate input necessarily has a final hit-test/input race; this is not a transaction over a concurrently mutating page.
- Non-scrollable refs fail; a scroll boundary is reported as no movement, not as a successful scroll.
- Protected AX field values are not rendered, and input acknowledgements do not echo the supplied value.

## Mechanism and alternatives

The chosen owner is Chromium's `Accessibility.getFullAXTree` plus backend DOM nodes, rather than extending the handwritten DOM walker. This delegates accessible naming, implicit labels and Shadow DOM composition to the browser and avoids a second accessibility implementation.

Same-process and out-of-process frames are enumerated through flat CDP child-target sessions, recursively attaching nested iframe targets. The extension now declares Chromium 125+ for this debugger-session API; live validation used Chromium 152. The transport session ID is not persisted in refs: actions re-resolve the frame and validate the document loader before resolving the backend node in an isolated world. Child events are not misrouted into root network/console listeners. Concurrent root attachment requests share one attachment operation.

The old content-script walker, page-global lookup map and `data-obmcp-ref-id` identity path are removed. Existing tool names remain; old `ref_N` values must be replaced by a fresh snapshot after upgrade.

The alternative—recursing `iframe.contentDocument` in the old walker—cannot cover cross-origin/OOPIF documents and retains clone/stale-identity problems. A larger DOMSnapshot/interactive-HTML engine remains a separate possible future project, not a dependency of this change.

### Explicit limits

- At most 64 frames per discovery; depth is bounded to 100 and total rendered text to 60,000 characters. Frame-read failures and incomplete documents are reported, not silently presented as fully read.
- Frame blocks preserve parent/child grouping; they are not a perfect reconstruction of each iframe host's DOM position among its siblings.
- Rotated, perspective or flipped iframe transforms are rejected instead of guessing input coordinates. Ordinary borders, padding, offsets, scrolling and axis-aligned scaling are handled.
- AX-hidden controls are not promised to appear. This is not a generic virtualized-feed crawler, closed-shadow source inspector, or complete implementation of the older Page Interaction Engine proposal.
- `get_element_info` now returns bounded JSON details (rather than legacy line-oriented text), including scroll offsets. It labels geometry as frame-local, not top-level input coordinates.

## Deterministic verification

The opt-in test uses a **fresh Chrome for Testing profile and a separate bro process**. The broker gets its own temporary HOME and token; production bro credentials are not needed. No personal profile is copied, and the loaded extension directory is not overwritten. macOS test profiles use a mock Keychain to avoid accessing or waiting on the user's real Safe Storage item. The reserved `refs-cross.test` hostname maps only inside that Chrome instance to loopback, providing a genuine cross-site frame without a public website.

```bash
OUT="$(mktemp -d "${TMPDIR:-/tmp}/bro-refs.XXXXXX")"
# Set CHROME_BIN to the Chrome for Testing binary (agent-browser install can provide it).
make check EXTENSION_OUT_DIR="$OUT/extension"
cargo build
node scripts/live-refs.mjs \
  --extension "$OUT/extension" \
  --chrome "$CHROME_BIN" \
  --output "$OUT/live"
```

Do not use the default `extension/dist` output while it is loaded in your daily browser. `EXTENSION_OUT_DIR` and Vite's output handling make isolated builds explicit. The test defaults to port 3501, refuses production port 3500, and checks port availability. Use `--port` for another unused test port. `--bro` can select an installed release binary for an old/new contract comparison.

Each contract resets the fixture to a fresh document, so a failed group cannot poison the next group's values, counters or overlays. Eleven real-browser contract groups cover:

1. Same-site, cross-site and nested frame discovery with native Shadow DOM labels.
2. Ref fill/select/click in all three forms, including a padded cross-site iframe with a 14px icon-sized button; the fixture verifies `isTrusted=true` for clicks and composed input events reaching the document.
3. Cross-tab and previous-snapshot ref rejection.
4. Clone/replacement/disconnected-node rejection without changing the replacement field.
5. Covered/disabled clicks, read-only controls and invalid options, with error reasons and unchanged page state.
6. Iframe navigation invalidating its former document's refs.
7. Cross-site file upload with decoded filename/content verification.
8. Default flow observation, ref-only flow steps, parse-before-effect validation and runtime fail-fast behavior.
9. `find`/info/wait/scroll interoperability, actual scroll offsets and explicit no-movement boundary reporting.
10. Fresh-background-tab scrolling delivers event-driven visible UI before returning.
11. One flow call batches three scroll/read pairs with visible 100/920/920 states and correct boundary flags.

The same suite can be kept alive for model acceptance with `--serve`; wait for the `Serving isolated fixtures` message. SIGTERM triggers cleanup of the owned browser, server and profile.

## Restricted subagent acceptance

This is opt-in and uses model quota; `make check` does not call models.

```bash
python3 benchmarks/pi-agent/run-refs.py \
  --control "$OUT/live/control.json" \
  --output "$OUT/agents"
```

Default: `openai-codex/gpt-5.6-luna`, `max`. Optional `--models luna,mini,spark` requires account support for those models.

The test reuses the real Pi adapter with an injected isolated endpoint. Only four flow tools are available. A test gate rejects JS/CSS/manual-frame fallback, and the report independently checks tool output for all three fixture results. It does not trust the model's final success claim.

Observed pilot on 2026-09-08:

- Luna/max: **35.033s, 5 calls, 18,669 processed tokens, zero tool errors or prohibited attempts**.
- One `flow.act` performed all nine fill/select/click operations across the three iframe forms.
- All three statuses included `trusted=true:input=2`; the model explicitly finished its flow.
- Mini was rejected by the provider before inference or tool use (unsupported with this ChatGPT account). It is an invalid environment cell, not a bro success/failure. The runner stopped rather than spending more calls on an unsupported matrix.

The pilot preceded the final padded/tiny-button and scroll-contract additions and test-credential isolation cleanup. Those final changes were verified by the deterministic browser suite, without extra paid model calls. This is functional acceptance, not a statistically powered speed ranking against the earlier, differently configured benchmark. See the aggregate report in `benchmarks/pi-agent/results/2026-09-08-ref-interaction-summary.json`.

## Release boundary

v1.1.0 releases the matching Rust server and extension together. Upgrade Homebrew, reload the browser extension, synchronize the bro skill, and reload the agent's tool catalog. Older 1.0.3 clients can retain main-frame text via explicit `mode: "text"`; numeric refs from before the upgrade are not reusable.
