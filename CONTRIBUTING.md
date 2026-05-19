# Contributing

bro is a local-first browser automation tool. Keep changes small, auditable,
and explicit about failure behavior.

Before opening a PR, run:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
pnpm install --frozen-lockfile
pnpm --filter @bro/shared build
pnpm --filter @bro/extension typecheck
pnpm --filter @bro/extension build
```

Do not commit secrets, browser profile data, private URLs, generated extension
`dist/`, Rust `target/`, or local settings files.
