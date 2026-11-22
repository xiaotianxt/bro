.PHONY: build extension pi-extension e2e live-refs check release

# Override for an isolated validation build without changing a loaded extension.
EXTENSION_OUT_DIR ?= dist
BRO ?= $(CURDIR)/target/bro

build:
	go build -o "$(BRO)" ./cmd/bro

extension:
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension typecheck
	pnpm --filter @bro/extension test
	pnpm --filter @bro/extension build --outDir "$(EXTENSION_OUT_DIR)"

pi-extension:
	pnpm --filter @xiaotianxt/pi-bro typecheck
	pnpm --filter @xiaotianxt/pi-bro test

# Black-box contracts against the built binary (docs/architecture.md).
e2e: build
	BRO_BIN="$(BRO)" go test -count=1 ./e2e/...

# Real-browser ref contracts in an isolated profile (about 70 s for all).
# While iterating, run one: make live-refs CHECKS="T:" (about 15 s).
LIVE_EXTENSION_DIR ?= $(CURDIR)/target/live-extension
live-refs: build
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension build --outDir "$(LIVE_EXTENSION_DIR)"
	node scripts/live-refs.mjs --extension "$(LIVE_EXTENSION_DIR)" --chrome "$(CHROME_BIN)" --bro "$(BRO)" $(if $(CHECKS),--checks "$(CHECKS)")

check: build
	pnpm version:check
	test -z "$$(gofmt -l cmd internal e2e)"
	go vet ./...
	go test -count=1 ./internal/...
	BRO_BIN="$(BRO)" go test -count=1 ./e2e/...
	$(MAKE) extension
	$(MAKE) pi-extension

release:
	scripts/release.sh
