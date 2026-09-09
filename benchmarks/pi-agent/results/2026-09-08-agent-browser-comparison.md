# agent-browser CLI vs bro native Pi tools — Luna Max

Date: 2026-09-08. This is a single-sample workflow pilot, not an engine microbenchmark or a universal product ranking.

## Bottom line

The tested **bro native Pi interface** is substantially more efficient for network capture, console capture, and checkout/rollback. **agent-browser CLI + official skill** is competitive for direct DOM/ref interaction; its inline iframe snapshot is particularly useful. Neither interface is uniformly better.

Of eight contemporaneous paired scenarios, each product met the stated task/method contract in **7/8**. Both produced the requested visible end state in 8/8, but two workarounds must not be counted as normal passes:

- agent-browser obtained the post-unregistration state by restarting its browser, not by successfully unregistering the script at runtime.
- bro completed the shadow form with a coordinate-based visual click after ref clicks timed out, violating the narrower ref-based submission requirement.

For the **six pairs where both met the task contract**, summed end-to-end time was **739.0s vs 411.2s**, model tool calls **96 vs 53**, and processed tokens **1.454M vs 0.499M**, agent-browser vs bro. That is approximately **44% less time, 45% fewer calls, and 66% fewer processed tokens** for bro on this particular task mixture. These totals are workload-dependent and especially affected by the checkout recovery path; they do not establish a universal speed multiplier.

## Setup and measurement

- 22 independent Pi `--print --mode json` subagents: 14 agent-browser tasks, eight contemporaneous bro counterparts.
- All recorded assistant models and session thinking settings verified as `openai-codex/gpt-5.6-luna`, `max`.
- agent-browser **0.37.0**, Homebrew installation, version-bundled official skill, `bash`/`read` only. Fresh named headless Chrome for Testing **152.0.7977.82** sessions; no bro tools or profile import.
- bro **1.0.3**, native Pi extension, official skill and `read`; no shell or unrelated tools. Existing headed Helium **152.0.7977.82** connector.
- Sequential execution, alternating first product in paired tasks; `caffeinate`; 600-second deadline per subagent. No timeouts, retries of whole cells, coaching, or product changes during the matrix.
- Recovered the prior complex task contracts and fixtures from session `01a067ea-b184-7503-b5d7-aef99751f1e5`. Observer-only telemetry was added to the local fixtures for both products.
- Timing includes cold skill loading, discovery, model latency, browser operations, and agent cleanup. Coordinator setup/teardown and analysis are excluded. No large sleep gaps were found between message timestamps and monotonic timings.
- Tokens = input + output + cacheRead + cacheWrite, summed once per authoritative assistant message. This is processed volume, **not** unique context or uniformly priced uncached tokens.
- Calls below are **model-visible tool calls**, including skill/reference reads. One `bash` call can contain many CLI commands; one bro facade can contain many browser actions. They are not equal-unit browser action counts. The JSON separately records audited CLI process invocations and requested bro flow steps.
- Validation used tool arguments, actual results, intermediate/final states, local fixture observations, and cleanup checks—not the subagents' success claims.

## Contemporaneous pairs

Each cell is **seconds / model tool calls / processed tokens**.

| Task | agent-browser | bro | Assessment |
|---|---:|---:|---|
| POST + request/header/body capture | 110.3 / 12 / 269.6K | 33.2 / 2 / 18.0K | Both pass |
| Asynchronous console capture | 70.8 / 13 / 171.6K | 45.8 / 4 / 32.0K | Both pass |
| Editable iframe | 44.4 / 8 / 71.4K | 51.0 / 8 / 58.4K | Both pass; small timing difference is inconclusive |
| Nested Shadow DOM form | 65.4 / 10 / 94.8K | 189.9 / 31 / 356.8K | agent-browser passes; bro requires non-ref fallback |
| Screenshot-only canvas drag | 100.1 / 12 / 134.4K | 82.3 / 10 / 120.1K | Both pass; viewport/DPR differ |
| HTML5 drag-and-drop | 79.3 / 13 / 148.3K | 85.4 / 8 / 81.1K | Both pass; small timing difference is inconclusive |
| Login/cart/checkout overview/rollback | 334.2 / 38 / 659.1K | 113.5 / 21 / 189.3K | Both pass; agent-browser needs DOM-click fallback |
| Script persistence + runtime removal | 243.1 / 22 / 550.9K | 56.5 / 7 / 56.6K | bro passes; agent-browser restarts instead of unregistering |

All eight-pair totals, **including the two outcome-only runs**:

| Metric | agent-browser | bro |
|---|---:|---:|
| Task/method-compliant passes | 7/8 | 7/8 |
| Requested visible end state observed | 8/8 | 8/8 |
| Total subagent time | 1,047.6s | 657.5s |
| Model tool calls | 128 | 91 |
| Processed tokens | 2,100,064 | 912,321 |
| Root tool-error results | 6 | 2 |
| Additional shell results hiding command errors | 3 | 0 |

Do not use the all-pair time totals alone to rank completed-task performance: the runtime-script and ref-only contracts were not met by both products.

## Supplemental agent-browser tasks

These have no contemporaneous bro counterpart and must not be compared against historical bro timings as if they were paired trials.

