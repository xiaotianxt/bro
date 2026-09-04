# Pi Tool Design From Agent Benchmarks

Status: revised after the 2026-09-03 `v1.0.1` pilot and post-fix benchmark.

## Decision

Do not expose the complete bro catalog initially, but do not reduce the Pi default to extraction-only tools either.

Keep high-level extraction, flow, and one-call network capture active. Keep raw tab, DOM, JavaScript, and monitoring primitives discoverable but inactive. The next reduction experiment should happen only after dynamic loading can activate coherent capability packs.

The benchmark confirmed that a shorter list which causes extra model turns is not a more efficient interface.

## Workload and method

Fifteen isolated Pi subagents ran sequentially against bro `v1.0.1`. Built-in tools, skills, context files, and unrelated extensions were disabled. The three model configurations were:

- GPT-5.3 Codex Spark, low thinking
- GPT-5.4 Mini, medium thinking
- GPT-5.6 Sol, high thinking

Five tasks covered eight sites and distinct browser workloads:

- GitHub dynamic release assets
- Reddit, LinkedIn, X, and Threads search in one batch
- an asynchronously loaded element requiring interaction
- Sauce Demo login and product sorting
- a page-side fetch requiring network request and response-body inspection

Metrics include task outcome, wall time, tool calls, nested and outer tool failures, input/output/cache token volume, and reported model cost. Raw sessions remain local because browser output is sensitive. Aggregate data is in `benchmarks/pi-agent/results/2026-09-03-v1.0.1-summary.json`.

This is a product-discovery pilot with one run per model/task cell, not a statistically powered model ranking.

## Results

### Task outcomes

| Task | Success | Mean time | Mean calls | Mean billed tokens |
|---|---:|---:|---:|---:|
| Social batch extraction | 3/3 | 30.7 s | 1.3 | 9,920 |
| Dynamic loading interaction | 3/3 | 38.5 s | 5.0 | 15,410 |
| GitHub dynamic release page | 2/3 | 51.6 s | 7.7 | 45,963 |
| Sauce Demo login and sort | 2/3 | 144.0 s | 22.7 | 1,014,322 mean / 106,266 median |
| Network request and body inspection | 0/3 | 139.1 s | 25.7 | 145,687 |

Batch extraction is already an effective outcome-level API. The initial multi-step interaction had a high tail cost, and the initial raw network workflow was not agent-usable.

### Post-fix flow and network benchmark

After adding one-call network capture, typed select steps, framework-aware input setters, shorter flow IDs, awaited eval, and outer error propagation, the three models repeated the two failing/high-tail tasks:

| Task | Before | After | Mean time | Mean calls | Mean billed tokens |
|---|---:|---:|---:|---:|---:|
| Network request and body | 0/3 | 3/3 | 139.1 → 12.7 s | 25.7 → 1.3 | 145,687 → 6,925 |
| Sauce Demo login and sort | 2/3 | 3/3 | 144.0 → 30.6 s | 22.7 → 6.0 | 1,014,322 → 23,563 |

Spark's previously failed Sauce Demo run fell from 238.5 seconds, 39 calls, and 2.90 million billed tokens to 19.4 seconds, 5 calls, and 21,061 tokens. With `browser.network.capture` active by default, Spark and Sol completed the network task in one tool call; Mini used one search call plus capture.

Adding the network facade to the default tool set increased the controlled GPT-5.4 Mini no-op request from 1,630 to 2,231 input tokens. The additional 601 schema tokens are justified by the network task's reduction from 145,687 to 6,925 mean billed tokens. This should be revisited if server-owned capability packs make one-turn discovery reliable.

### Model outcomes

| Model | Success | Mean time | Mean calls | Mean billed tokens |
|---|---:|---:|---:|---:|
| Spark | 3/5 | 87.1 s | 14.2 | 611,393 |
| Mini | 3/5 | 63.8 s | 8.6 | 46,220 |
| Sol | 4/5 | 91.5 s | 14.6 | 81,167 |

Spark's mean is dominated by one failed Sauce Demo run: 39 calls and 2.90 million billed tokens. Stronger reasoning did not repair a missing workflow abstraction: Sol spent 51 calls and 276 seconds on the network task and still failed.

