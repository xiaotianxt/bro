.PHONY: fmt clippy test extension live-test check release release-build

fmt:
	cargo fmt --all

clippy:
	cargo clippy --all-targets -- -D warnings

test:
	cargo test

extension:
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension typecheck
	pnpm --filter @bro/extension build

live-test:
	cargo test --test live_extract -- --ignored --nocapture

check:
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	cargo test
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension typecheck
	pnpm --filter @bro/extension build

release:
	scripts/release.sh

release-build:
	cargo build --locked --release
