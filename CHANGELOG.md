# Changelog

## 1.4.0 (unreleased candidate)

- Add the default `browser.open/observe/act/close` interface with explicit
  browser/tab-pinned target IDs, composable typed actions and observations.
  Keep extraction/batch fast paths and legacy flow signatures on the same engine.
- Preserve same-node refs across rereads, scopes, filters and find. Bound the
  volatile registry to 10,000 handles with explicit stale errors; never reuse
  evicted/restarted identities. Validate complete frame inventories around reads.
- Expose scoped/bounded observation controls on both facades and inside act;
  text mode accepts `maxChars`/`cursor` and rejects only a11y-only options.
- Wait for document-specific DOMContentLoaded at navigation dispatch, before
  dependent evaluation. Preserve redirects, fail unmet readiness, clean listeners
  and failed newly created tabs. Do not treat legitimate empty eval as failure.
- Let server metadata select Pi defaults. Automatically inject owner/label,
  preserve targets across reload and report shutdown cleanup errors. Older
  servers retain legacy defaults; new servers keep legacy flows inactive by default.
- Shrink the model-facing surface: short epoch-prefixed refs (`kqx297`) that
  reject handles from an earlier registry; one-line act step results with the
  failure first and no connection/cleanup/acknowledgement fields; observe
  defaults of 8000 characters (3000 inside act) with cursor continuation.
- Add the act `check` step for native radios/checkboxes. Covered clicks name
  the covering element and its overlay as refs instead of a bare tag.
- Ref scroll moves the nearest scrollable ancestor or the document and names
  it; clicks accept hits on descendants, slotted content, composed ancestors and
  labels, re-measure once, and report empty points as not visible, not covered.
  An act `observe` whose scope was re-rendered reads the page and says so.
- `browser.open` returns once navigation is dispatched; the target's first
  observe or act waits up to 4 s for DOMContentLoaded and readable text, and
  proceeds at the cap instead of failing.
- Steer content reading to `mode: text`. Facade `maxChars` accepts at most
  20000; a11y output is capped at 12000, and its truncation footer lists the
  unread top-level landmarks and headings as refs to scope to. Add a condition-only act
  `wait` step: `text`, `textGone`, or `refId` + `state`, polled up to
  `timeoutMs` (default 5000, at most 15000); a timeout is reported and later
  steps still run. An a11y observation retries once when the document
  changes mid-read and says so; an evaluation timeout names the busy page or
  long await and points to `wait`.
- `browser.batch.flow` accepts act's step names (`navigate`, `evaluate`);
  `goto`/`eval` remain aliases. Move developer invariants out of the injected
  facade guide into `docs/interaction-internals.md`.
- Act click/fill/select/check wait for the main frame to settle (400 ms quiet,
  3 s cap) and report opened/closed dialogs and menus, alerts, new text and
  navigation; a click with no visible change says so. Element steps accept
  `role` + `name`, resolved when the step runs, instead of `refId`.
- A click that opens a menu/dialog lists refs for its controls; a form post
  started by an action holds the settle wait; a role + name miss names the
  roles found instead. Add `browser.click`/`fill`/`press` single-action tools
  and an act `press` step; `targetId` defaults to the MCP session's last
  target. Observations show native date/time inputs as one ISO-fillable node
  and drop text that repeats its parent's name.
- See `docs/releases/1.4.0.md` for migration, boundaries and deferred scope.

## Unreleased

- Fix Pi MCP shared-connection ownership: request cancellation and ordinary
  request failures do not disconnect sibling calls; expired sessions reconnect
  on the next request without replay. Bound setup and shutdown deadlines.

- Add one-click Enable/Disable actions to the extension's user-script list.
  Disabled scripts retain their source and stay disabled across restarts and
  extension updates; editing does not re-enable them. Reload matching pages
  to apply changes; disabling cannot undo code that has already run.

- Match 1Password logins by registrable domain (Public Suffix List) instead of
  exact origin, like 1Password's default, so `secure.pnc.com` logins are found
  from `www.pnc.com`. Candidates report `match: exact-origin|same-site`; fill
  re-checks the same rule. `login_form_inspect` now reports `hiddenFields`,
  text-free `accountSwitchers` and a remembered-account `hint`. Candidates
  include the username; an empty search says how to proceed instead of leaving
  agents to work around it with raw `op` output.

- Keep focus emulation alive through rendering after `computer.scroll` wheel
  dispatch so fresh background pages actually process the scroll. Report dispatch
  rather than claiming movement; do not foreground, replay, or override canceled
  wheels. Add real-browser panel/page regressions and rendering-failure coverage.

- Serialize CDP attach/detach transitions and invalidate child frame sessions
  before idle detachment. Consecutive flow steps no longer reuse a detaching
  connection; attachment-loss errors are reported without replaying input.

