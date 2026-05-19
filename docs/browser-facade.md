# Browser Facade

The browser facade is the agent-facing layer above raw tab and CDP tools. Its
purpose is to shorten common browser workflows without baking in website policy.
The browser execution layer remains a minimal WebExtension adapter; bro does
not claim a 100% Rust browser runtime.

## Batch Extraction

`browser.batch.extract` opens independent URLs in background tabs, extracts
visible text and links, then closes tabs by default.

Minimal input:

```json
{
  "urls": [
    "https://example.com/a",
    "https://example.com/b"
  ]
}
```

Useful options:

- `inputs`: array of `{ "id": "...", "url": "..." }` when stable result IDs
  matter
- `concurrency`: defaults to 6, clamped to 16
- `maxChars`: defaults to 12000, clamped to 60000
- `maxLinks`: defaults to 80, clamped to 200
- `includeA11y`: defaults to false; when true, accessibility tree is used as a
  fallback only when DOM extraction is not ready
- `cleanup`: defaults to true

`urls` and `inputs` are mutually exclusive.

## Single Extraction

`browser.extract` is the one-URL version. It returns:

- `status`: `ok`, `partial`, or `failed`
- `text`
- `links`
- `diagnostics`

Diagnostics include the source used, readiness, elapsed time, and fallback
attempts.

## Flow

Use `browser.flow.*` for sequential interaction with one leased tab.

1. `browser.flow.start` opens a tab and returns `sessionId`.
2. `browser.flow.act` runs ordered steps: `goto`, `eval`, `click`, `fill`,
   `wait`, `read_text`.
3. `browser.flow.observe` reads current text or accessibility tree.
4. `browser.flow.finish` releases server state and closes the tab by default.

If a step fails, `browser.flow.act` stops at that step and returns prior step
results plus the failure location.

## Design Rule

The facade may compose generic browser mechanics. It must not learn website
semantics such as "how Reddit search works" or "how LinkedIn renders posts".
Those belong in downstream skills or user workflows.
