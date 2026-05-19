#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${REPO_SLUG:-xiaotianxt/bro}"
WORKFLOW="${WORKFLOW:-release.yml}"

RUN_CHECKS=1
WATCH_RELEASE=1
BUMP_KIND="patch"
VERSION_OVERRIDE=""

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh [options]

Create a bro release. If the current Cargo version is already tagged on another
commit, bump it with cargo-release first, then push main and a v<version> tag.

Options:
  --bump LEVEL       Bump level when the current version is already tagged on
                     another commit. One of: patch, minor, major. Default: patch.
  --version VERSION  Release this exact x.y.z version, updating Cargo files with
                     cargo-release first.
  --skip-checks      Do not run make check before tagging.
  --skip-tests       Alias for --skip-checks.
  --no-watch         Push the tag but do not wait for the release workflow.
  -h, --help         Show this help.

Environment:
  REPO_SLUG          GitHub repo slug. Default: xiaotianxt/bro
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
if [[ "$RUN_CHECKS" -eq 1 ]]; then
  need_cmd make
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty; commit or stash changes first"

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

log "release ${TAG} complete"
