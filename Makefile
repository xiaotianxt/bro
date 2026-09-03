.PHONY: fmt clippy test extension pi-extension live-test check release release-build

fmt:
	cargo fmt --all

clippy:
	cargo clippy --all-targets -- -D warnings

test:
	cargo test

extension:
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension typecheck
	pnpm --filter @bro/extension test
	pnpm --filter @bro/extension build

pi-extension:
	pnpm --filter @xiaotianxt/pi-bro typecheck
	pnpm --filter @xiaotianxt/pi-bro test

live-test:
	cargo test --test live_extract -- --ignored --nocapture

check:
	pnpm version:check
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	cargo test
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension typecheck
	pnpm --filter @bro/extension test
	pnpm --filter @bro/extension build
	pnpm --filter @xiaotianxt/pi-bro typecheck
	pnpm --filter @xiaotianxt/pi-bro test

release:
	scripts/release.sh

release-build:
	cargo build --locked --release
