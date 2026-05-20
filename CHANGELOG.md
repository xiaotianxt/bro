# Changelog

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
