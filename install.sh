#!/bin/sh
# Installs or upgrades bro from its GitHub release, then runs `bro setup`.
#
#   curl -fsSL https://raw.githubusercontent.com/xiaotianxt/bro/main/install.sh | sh
#
# bro goes to ~/.local/bin/bro and its extension to ~/.local/share/bro/extension:
# fixed paths, replaced in place on upgrade, so the background service, the
# browser's native host and MCP client configs keep pointing at them.
#
# Environment: BRO_VERSION (a tag such as v2.3.0; default: latest),
# BRO_PREFIX (default: ~/.local), BRO_NO_SETUP=1 to skip `bro setup`.
set -eu

repo="xiaotianxt/bro"
prefix="${BRO_PREFIX:-$HOME/.local}"

die() {
  echo "bro install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os="apple-darwin" ;;
  Linux) os="unknown-linux-gnu" ;;
  *) die "unsupported system $(uname -s); on Windows download a release from https://github.com/$repo/releases" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="aarch64" ;;
  x86_64 | amd64) arch="x86_64" ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

tag="${BRO_VERSION:-}"
if [ -z "$tag" ]; then
  # The latest-release page redirects to .../releases/tag/<tag>.
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")" ||
    die "could not reach GitHub"
  tag="${url##*/}"
fi
case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "could not determine the release tag (got '$tag')" ;;
esac

asset="bro-$tag-$arch-$os.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

echo "Downloading bro $tag for $arch-$os…"
base="https://github.com/$repo/releases/download/$tag"
curl -fsSL -o "$work/$asset" "$base/$asset" || die "download failed: $base/$asset"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: $base/SHA256SUMS"
expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")"
[ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$work/$asset" | awk '{print $1}')"
fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset"

mkdir -p "$work/unpacked"
tar -xzf "$work/$asset" -C "$work/unpacked"
[ -x "$work/unpacked/bro" ] && [ -f "$work/unpacked/extension/manifest.json" ] ||
  die "$asset does not contain bro and its extension"

bin="$prefix/bin"
share="$prefix/share/bro"
mkdir -p "$bin" "$share"
# Rename into place so a running bro keeps its file and never sees half of one.
cp "$work/unpacked/bro" "$bin/.bro.new"
chmod 755 "$bin/.bro.new"
mv -f "$bin/.bro.new" "$bin/bro"
rm -rf "$share/.extension.new"
cp -R "$work/unpacked/extension" "$share/.extension.new"
rm -rf "$share/extension"
mv "$share/.extension.new" "$share/extension"
echo "Installed $("$bin/bro" --version) to $bin/bro"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH to run bro from a terminal." ;;
esac

if [ "${BRO_NO_SETUP:-}" = "1" ]; then
  echo "Run '$bin/bro setup' to finish."
  exit 0
fi
echo
# Piped into sh, stdin is the script; setup reads the terminal instead.
if [ -r /dev/tty ]; then
  exec "$bin/bro" setup </dev/tty
fi
exec "$bin/bro" setup
