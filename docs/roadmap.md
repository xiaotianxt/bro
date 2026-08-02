# Roadmap

## 1.0

- Stable Rust MCP server and CLI with a minimal authenticated WebExtension
  adapter.
- Batch extraction, leased-tab flows, browser monitoring, and generic browser
  primitives.
- Cross-platform GitHub artifacts, extension packaging, and Homebrew service
  installation.
- CI coverage for Rust, the extension, version synchronization, and the local
  authentication boundary.

## Next

- Add signed release artifacts for macOS/Linux.
- Improve virtualized-feed extraction when live regressions demonstrate a
  generic failure mode.

## Later

- Optional native installer for non-Homebrew setup on macOS.
- Recipe/skill layer for user-owned browsing workflows built on top of the
  generic browser facade.
