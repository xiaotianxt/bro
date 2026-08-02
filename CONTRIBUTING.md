# Contributing

bro is a local-first browser automation tool. Keep changes small, auditable,
and explicit about failure behavior.

Before opening a PR, run:

```bash
pnpm install --frozen-lockfile
make check
```

Do not commit secrets, browser profile data, private URLs, generated extension
`dist/`, Rust `target/`, or local settings files.
