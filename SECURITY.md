# Security

bro runs locally and can control a logged-in browser through a WebExtension.
Treat that capability as sensitive.

- The local MCP server uses a bearer token stored in `~/.bro/settings.json`.
- The browser extension must be configured with the same token.
- Do not expose the MCP port to untrusted networks.
- Do not paste tokens, cookies, signed URLs, or private page output into issues.

To report a security issue, open a private advisory on GitHub or contact the
maintainer directly.
