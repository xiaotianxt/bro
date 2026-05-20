#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${REPO_SLUG:-xiaotianxt/bro}"
TAP_NAME="${TAP_NAME:-xiaotianxt/tap}"
FORMULA_REF="${FORMULA_REF:-xiaotianxt/tap/bro}"
WORKFLOW="${WORKFLOW:-release.yml}"

RUN_CHECKS=1
UPDATE_TAP=1
BREW_VERIFY=1
WATCH_RELEASE=1
BUMP_KIND="patch"
VERSION_OVERRIDE=""

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh [options]

Create a bro release, wait for GitHub Actions to publish cross-platform
artifacts, update the Homebrew tap, and verify the installed binary.

Options:
  --bump LEVEL       Bump level when the current version is already tagged on
                     another commit. One of: patch, minor, major. Default: patch.
  --version VERSION  Release this exact x.y.z version, updating Cargo files with
                     cargo-release first.
  --skip-checks      Do not run make check before tagging.
  --skip-tests       Alias for --skip-checks.
  --skip-tap         Do not update the Homebrew tap formula.
  --skip-brew-verify Do not run brew update/upgrade/test after tap update.
  --no-watch         Push the tag but do not wait for the release workflow.
  -h, --help         Show this help.

Environment:
  REPO_SLUG          GitHub repo slug. Default: xiaotianxt/bro
  TAP_NAME           Homebrew tap name. Default: xiaotianxt/tap
  FORMULA_REF        Brew formula ref. Default: xiaotianxt/tap/bro
  WORKFLOW           Release workflow file/name. Default: release.yml
USAGE
}

log() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

package_version() {
  sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' Cargo.toml | head -1
}

local_tag_commit() {
  git rev-parse -q --verify "refs/tags/${1}^{}" 2>/dev/null || true
}

remote_tag_commit() {
  local tag="$1"
  local sha

  sha="$(git ls-remote --tags origin "refs/tags/${tag}^{}" | awk '{print $1}')"
  if [[ -z "$sha" ]]; then
    sha="$(git ls-remote --tags origin "refs/tags/${tag}" | awk '{print $1}')"
  fi

  printf '%s' "$sha"
}

tag_commit() {
  local tag="$1"
  local sha

  sha="$(local_tag_commit "$tag")"
  if [[ -z "$sha" ]]; then
    sha="$(remote_tag_commit "$tag")"
  fi

  printf '%s' "$sha"
}

cargo_release_version() {
  local level_or_version="$1"

  cargo release "$level_or_version" \
    --execute \
    --no-confirm \
    --no-publish \
    --no-tag \
    --no-push
}

release_asset_sha() {
  local tag="$1"
  local asset_name="$2"
  local asset_sha

  asset_sha="$(
    gh release view "$tag" \
      --repo "$REPO_SLUG" \
      --json assets \
      --jq ".assets[] | select(.name == \"${asset_name}\") | .digest // empty"
  )"
  if [[ "$asset_sha" == sha256:* ]]; then
    asset_sha="${asset_sha#sha256:}"
  fi

  if [[ -z "$asset_sha" ]]; then
    if [[ -z "${TMP_DIR:-}" ]]; then
      TMP_DIR="$(mktemp -d)"
      trap 'rm -rf "$TMP_DIR"' EXIT
    fi
    gh release download "$tag" --repo "$REPO_SLUG" --pattern "$asset_name" --dir "$TMP_DIR" --clobber
    asset_sha="$(shasum -a 256 "${TMP_DIR}/${asset_name}" | awk '{print $1}')"
  fi
  [[ -n "$asset_sha" ]] || die "could not determine sha256 for ${asset_name}"

  printf '%s' "$asset_sha"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bump)
      [[ $# -ge 2 ]] || die "--bump requires patch, minor, or major"
      BUMP_KIND="$2"
      case "$BUMP_KIND" in
        patch|minor|major) ;;
        *) die "--bump must be one of: patch, minor, major" ;;
      esac
      shift
      ;;
    --version)
      [[ $# -ge 2 ]] || die "--version requires a version"
      VERSION_OVERRIDE="$2"
      [[ "$VERSION_OVERRIDE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be x.y.z"
      shift
      ;;
    --skip-checks|--skip-tests)
      RUN_CHECKS=0
      ;;
    --skip-tap)
      UPDATE_TAP=0
      BREW_VERIFY=0
      ;;
    --skip-brew-verify)
      BREW_VERIFY=0
      ;;
    --no-watch)
      WATCH_RELEASE=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

need_cmd cargo
need_cmd cargo-release
need_cmd git
need_cmd gh
need_cmd python3
if [[ "$RUN_CHECKS" -eq 1 ]]; then
  need_cmd make
fi
if [[ "$UPDATE_TAP" -eq 1 || "$BREW_VERIFY" -eq 1 ]]; then
  need_cmd brew
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty; commit or stash changes first"

