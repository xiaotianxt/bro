# Pi browser-agent benchmark

This benchmark measures how isolated Pi subagents use bro's native Pi tools. It records task completion, wall time, model turns, tool calls, tool-result failures, token usage, and reported cost.

It is intended to answer product questions such as:

- Which high-level tools consistently produce useful outcomes?
- Which tools return protocol success but fail the user's task?
- Can weaker models discover a coherent workflow through `bro_search_tools`?
- Does reducing the initial active tool set save more tokens than it costs in extra model turns?
- Which repeated failure patterns belong in bro rather than in prompting?

## Safety

Runs use the real local browser profile. The included tasks are read-only except for local state on public test sites. They do not send messages, make purchases, or mutate user accounts.

Raw session files can contain page text, URLs, screenshots, and account-visible state. Always write results outside the repository and never commit raw sessions:

```bash
python3 benchmarks/pi-agent/run.py \
  --output "${TMPDIR:-/tmp}/bro-pi-benchmark"
```

Only aggregate metrics stripped of raw browser content belong in `results/`.
The initial `v1.0.1` matrix, post-fix flow/network comparison, and hidden
capability retention matrix are stored as separate summaries so regressions
remain visible. The hidden-capability fixture is intentionally not retained in
raw session output; its aggregate report records task contracts and required
tool families.

## Models and tasks

The default matrix uses three OpenAI Codex model tiers:

- `gpt-5.3-codex-spark` at low thinking
- `gpt-5.4-mini` at medium thinking
- `gpt-5.6-sol` at high thinking

Tasks cover:

- a dynamic GitHub release page
- four social-search sites in one batch
- asynchronous element loading and clicking
- a multi-step login and product sort on Sauce Demo
- page-side fetch plus browser network inspection on httpbin

Each worker runs with built-in tools, skills, context files, and unrelated extensions disabled. The only available tools come from the bro Pi adapter.

## Run a subset

```bash
python3 benchmarks/pi-agent/run.py \
  --output "${TMPDIR:-/tmp}/bro-pi-benchmark" \
  --models mini,sol \
  --tasks social_batch,dynamic_loading
```

Runs are resumable: a directory with `meta.json` is skipped.

## Exposure experiment

`current` uses bro's normal default tools. `minimal` leaves only the three extraction tools and `bro_search_tools` active initially:

```bash
python3 benchmarks/pi-agent/run.py \
  --output "${TMPDIR:-/tmp}/bro-pi-minimal" \
  --exposure minimal \
  --tasks dynamic_loading
```

The minimal mode is an experiment, not a recommended configuration.

## Analyze

```bash
python3 benchmarks/pi-agent/analyze.py \
  "${TMPDIR:-/tmp}/bro-pi-benchmark" \
  --output "${TMPDIR:-/tmp}/bro-pi-benchmark-summary.json"
```

The analyzer intentionally keeps only metrics, tool names, and task pass/fail state. Validators are task-specific and should be updated when release versions or external fixtures change.

## Interpreting metrics

- **Task success** is stricter than tool execution success.
- **Tool failure** includes nested `isError=true` or `status=failed` values, even when an outer adapter result was marked successful.
- **Billed token volume** is input + output + cache-read + cache-write tokens summed across model turns.
- **Wall time** includes model latency, browser work, and network latency.
- One run per model/task cell is a product-discovery pilot, not a statistically powered model ranking. Repeat decisive cells before using small differences to choose a design.