## Decisive evidence

### 1. Four initial tools are cheaper per prompt but much more expensive per task

A no-op GPT-5.4 Mini request measured:

- no browser tools: 39 input tokens
- extraction-only default plus `bro_search_tools`: 974 input tokens
- `v1.0.1` nine-tool default: 1,630 input tokens
- post-fix ten-tool default with network capture: 2,231 input tokens

The extraction-only default saves 656 initial input tokens. On the dynamic interaction task, however, it caused every model to search and assemble a workflow from individual low-level tools:

| Model | Current: time/calls/tokens | Minimal: time/calls/tokens |
|---|---|---|
| Spark | 50.9 s / 8 / 26,452 | 124.8 s / 19 / 91,829 |
| Mini | 27.2 s / 3 / 8,989 | 194.9 s / 24 / 157,025 |
| Sol | 37.3 s / 4 / 10,789 | 206.7 s / 31 / 138,576 |

The saved schema tokens were overwhelmed by extra model turns. After capability packs were added, the same extraction-only experiment improved to 27.7 s / 8 calls / 32,664 tokens for Spark, 52.9 s / 8 / 35,701 for Mini, and 32.4 s / 5 / 13,232 for Sol. This removes the catastrophic search behavior but still regresses Mini substantially versus the current default, so the four flow tools remain initially active.

### 2. Tool execution success is not task success

`bro_browser_extract` returned successful tool results on all nine calls, but GitHub's release page initially exposed `Assets … Loading`; agents needed additional flows or an API page. One model reported eight uploaded assets while the visible release page contained ten downloadable items including source archives.

A useful benchmark must therefore track both:

- protocol/tool execution; and
- whether the returned evidence satisfies the user outcome.

### 3. Raw network monitoring is structurally incompatible with model latency

Across the three network tasks:

- `bro_read_network_requests` was called 23 times;
- 22 calls returned no recorded requests;
- one call failed because `tabId` was omitted;
- no model reached `bro_get_response_body`;
- task success was 0/3.

Even `timeoutMs:0` did not make a direct multi-call probe reliable. Monitoring state lives in the Manifest V3 service worker and must survive model think time between MCP calls. It cannot be treated as a dependable cross-turn primitive.

The implemented durable fix is `browser.network.capture`, a single owner-layer operation that performs:

1. attach and enable network monitoring;
2. execute navigation, interaction, or JavaScript trigger;
3. wait for matching requests;
4. collect request metadata and selected response bodies;
5. stop monitoring and clean up;

inside one MCP request. The post-fix task succeeded 3/3 with a 95% reduction in mean tool calls and billed token volume.

### 4. Flow failures are partially hidden

`bro_browser_flow_act` was called 86 times. Seven calls contained nested failed steps. Several were returned with outer `status: "ok"`, so Pi and the model saw a nominally successful tool result even when a click or JavaScript evaluation failed.

Observed recurring failures included:

- unsupported `select` steps;
- selectors that matched no element;
- JavaScript written as a function body with top-level `return` when the tool expected an expression;
- form interactions that continued after an earlier failed step.

`browser.flow.act` now enforces that promise: embedded extension errors become bridge errors, execution stops at the failed step, and a failed facade status becomes MCP `isError=true`. The schema also exposes `select`, documents required companion fields, and defines eval as an awaited JavaScript expression.

### 5. Automatic lifecycle cleanup is necessary

Agents started 15 flows but explicitly finished only seven. The Pi adapter's shutdown cleanup is therefore product behavior, not optional convenience. Cleanup must remain automatic while preserving `/reload` continuation semantics.

### 6. Hidden capability retention benchmark

A second matrix ran 18 valid subagents against a deterministic local fixture. It tested outcomes that the ten default tools do not completely cover. The interrupted Mini visual run caused by a laptop lid close was excluded and rerun.