TAP_DIR=""
FORMULA_PATH=""
if [[ "$UPDATE_TAP" -eq 1 ]]; then
  TAP_DIR="$(brew --repo "$TAP_NAME")"
  FORMULA_PATH="${TAP_DIR}/Formula/bro.rb"
  [[ -z "$(git -C "$TAP_DIR" status --porcelain)" ]] || die "tap working tree is dirty: ${TAP_DIR}"

  log "updating tap checkout ${TAP_NAME}"
  git -C "$TAP_DIR" pull --ff-only
  [[ -z "$(git -C "$TAP_DIR" status --porcelain)" ]] || die "tap working tree is dirty after pull: ${TAP_DIR}"
fi

log "fetching origin/main and tags"
git fetch origin main --tags

HEAD_SHA="$(git rev-parse HEAD)"
ORIGIN_MAIN_SHA="$(git rev-parse origin/main)"
if [[ "$HEAD_SHA" != "$ORIGIN_MAIN_SHA" ]]; then
  if git merge-base --is-ancestor origin/main HEAD; then
    log "current HEAD is ahead of origin/main"
  else
    die "current HEAD is not origin/main and cannot fast-forward it"
  fi
fi

CURRENT_VERSION="$(package_version)"
[[ -n "$CURRENT_VERSION" ]] || die "Cargo.toml version not found"
CURRENT_TAG="v${CURRENT_VERSION}"
CURRENT_TAG_SHA="$(tag_commit "$CURRENT_TAG")"

if [[ -n "$VERSION_OVERRIDE" && "$VERSION_OVERRIDE" != "$CURRENT_VERSION" ]]; then
  TAG_SHA="$(tag_commit "v${VERSION_OVERRIDE}")"
  [[ -z "$TAG_SHA" ]] || die "tag v${VERSION_OVERRIDE} already exists at ${TAG_SHA}; choose a different version"
  log "bumping Cargo version ${CURRENT_VERSION} -> ${VERSION_OVERRIDE} with cargo-release"
  cargo_release_version "$VERSION_OVERRIDE"
elif [[ -n "$CURRENT_TAG_SHA" && "$CURRENT_TAG_SHA" != "$HEAD_SHA" ]]; then
  log "current version ${CURRENT_VERSION} is already tagged; bumping ${BUMP_KIND} with cargo-release"
  cargo_release_version "$BUMP_KIND"
else
  log "using Cargo version ${CURRENT_VERSION}"
fi

[[ -z "$(git status --porcelain -- Cargo.toml Cargo.lock)" ]] || die "cargo-release left uncommitted Cargo version changes"

VERSION="$(package_version)"
[[ -n "$VERSION" ]] || die "Cargo.toml version not found"
TAG="v${VERSION}"
TAG_SHA="$(tag_commit "$TAG")"
HEAD_SHA="$(git rev-parse HEAD)"
if [[ -n "$TAG_SHA" && "$TAG_SHA" != "$HEAD_SHA" ]]; then
  die "tag ${TAG} points to ${TAG_SHA}, not HEAD ${HEAD_SHA}; choose a different version"
fi

if [[ "$RUN_CHECKS" -eq 1 ]]; then
  log "running make check"
  make check
fi

if [[ "$HEAD_SHA" != "$(git rev-parse origin/main)" ]]; then
  log "pushing current HEAD to origin/main"
  git push origin HEAD:main
fi

DARWIN_ARM64_ASSET="bro-${TAG}-aarch64-apple-darwin.tar.gz"
DARWIN_X86_64_ASSET="bro-${TAG}-x86_64-apple-darwin.tar.gz"
LINUX_ARM64_ASSET="bro-${TAG}-aarch64-unknown-linux-gnu.tar.gz"
LINUX_X86_64_ASSET="bro-${TAG}-x86_64-unknown-linux-gnu.tar.gz"
DARWIN_ARM64_URL="https://github.com/${REPO_SLUG}/releases/download/${TAG}/${DARWIN_ARM64_ASSET}"
DARWIN_X86_64_URL="https://github.com/${REPO_SLUG}/releases/download/${TAG}/${DARWIN_X86_64_ASSET}"
LINUX_ARM64_URL="https://github.com/${REPO_SLUG}/releases/download/${TAG}/${LINUX_ARM64_ASSET}"
LINUX_X86_64_URL="https://github.com/${REPO_SLUG}/releases/download/${TAG}/${LINUX_X86_64_ASSET}"

log "preparing ${TAG}"

if [[ -n "$(local_tag_commit "$TAG")" ]]; then
  log "local tag ${TAG} already exists"
else
  log "creating tag ${TAG}"
  git tag -a "$TAG" -m "$TAG"
fi

REMOTE_TAG_SHA="$(remote_tag_commit "$TAG")"
if [[ -n "$REMOTE_TAG_SHA" ]]; then
  log "remote tag ${TAG} already exists"
else
  log "pushing tag ${TAG}"
  git push origin "$TAG"
fi

if ! gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  [[ "$WATCH_RELEASE" -eq 1 ]] || die "release ${TAG} does not exist yet; rerun without --no-watch"

  log "waiting for release workflow run"
  RUN_ID=""
  for _ in {1..60}; do
    RUN_ID="$(
      gh run list \
        --repo "$REPO_SLUG" \
        --workflow "$WORKFLOW" \
        --branch "$TAG" \
        --limit 1 \
        --json databaseId \
        --jq '.[0].databaseId // empty'
    )"
    [[ -n "$RUN_ID" ]] && break
    sleep 5
  done
  [[ -n "$RUN_ID" ]] || die "release workflow run for ${TAG} was not found"

  gh run watch "$RUN_ID" --repo "$REPO_SLUG" --exit-status
fi

log "reading release asset digests"
DARWIN_ARM64_SHA="$(release_asset_sha "$TAG" "$DARWIN_ARM64_ASSET")"
DARWIN_X86_64_SHA="$(release_asset_sha "$TAG" "$DARWIN_X86_64_ASSET")"
LINUX_ARM64_SHA="$(release_asset_sha "$TAG" "$LINUX_ARM64_ASSET")"
LINUX_X86_64_SHA="$(release_asset_sha "$TAG" "$LINUX_X86_64_ASSET")"

log "asset sha256 ${DARWIN_ARM64_ASSET} ${DARWIN_ARM64_SHA}"
log "asset sha256 ${DARWIN_X86_64_ASSET} ${DARWIN_X86_64_SHA}"
log "asset sha256 ${LINUX_ARM64_ASSET} ${LINUX_ARM64_SHA}"
log "asset sha256 ${LINUX_X86_64_ASSET} ${LINUX_X86_64_SHA}"

if [[ "$UPDATE_TAP" -eq 1 ]]; then
  log "updating tap ${TAP_NAME}"
  mkdir -p "$(dirname "$FORMULA_PATH")"
  python3 - \
    "$FORMULA_PATH" \
    "$VERSION" \
    "$DARWIN_ARM64_URL" "$DARWIN_ARM64_SHA" \
    "$DARWIN_X86_64_URL" "$DARWIN_X86_64_SHA" \
    "$LINUX_ARM64_URL" "$LINUX_ARM64_SHA" \
    "$LINUX_X86_64_URL" "$LINUX_X86_64_SHA" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version = sys.argv[2]
darwin_arm64_url = sys.argv[3]
darwin_arm64_sha = sys.argv[4]
darwin_x86_64_url = sys.argv[5]
darwin_x86_64_sha = sys.argv[6]
linux_arm64_url = sys.argv[7]
linux_arm64_sha = sys.argv[8]
linux_x86_64_url = sys.argv[9]
linux_x86_64_sha = sys.argv[10]

path.write_text(f'''class Bro < Formula
  desc "Rust-native local MCP server for browser automation"
  homepage "https://github.com/xiaotianxt/bro"
  version "{version}"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "{darwin_arm64_url}"
      sha256 "{darwin_arm64_sha}"
    elsif Hardware::CPU.intel?
      url "{darwin_x86_64_url}"
      sha256 "{darwin_x86_64_sha}"
    else
      odie "unsupported macOS architecture"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "{linux_arm64_url}"
      sha256 "{linux_arm64_sha}"
    elsif Hardware::CPU.intel?
      url "{linux_x86_64_url}"
      sha256 "{linux_x86_64_sha}"
    else
      odie "unsupported Linux architecture"
    end
  end

  head do
    url "https://github.com/xiaotianxt/bro.git", branch: "main"
    depends_on "rust" => :build
  end

  def install
    if build.head?
      system "cargo", "install", "--locked", "--bin", "bro", "--root", prefix, "."
    else
      bin.install "bro"
    end
  end

  service do
    run [opt_bin/"bro", "serve"]
    keep_alive true
    log_path var/"log/bro.log"
    error_log_path var/"log/bro.err.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bro --version")
  end
end
''')
PY

  if [[ -z "$(git -C "$TAP_DIR" status --porcelain -- Formula/bro.rb)" ]]; then
    log "tap already points to ${VERSION}"
  else
    git -C "$TAP_DIR" diff --check -- Formula/bro.rb
    git -C "$TAP_DIR" add Formula/bro.rb
    git -C "$TAP_DIR" commit -m "bro ${VERSION}"
    git -C "$TAP_DIR" push origin main
  fi
fi

if [[ "$BREW_VERIFY" -eq 1 ]]; then
  log "verifying Homebrew install"
  brew update
  FORMULA_NAME="${FORMULA_REF##*/}"
  if brew list --formula "$FORMULA_NAME" >/dev/null 2>&1; then
    brew upgrade "$FORMULA_REF" || brew reinstall "$FORMULA_REF"
  else
    brew install "$FORMULA_REF"
  fi
  bro --version
  brew test "$FORMULA_REF"
fi

log "release ${TAG} complete"
