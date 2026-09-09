# Scroll workflow: source study, owner-layer fix and measured comparison

Introduced in **v1.1.0**. The measurements below were made on the release candidate before deployment; they remain historical evidence, not a guarantee about every website.

## What agent-browser actually does

Source pinned to agent-browser **v0.37.0**, commit
[`471ab3852b47b98847f1d9c855c272bb62d0d50b`](https://github.com/vercel-labs/agent-browser/tree/471ab3852b47b98847f1d9c855c272bb62d0d50b).

- [`cli/src/native/interaction.rs`](https://github.com/vercel-labs/agent-browser/blob/471ab3852b47b98847f1d9c855c272bb62d0d50b/cli/src/native/interaction.rs#L369): element scrolling resolves an object/ref, then calls `this.scrollBy(dx, dy)` through `Runtime.callFunctionOn`; page scrolling calls `window.scrollBy`. This path is **not mouse-wheel input** and does not await a rendering barrier.
- [`cli/src/native/actions.rs`](https://github.com/vercel-labs/agent-browser/blob/471ab3852b47b98847f1d9c855c272bb62d0d50b/cli/src/native/actions.rs#L5865): `handle_scroll` uses the selected page session and returns `scrolled: true`. It does not independently prove application-level UI updates.
- [`cli/src/native/browser.rs`](https://github.com/vercel-labs/agent-browser/blob/471ab3852b47b98847f1d9c855c272bb62d0d50b/cli/src/native/browser.rs#L1540): tab creation selects a new page; explicit tab switching also brings it forward.
- [`cli/src/native/cdp/chrome.rs`](https://github.com/vercel-labs/agent-browser/blob/471ab3852b47b98847f1d9c855c272bb62d0d50b/cli/src/native/cdp/chrome.rs#L460): its managed-browser launch includes `--disable-backgrounding-occluded-windows`. This is not the same as making every background tab render normally, and bro must not assume such flags in a user's existing browser.
- [`cli/src/commands.rs`](https://github.com/vercel-labs/agent-browser/blob/471ab3852b47b98847f1d9c855c272bb62d0d50b/cli/src/commands.rs#L636): correct syntax is `scroll down 100 --selector @ref`. The previously observed `scroll @ref down 100` is malformed; unrecognized directions can reach the no-delta path and still return success. bro keeps strict direction/amount validation rather than copying that behavior.
- [`cli/src/main.rs`](https://github.com/vercel-labs/agent-browser/blob/471ab3852b47b98847f1d9c855c272bb62d0d50b/cli/src/main.rs#L2127): `batch --bail` executes multiple CLI commands in one invocation. It is a real optimization, not a capability absent from agent-browser.

The decisive difference in the failed bro case was not the spelling of `scrollBy`: bro changed `scrollTop` in a hidden tab without allowing the event-driven visible status to update. Copying the same assignment, adding a fixed sleep, or trusting the offset alone would not fix that owner layer.

## Chosen fix

The existing ref-input preparation is shared by clicks and scrolling:

1. Validate the original ref identity.
2. Activate/focus the target tab/window and reveal its frame/element.
3. Check the target/ancestor hit surfaces and geometry; no guessed replacement target.
4. Perform the requested scroll **once**, using `behavior: instant` for deterministic pixel semantics.
5. Await real rendering frames, not an arbitrary time delay or synthetic scroll event.
6. Verify target connectivity; measure actual offsets and the current range after handlers have run.

An action that needs rendering no longer pretends to be a background-only operation. Ordinary extraction remains background-capable. No global browser flags are required for the fix.

`scroll_element` returns bounded structured data:

```json
{
  "refId": "OBSERVED_REF",
  "before": {"x": 0, "y": 0},
  "after": {"x": 0, "y": 100},
  "requested": {"x": 0, "y": 100},
  "delta": {"x": 0, "y": 100},
  "extent": {"x": 0, "y": 920},
  "moved": true,
  "boundary": false,
  "renderSynchronized": true
}
```

A boundary call reports `moved:false`, not a fictitious movement. Ranges are measured after event handlers, so newly appended content is not mistaken for the previous end. RTL horizontal offsets and reverse flex-column ranges are handled; unsupported writing-mode origins return `boundary:null` rather than an invented answer. No progress away from a known boundary is an error. A replaced target is reported explicitly; the mutation is never replayed automatically.

Rendering synchronization does **not** promise that arbitrary asynchronous network loads have completed. Those still need a task-specific visible readiness condition.

## Efficient bro usage

No new MCP tools are added. The existing `browser.flow.act` accepts a ref-only `scroll` step:

```json
{"sessionId":"FLOW","steps":[
  {"type":"scroll","refId":"PANEL_REF","direction":"down","amount":100},
  {"type":"read_text"},
  {"type":"scroll","refId":"PANEL_REF","direction":"down","amount":10000},
  {"type":"read_text"},
  {"type":"scroll","refId":"PANEL_REF","direction":"down","amount":100},
  {"type":"read_text"}
]}
```

The native scroll barrier makes each following read useful. `read_text` does not create a new AX snapshot, so the same ref can be reused while its node/document remains valid. Default direction is down, default amount 400 CSS pixels; amount must be 1–10000. Invalid direction, target or amount is rejected before executing earlier steps in that request. Fresh-tab `browser.batch.flow` cannot accept these existing-tab refs.

## Efficient agent-browser usage

After obtaining the real panel ref from a snapshot, a valid alternative is one CLI batch with explicit UI conditions:

```bash
# Replace @e1 with the actual observed panel ref.
printf '%s' '[
  ["scroll","down","100","--selector","@e1"],
  ["wait","--text","SCROLL_TOP:100"],
  ["read"],
  ["scroll","down","10000","--selector","@e1"],
  ["wait","--text","SCROLL_TOP:920"],
  ["read"],
  ["scroll","down","100","--selector","@e1"],
  ["read"]
]' | agent-browser batch --bail --json
```

This exact approach was independently executed successfully: eight commands in one invocation, about **145ms excluding the model, browser preparation and initial snapshot**. It must not be compared directly with 30–60 second end-to-end model timings. The competitor's underlying operation was already fast.

## Verification

- Red: a newly created hidden tab returned internal movement while its actual output element still contained `SCROLL_TOP:0`, not 100.
- Green: the same test reads `SCROLL_TOP:100` immediately after the scroll returns, without screenshot/manual activation/fixed sleep.
- A second real-browser contract starts hidden and executes all scroll/read stages in one flow call; visible states are exactly 100/920/920, with moved flags true/true/false and boundary flags false/true/true.
- Unit cases cover actual movement, boundary/no-replay behavior, event-driven range growth, RTL offsets, disconnected targets and non-scrollable axes.
- Rust parsing checks cover invalid direction, absent/ref+CSS targets, empty ref, zero/negative/oversized amount, and rejection of refs in fresh-tab batches.
- `make check`: 45 Rust, 37 extension and 20 Pi adapter tests passed. Eleven real-browser contract groups passed.

Use the isolated build/run instructions in [ref-interaction.md](ref-interaction.md). `live-refs.mjs --checks background` selects the two relevant lifecycle contracts. Model comparisons remain explicitly opt-in.

## Model-level results (Luna/max, two trials per product/configuration)

Same local scroll fixture, viewport 1280×857, DPR 2, browser version and acceptance criteria. Both products retain their normal interface and official skill. All valid runs verified visible states, not just offsets.

| Configuration | bro mean time / calls / processed tokens | agent-browser mean time / calls / processed tokens |
|---|---:|---:|
| Normal skill-driven usage | **43.7s / 7 / 53.8K** | 60.5s / 14 / 162.4K |
| Both given equivalent best-known batching hints | 38.6s / **5 / 38.5K** | 36.7s / 8 / 78.1K |

Both products passed 2/2 in each valid configuration. Normal usage improved bro's mean runtime by about 28% relative to the contemporaneous agent-browser arm, with 50% fewer model tool calls and about 67% fewer processed tokens.

With batching guidance, time is effectively comparable at this sample size: bro has fewer calls/tokens, but is **not faster in the observed mean**. Therefore the evidence does not support “universal domination,” an engine-level speed multiplier, or optimizing against a deliberately inefficient competitor.

Two initial guided bro cells were interrupted by clamshell sleep/network failures and excluded. Their wall spans were roughly 17 and 33 minutes despite much smaller active-clock durations. macOS sleep logs corroborated the interruption. Only those two cells were replaced, after waking and restarting the isolated test environment; the valid agent-browser cells were retained. The runner now records wall/active-clock gaps and stops on sleep/provider invalidation.

These are small pilot samples, not statistically powered latency distributions. They resolve the observed background-scroll defect and demonstrate a shorter workflow; they do not close the separately observed missed-nested-click investigation.

Detailed metrics and provenance: `benchmarks/pi-agent/results/2026-09-09-scroll-optimization-summary.json`.