- Replace unconditional foregrounding for ref click/scroll and computer input
  with scoped page-focus emulation. Preserve the user's selected tab/window,
  serialize same-tab input, clear emulation on success/failure, and retain
  `tabs_activate` for deliberate foreground work. See `docs/input-focus.md`.

- Add `browser.network.capture` to keep monitoring, trigger execution, matching
  request collection, bounded response bodies, and cleanup inside one MCP call.
- Propagate nested browser errors through flow results, stop at the failed step,
  and mark failed facade outcomes as MCP tool errors.
- Add typed `select` flow steps, framework-aware input setters, awaited eval
  expressions, shorter flow IDs, and explicit flow-step schemas.
- Keep the outcome-level network facade active by default in Pi after benchmark
  runs reduced the network task from 0/3 to 3/3 success.
- Fix tab-envelope extraction for every forwarded tab tool, including
  `extract_page`, with a catalog-wide invariant test.
- Bound CDP commands, detach failed sessions, foreground real input targets,
  preserve held mouse-button state during drag, and publish screenshot coordinate
  and device-scale guidance.
- Add `frames_list` plus frame-aware flow eval, click, fill, select, and read
  steps for child-frame interaction.
- Add one-call `browser.console.capture` and server-owned capability metadata so
  Pi loads coherent interaction, tabs, frames, accessibility, console, visual,
  upload, shortcut, and user-script tool packs.
- Keep nine internal or compatibility tools on the MCP server while omitting
  them from Pi registration; retain `tabs_finalize` in the dynamic tab pack for
  explicit keep/handoff lifecycle work.

## 1.0.1

- Fix the extension options bundle so its ES module imports load correctly.
- Add a full-width Options-page manager for listing, creating, editing, and
  deleting inline user scripts, with low-frequency connection settings collapsed.
- Preserve user scripts in extension-local storage and restore them when an
  extension update clears Chrome's dynamic registration database.
- Show an editable purpose description for each user script.
- Add a bro-owned Pi adapter that exposes live MCP schemas as native namespaced
  tools over one persistent connection.
- Add dynamic low-level tool loading, Pi session-aware tab/flow cleanup, bounded
  result mapping, and correct MCP error propagation for Pi.

## 1.0.0

- Mark the local Rust MCP server, authenticated extension bridge, and supported
  CLI/MCP surface as the first stable bro release.
- Keep read-only settings access free of filesystem writes and preserve invalid
  settings files with clear errors instead of silently replacing their token.
- Harden extension authentication state, reconnect ownership, and the initial
  WebSocket authentication timeout.
- Keep extension tokens in local trusted-context storage and restrict server
  URLs to loopback WebSocket endpoints.
- Keep the extension manifest version aligned with the Rust package in checks
  and release builds.

## 0.2.5

- Add best-effort native browser profile and process metadata to
  `browsers_context`.
- Add browser monitoring diagnostics, user-script management, and richer
  JavaScript and network inspection options.

## 0.2.4

- Add browser session lifecycle parity tools: `session_name`, `tabs_claim`, and `tabs_finalize`.
- Track session-owned and session-claimed tabs in the extension so owned tabs
  can be closed while claimed user tabs are released.
- Document bro's Chrome connector parity matrix and the remaining Playwright-object-model gap.

## 0.2.2

- Add `browser.batch.flow` for running the same ordered click/fill/wait/eval/read
  workflow across many URLs with bounded concurrency and cleanup.
- Document when to use batch flow instead of many separate flow sessions.
- Update the bro-browser Codex skill to prefer `browser.batch.flow` for repeated
  multi-page interactions.

## 0.2.1

- Add `bro setup codex` to configure Codex MCP without shell-specific token environment setup.
- Add `bro setup browser` to open browser extension setup, reveal the extension
  directory, and copy the local token to the clipboard when available.
- Install the browser extension asset through the Homebrew formula so Homebrew
  users do not need a source checkout.
- Update README setup instructions around Homebrew, Codex MCP auth, and browser extension loading.

## 0.2.0

- Add cross-platform GitHub release builds for macOS, Linux, and Windows on x86_64 and arm64.
- Add Homebrew release automation for `xiaotianxt/tap/bro` using GitHub-built binaries.
- Add Homebrew service support for running the local bro MCP server.
- Add `bro --version` for release and install verification.

## 0.1.0

- Initial bro repository.
- Rust-native MCP server and CLI for local browser automation.
- Minimal WebExtension adapter for Chromium-family browsers.
- Batch extraction and flow tools for short agent/browser interaction loops.
- CI metadata for Rust fmt, clippy, tests, and extension typecheck/build.
- GitHub release workflow metadata for binary artifacts.
