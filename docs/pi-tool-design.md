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

The saved schema tokens were overwhelmed by extra model turns. The current flow tools should remain initially active until dynamic loading can activate coherent workflow packs.

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

This is not the final smallest surface; it is the smallest tested surface that did not force models into expensive low-level reconstruction.

### Keep discoverable but inactive

- raw tab/session tools
- direct accessibility/refId actions
- JavaScript execution
- console and network primitives
- uploads, shortcuts, GIF recording, and user scripts

### Improve next

1. Replace individual keyword matches in `bro_search_tools` with server-owned capability groups such as interaction, tabs, debugging, uploads, and user scripts.
2. Add generic readiness controls such as `waitForText` or `waitForSelector` to extraction/interaction facades for dynamic pages.
3. Investigate whether flow observation and action can be consolidated without recreating the expensive minimal-tool behavior.
4. Repeat decisive benchmark cells to measure variance and compare p50/p95 calls, billed tokens, and wall time.

## Revisit the default tool count when

Reconsider an extraction-only or consolidated default only after intent-aware loading completes the dynamic interaction task within one extra model turn and stays within approximately 20% of the current flow surface on calls, billed tokens, and wall time across all three model tiers.
