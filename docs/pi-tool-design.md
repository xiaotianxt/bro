# Pi Tool Design From Agent Benchmarks

Status: provisional decision after the 2026-09-03 `v1.0.1` pilot.

## Decision

Do not expose all 45 bro tools initially, but do not reduce the current Pi default to extraction-only tools either.

Keep the current high-level extraction and four-tool flow surface active until bro has two replacements:

1. intent-aware tool packs for dynamic loading; and
2. an outcome-level network capture facade that executes monitoring and its trigger inside one MCP call.

Fix flow error propagation and schema guidance before trying to optimize the number of tool names. A shorter list that causes extra model turns is not a more efficient interface.

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

Batch extraction is already an effective outcome-level API. Multi-step interaction works but has a high tail cost. The network workflow is not agent-usable in its current shape.

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
- current default high-level set plus `bro_search_tools`: 1,630 input tokens

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

### 3. Network monitoring is structurally incompatible with model latency

Across the three network tasks:

- `bro_read_network_requests` was called 23 times;
- 22 calls returned no recorded requests;
- one call failed because `tabId` was omitted;
- no model reached `bro_get_response_body`;
- task success was 0/3.

Even `timeoutMs:0` did not make a direct multi-call probe reliable. Monitoring state lives in the Manifest V3 service worker and must survive model think time between MCP calls. It cannot be treated as a dependable cross-turn primitive.

The durable fix is a single owner-layer operation that performs:

1. attach and enable network monitoring;
2. execute navigation, interaction, or JavaScript trigger;
3. wait for matching requests;
4. collect request metadata and selected response bodies;
5. stop monitoring and clean up;

inside one MCP request.

### 4. Flow failures are partially hidden

`bro_browser_flow_act` was called 86 times. Seven calls contained nested failed steps. Several were returned with outer `status: "ok"`, so Pi and the model saw a nominally successful tool result even when a click or JavaScript evaluation failed.

Observed recurring failures included:

- unsupported `select` steps;
- selectors that matched no element;
- JavaScript written as a function body with top-level `return` when the tool expected an expression;
- form interactions that continued after an earlier failed step.

`browser.flow.act` promises to stop at the first failed step. The facade must enforce that promise and return MCP `isError=true` or an outer failed status.

### 5. Automatic lifecycle cleanup is necessary

Agents started 15 flows but explicitly finished only seven. The Pi adapter's shutdown cleanup is therefore product behavior, not optional convenience. Cleanup must remain automatic while preserving `/reload` continuation semantics.

## Resulting tool policy

### Keep active initially

- `browser.extract`
- `browser.current.extract`
- `browser.batch.extract`
- `browser.batch.flow`
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

1. Make flow step errors fail the outer flow result and stop subsequent steps.
2. Add a typed `select` step and explicit descriptions for every flow step field.
3. State that eval code is a JavaScript expression and show the accepted shape in the schema.
4. Replace individual keyword matches in `bro_search_tools` with server-owned capability groups such as interaction, tabs, debugging, uploads, and user scripts.
5. Add a one-call network capture facade; do not rely on monitoring state across model turns.
6. Add generic readiness controls such as `waitForText` or `waitForSelector` to extraction/interaction facades for dynamic pages.
7. Re-run the same matrix after each owner-layer change and compare task success, p50/p95 calls, billed tokens, and wall time.

## Revisit the default tool count when

Reconsider an extraction-only or consolidated default only after intent-aware loading completes the dynamic interaction task within one extra model turn and stays within approximately 20% of the current flow surface on calls, billed tokens, and wall time across all three model tiers.