| Task | Seconds | Calls | Tokens | Assessment |
|---|---:|---:|---:|---|
| File upload + decoded content | 47.9 | 8 | 73.0K | Pass; independently observed filename/content |
| TodoMVC mutation/filter/deletion/cleanup | 92.0 | 19 | 215.8K | Pass; intermediate Active/Completed states and empty final list verified |
| AJAX movie results + request evidence | 54.5 | 9 | 101.2K | Pass; rendered rows and matching year request observed |
| Two dynamic GitHub release asset lists | 117.8 | 8 | 99.1K | Pass; eight uploads plus two source archives in each release |
| Existing-tab ownership outcome | 52.9 | 9 | 89.2K | Adapted pass; manual ownership tracking, not native claim/finalize parity |
| Four social searches + result follow-up | 141.6 | 17 | 267.9K | Browser task passes via public Threads result; other sites blocked/login-walled |

agent-browser therefore passes **13/14 stated task contracts**, including the adapted tab task. Its social-task scratch-file writes separately violated the runner's work-directory policy; that operational issue is not hidden inside the browser-success count.

## Findings and owner boundaries

### 1. bro's outcome-level tools remove model work

The POST task takes one browser tool call after reading the bro skill. The agent-browser worker loads core and full references, consults help, stages HAR recording, triggers a fetch, lists requests, reads the response body, stops recording, and closes the browser. It also recovers from an invalid top-level `await` expression.

This is evidence for an interface/workflow advantage, not proof that bro performs HTTP or CDP operations faster. Cold documentation and discovery are part of the measured usage experience.

### 2. agent-browser's frame/ref surface is a useful alternative

Its snapshot automatically inlines the iframe and exposes actionable input/button refs. The worker fills and clicks them without separately enumerating frame IDs. The Shadow DOM task also completes cleanly through refs. bro's frame-aware flow works, but its shadow ref-click path still has a long recovery tail.

### 3. Passing commands do not guarantee successful actions

On Sauce Demo, agent-browser repeatedly returns success for clicks without the expected cart changes or navigation. DOM `.click()` eventually recovers; that task permits it. The cause of the no-op native clicks was not isolated in this experiment, so it is not attributed conclusively to headless mode, React, or the CLI implementation.

On bro's shadow form, two ref clicks report 5-second `Input.dispatchMouseEvent` timeouts; a later computer coordinate click succeeds. The visible output is correct, but the requested ref-only workflow is not healthy. A focused reproduction of that input path is the next useful bro test—not another broad paid matrix.

### 4. Official skill/CLI mismatch plus an invalid script-removal workaround

The installed official guide advertises `addinitscript`; the installed 0.37.0 CLI responds `Unknown command`. The worker eventually uses launch-time `--init-script` to obtain persistence on two pages. It then passes a file path, not a returned script identifier, to `removeinitscript`, which reports `Script not found`.

It closes/restarts Chrome to obtain a third page without the marker and self-reports success. That is **not evidence of successful runtime unregistration**, nor does the failed pathname call prove that every valid use of `removeinitscript` is broken. This run demonstrates documentation/discovery friction and an incorrect model workaround.

### 5. Shell composition can hide failures from the harness

Across the suite, **four shell tool results** contain explicit command errors while returning overall success, because later commands or pipelines determine the shell exit code. Separately, the social worker writes four command-output files to `/tmp` despite an instruction to keep artifacts within its assigned directory. The coordinator deleted those files.

This is operational friction in the tested CLI-plus-shell workflow. It is not a claim that agent-browser's native MCP surface has the same behavior.

## Scope of the conclusion

The evidence supports continuing to use bro's native facades for these multi-step workloads while borrowing ideas from agent-browser's inline iframe/ref experience. It does **not** justify a blanket replacement decision in either direction.

Still unknown:

- agent-browser native MCP performance and usability; this arm was not tested;
- same-browser, same-profile, same-viewport comparisons;
- repeated-sample latency distributions and stability;
- warmed, long-running agent contexts where the skill is already loaded.

A native-MCP arm or repeated samples should be added only if one of those questions would change the actual deployment decision. No extra paid runs were made merely to demonstrate success.

## Totals, cleanup, and artifacts

- 22 subagents, 289 model tool calls, **3,858,547 processed tokens**.
- Sum of subagent durations: **2,211.8s (36m 51.8s)**, excluding setup and analysis.
- Pi catalog-reported cost: **$0.275315**; not an independently verified invoice.
- No active agent-browser sessions remained after teardown; the fixture server stopped.
- Bro left no new benchmark tabs for coordinator cleanup. Temporary registered bro script removal was verified in the worker and guarded by teardown.
- For the tab task, the coordinator independently confirmed the three prepared tabs remained and the temporary fourth tab was absent, then closed the fixture session.
- No personal login state was copied and no real account mutations or completed orders occurred in the reviewed traces.
- Raw sessions, screenshots, and compact audit traces remain only in `$TMPDIR/browser-compare-20260908/`. They are not committed. The aggregate contains trace hashes, not raw page content.
- Product code and installations were not changed during testing. Reports are local, uncommitted artifacts.

Machine-readable results: [2026-09-08-agent-browser-comparison-summary.json](2026-09-08-agent-browser-comparison-summary.json).
