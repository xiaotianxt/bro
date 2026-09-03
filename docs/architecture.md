# Architecture

bro has one hard boundary: the MCP server is Rust; browser execution is a thin
WebExtension adapter.

```text
Codex MCP / bro Pi adapter
  -> bro Rust server
  -> authenticated WebSocket bridge
  -> bro extension service worker
  -> Chromium tab / CDP / content scripts
```

## Rust Core

The Rust core owns product policy:

- bind only to localhost by default
- authenticate browser bridge connections with the token in `~/.bro/settings.json`
- expose MCP Streamable HTTP at `/mcp`
- maintain connected browser registry and default browser selection
- route raw browser tools to the extension
- compose higher-level tools such as `browser.batch.extract`,
  `browser.batch.flow`, `browser.network.capture`, and `browser.flow.*`
- bound concurrency, cleanup, and response sizes

The core deliberately avoids site-specific workflows. Reddit, LinkedIn, X,
Threads, and similar sites are covered only by live regression tests for generic
browser extraction behavior.

The bridge shape and initial extension adapter are derived from the
Apache-2.0 OpenBrowserMCP project. bro keeps that attribution in the README and
NOTICE while using `bro` for project and package names.

## Browser Extension Adapter

The browser extension owns mechanisms that cannot be implemented directly in Rust:

- `chrome.tabs`
- `chrome.debugger`
- Manifest V3 service worker lifecycle
- content scripts
- page-side JavaScript execution

It should stay small and primitive. Any policy that affects MCP users should
move into Rust unless the browser API forces it to live in the extension.

## Pi Adapter

The Pi package in `pi-extension/` is a client adapter over the same MCP endpoint
used by Codex. It uses the official MCP TypeScript SDK, discovers schemas from
the Rust server, and registers namespaced Pi tools without copying browser
policy. One MCP connection is retained per Pi session.

The adapter owns only Pi-specific concerns:

- dynamic tool exposure and `bro_search_tools`
- mapping MCP text, images, structured content, errors, and cancellation to Pi
- associating tab lifecycle calls with the current Pi session
- preserving browser state across Pi reload and finalizing it at session end

It reads the token at runtime from `~/.bro/settings.json`; the token is not
stored in Pi settings or tool arguments.

## Local State

```text
~/.bro/settings.json
```

The settings file contains the local bridge token. It is created with private
permissions on Unix systems. Read-only commands never create or chmod it, and
bro leaves malformed or empty-token settings unchanged so the failure remains
visible and recoverable.

## Failure Behavior

- No browser connected: MCP tools return `isError=true` with an actionable
  message.
- Unknown `browserId`: the request fails instead of falling back silently.
- Extension authentication must finish within five seconds; an open socket is
  not registered as connected before the server acknowledges authentication.
- Tool timeout: Rust stops scheduling more work and makes a best-effort tab
  cleanup when it owns the tab.
- Partial page readiness: extraction returns `partial` with diagnostics rather
  than pretending the page is fully ready.

## Non-Goals

- Cloud relay or hosted browser service.
- Site-specific research agents.
- Claiming that Chromium extension code can be made 100% Rust.
- Persisting browsing traces by default.
