.PHONY: build extension pi-extension version-check lint unit e2e live-extension live-refs live-refs-repeat check release

# Override for an isolated validation build without changing a loaded extension.
EXTENSION_OUT_DIR ?= dist
BRO ?= $(CURDIR)/bin/bro

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

version-check:
	pnpm version:check

lint:
	@unformatted="$$(gofmt -l cmd internal e2e)"; [ -z "$$unformatted" ] || { echo "gofmt needed:"; echo "$$unformatted"; exit 1; }
	go vet ./...
	go tool staticcheck ./...

unit:
	go test -count=1 ./internal/...

# Real-browser ref contracts in an isolated profile. Exclusive checks run
# alone, the rest LIVE_CONCURRENCY (default 4) at a time on one MCP session.
# While iterating, run one: make live-refs CHECKS="T:" (about 15 s).
LIVE_EXTENSION_DIR ?= $(CURDIR)/bin/live-extension
LIVE_FLAGS = --extension "$(LIVE_EXTENSION_DIR)" --chrome "$(CHROME_BIN)" --bro "$(BRO)" $(if $(CHECKS),--checks "$(CHECKS)") $(if $(LIVE_CONCURRENCY),--concurrency $(LIVE_CONCURRENCY))
live-extension: build
	pnpm --filter @bro/shared build
	pnpm --filter @bro/extension build --outDir "$(LIVE_EXTENSION_DIR)"

live-refs: live-extension
	node scripts/live-refs.mjs $(LIVE_FLAGS) $(if $(LIVE_PORT),--port $(LIVE_PORT))

# N whole live suites at once, each with its own Chrome, profile, bro port and
# output directory; prints pass counts per check. Same CHECKS filter.
N ?= 3
live-refs-repeat: live-extension
	node scripts/live-repeat.mjs --runs $(N) $(LIVE_FLAGS)

# The parts share nothing but the built binary, so they run at once; each
# part's output prints as one block (scripts/parallel-make.sh).
check: build
	@MAKE="$(MAKE)" scripts/parallel-make.sh version-check lint unit e2e extension pi-extension

release:
	scripts/release.sh
