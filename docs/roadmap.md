# Roadmap

## 0.1

- Rust MCP server and CLI.
- Minimal WebExtension adapter.
- OpenBrowserMCP-compatible bridge and public browser tools where useful.
- Batch extraction and flow tools.
- Live regression tests for dynamic social/search pages.
- GitHub CI and release metadata.

## Next

- Split Rust facade modules by ownership: batch scheduling, extraction parsing,
  flow sessions, and JavaScript snippets.
- Add signed release artifacts for macOS/Linux.
- Add a stable extension packaging workflow.
- Improve virtualized-feed extraction without adding site-specific policy.
- Add generated protocol bindings so Rust and TypeScript bridge types cannot
  drift.

## Later

- Homebrew formula once the release path is exercised.
- Optional native installer for LaunchAgent setup on macOS.
- Recipe/skill layer for user-owned browsing workflows built on top of the
  generic browser facade.
