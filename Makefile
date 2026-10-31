.PHONY: fmt clippy test extension pi-extension live-test live-refs check release release-build

# Override for an isolated validation build without changing a loaded extension.
EXTENSION_OUT_DIR ?= dist

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
	pnpm --filter @bro/extension build --outDir "$(EXTENSION_OUT_DIR)"

pi-extension:
	pnpm --filter @xiaotianxt/pi-bro typecheck
	pnpm --filter @xiaotianxt/pi-bro test

live-test:
	cargo test --test live_extract -- --ignored --nocapture
	cargo test --test live_network -- --ignored --nocapture

# Real-browser ref contracts in an isolated profile (about 70 s for all).
# While iterating, run one: make live-refs CHECKS="T:" (about 15 s).
LIVE_EXTENSION_DIR ?= $(CURDIR)/target/live-extension
live-refs:
	cargo build
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension build --outDir "$(LIVE_EXTENSION_DIR)"
	node scripts/live-refs.mjs --extension "$(LIVE_EXTENSION_DIR)" --chrome "$(CHROME_BIN)" $(if $(CHECKS),--checks "$(CHECKS)")

check:
	pnpm version:check
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	cargo test
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension typecheck
	pnpm --filter @bro/extension test
	pnpm --filter @bro/extension build --outDir "$(EXTENSION_OUT_DIR)"
	pnpm --filter @xiaotianxt/pi-bro typecheck
	pnpm --filter @xiaotianxt/pi-bro test

release:
	scripts/release.sh

release-build:
	cargo build --locked --release