| Hidden capability | Success | Mean time | Mean calls | Mean billed tokens | Decision |
|---|---:|---:|---:|---:|---|
| Existing-tab discovery and claim | 3/3 | 33.3 s | 6.3 | 32,825 | Keep dynamic |
| Console trigger and observation | 3/3 | 73.4 s | 14.7 | 76,517 | Keep capability; add facade |
| Typed file injection | 2/3 | 39.6 s | 8.7 | 39,125 | Keep dynamic |
| User-script register/verify/remove | 3/3 | 35.9 s | 7.7 | 29,935 | Keep dynamic |
| Shadow-DOM a11y/ref interaction | 2/3 | 136.3 s | 21.0 | 143,737 | Keep capability; load as pack |
| Canvas-only visual interaction | 3/3 | 178.5 s | 32.7 | 525,974 | Keep hidden; needs higher-level workflow |

The matrix called `bro_search_tools` 29 times. Dynamic discovery worked, but individual-tool search caused expensive reconstruction for visual, console, and accessibility workflows. Three benchmark tabs also required explicit post-run cleanup, reinforcing that raw-tool packs need lifecycle ownership.

These results justify retaining unique hidden capabilities, not retaining every historical public name.

### 7. Luna Max complex-workflow benchmark

A broader matrix ran 14 sequential scenarios on GPT-5.6 Luna with max thinking. It covered ten public/demo domains plus deterministic local iframe, shadow-DOM, canvas, upload, console, user-script, and tab-lifecycle fixtures. Ambiguous, read-only, clamshell-sleep, and interrupted cells were discarded and rerun with exact targets under `caffeinate`.

| Scenario | Result | Time | Calls | Billed tokens |
|---|---:|---:|---:|---:|
| POST/header/body network capture | pass | 22.6 s | 1 | 6,604 |
| Tab claim/create/finalize lifecycle | pass | 49.2 s | 10 | 50,464 |
| User script across navigation/removal | pass | 50.8 s | 9 | 42,060 |
| File upload plus decoded content | pass | 52.6 s | 11 | 55,240 |
| Four-site batch plus result follow-up | pass | 58.6 s | 5 | 62,111 |
| Cart/checkout rollback | pass | 72.0 s | 12 | 70,403 |
| AJAX UI plus network evidence | pass | 80.2 s | 9 | 63,916 |
| Dynamic release comparison | pass | 121.9 s | 14 | 107,241 |
| Nested shadow-DOM form | pass | 145.2 s | 22 | 139,518 |
| Asynchronous console capture | pass | 167.7 s | 29 | 215,311 |
| TodoMVC state/filter/cleanup | pass | 223.4 s | 40 | 454,313 |
| HTML5 drag and drop | fail | 601.3 s | 44 | 923,944 |
| Editable iframe form | fail | 601.3 s | 91 | 1,597,670 |
| Canvas-only visual drag | fail | 601.3 s | 61 | 2,508,920 |

Overall success was 11/14. Successful runs averaged 14.7 calls and 115,198 billed tokens. The three failed spatial/frame workflows averaged 65.3 calls and 1.68 million billed tokens, showing that a strong model increases persistence but cannot repair a missing mechanism.

Decisive signals:

- `browser.network.capture` again completed a complex POST, custom-header, post-data, and response-body task in one call.
- `bro_search_tools` was called 62 times, so individual keyword discovery remains a major tax.
- `computer` was called 89 times. `left_click_drag` repeatedly reached the 30-second bridge timeout and could leave CDP attached, causing later tools to report another debugger already attached.
- iframe tools lacked stable frame enumeration and `frameId` targeting. The model exhausted 91 calls across flow, ref, tab, shortcut, and GIF tools without reaching the editable child frame.
- canvas screenshots did not provide sufficiently stable coordinate/scale targeting for drag. Repeated screenshot, zoom, click, and drag loops consumed 2.51 million billed tokens.
- `extract_page` rejected calls that supplied `tabId`, exposing a missing envelope entry in the raw forwarding catalog.

This changes the next priority order: fix spatial input timeouts and debugger release, add frame-aware read/action APIs, load coherent capability packs, then add one-call console capture. Do not expose more raw primitives as a response to these failures.

### 8. Spatial, frame, and console post-fix benchmark

The four failed or high-tail Luna Max scenarios were rerun after the owner-layer fixes:

