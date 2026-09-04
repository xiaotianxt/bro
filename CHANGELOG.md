# Changelog

## Unreleased

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
