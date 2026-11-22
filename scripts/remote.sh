#!/usr/bin/env bash
# Run a command against this working tree on another Mac, so heavy checks
# (make check, e2e loops, live browser contracts) do not load this machine.
#
#   scripts/remote.sh make check
#   scripts/remote.sh make live-refs CHROME_BIN=/Applications/Helium.app/Contents/MacOS/Helium
#
# BRO_REMOTE names the ssh host (default: mini); BRO_REMOTE_DIR the checkout
# there. The tree is mirrored without build outputs, which are rebuilt remotely.
set -euo pipefail

host="${BRO_REMOTE:-mini}"
dir="${BRO_REMOTE_DIR:-dev/bro-remote}"
repo="$(cd "$(dirname "$0")/.." && pwd)"

[ $# -gt 0 ] || { sed -n '2,10p' "$0"; exit 2; }

rsync -a --delete \
  --exclude .git/ --exclude target/ --exclude node_modules/ --exclude dist/ \
  "$repo/" "$host:$dir/"

# The remote login shell may not be POSIX; run the command under bash.
printf -v cmd '%q ' "$@"
ssh "$host" bash -lc "$(printf '%q' "cd ~/$dir && { [ -d node_modules ] || pnpm install --frozen-lockfile; } && $cmd")"