| Scenario | Before | After | Calls | Billed tokens |
|---|---:|---:|---:|---:|
| HTML5 drag and drop | fail / 601.3 s | pass / 51.6 s | 44 → 8 | 923,944 → 60,493 |
| Editable iframe form | fail / 601.3 s | pass / 31.8 s | 91 → 5 | 1,597,670 → 19,949 |
| Canvas-only visual drag | fail / 601.3 s | pass / 236.6 s | 61 → 8 | 2,508,920 → 54,893 |
| Async console capture | pass / 167.7 s | pass / 34.3 s | 29 → 2 | 215,311 → 11,183 |

All four completed. The changes were:

- extract every tab envelope through one tested invariant, fixing `extract_page`
- bound CDP commands to five seconds and force detach on timeout
- activate the tab and window before real `Input.*` actions
- send held left-button state on drag movement
- include CSS viewport and device-scale coordinate guidance with screenshots
- publish `frames_list` and accept `frameId` in flow eval/click/fill/select/read steps
- publish server-owned capability metadata consumed as coherent Pi tool packs
- add `browser.console.capture` so monitor, trigger, collection, and cleanup share one call

Each rerun required exactly one `bro_search_tools` call. The iframe workflow then used `frames_list` plus one frame-aware flow action. Canvas remains the slowest successful cell because visual reasoning took 236.6 seconds even though tool calls fell to eight.

## Resulting tool policy

### Keep active initially

- `browser.extract`
- `browser.current.extract`
- `browser.batch.extract`
- `browser.batch.flow`
- `browser.network.capture`
- `browser.flow.start`
- `browser.flow.observe`
- `browser.flow.act`
- `browser.flow.finish`
- `bro_search_tools`

This is not the final smallest surface; it is the smallest tested surface that did not force models into expensive low-level reconstruction. The MCP server publishes 48 tools. Pi registers 39 of them plus `bro_search_tools`, keeps these ten active initially, and leaves 30 available through capability-pack loading.

### Keep discoverable but inactive

Keep these 30 model-facing capabilities available through dynamic loading:

- browser selection and tabs: `browsers_context`, `tabs_context`, `tabs_create`,
  `tabs_claim`, `tabs_finalize`, `tabs_activate`, `tabs_close`
- advanced page work: `computer`, `navigate`, `resize_window`, `read_page`,
  `find`, `frames_list`, `javascript_tool`, `form_input`, `click_element`, `scroll_element`,
  `fill_element`, `get_element_info`, `wait_for_element`
- diagnostics and media: `browser.console.capture`, `read_console_messages`,
  `file_upload`, `upload_image`, `gif_creator`, `shortcuts_list`, `shortcuts_execute`
- persistent scripts: `userscripts_register`, `userscripts_unregister`,
  `userscripts_list`

### Keep server-side but hide from Pi model discovery

These nine names remain available to existing MCP clients or internal adapters,
but do not need to be model-discoverable in Pi:

- lifecycle internals: `agent_done`, `session_name`
- compatibility variants: `tabs_context_mcp`, `tabs_create_mcp`
- facade internals: `get_page_text`, `extract_page`
- superseded workflows: `browser.batch.run`, `read_network_requests`,
  `get_response_body`

The first deprecation candidates at the server contract are `agent_done`,
`browser.batch.run`, the two `_mcp` tab aliases, and the two cross-turn raw
network tools. Do not delete them until downstream clients and the skill have a
published migration window.

### Improve next

1. Add generic readiness controls such as `waitForText` or `waitForSelector`, and consider refId actions inside `browser.flow.act`.
2. Reduce the remaining canvas visual-reasoning time with bounded screenshot regions or an outcome-level visual drag facade.
3. Compare removing only `browser.batch.flow` from the default set; the extraction-only default still regresses Mini even with capability packs.
4. Repeat visual and high-tail workflows across model tiers before consolidating additional tools.

## Revisit the default tool count when

Reconsider an extraction-only or consolidated default only after intent-aware loading completes the dynamic interaction task within one extra model turn and stays within approximately 20% of the current flow surface on calls, billed tokens, and wall time across all three model tiers.
