#!/usr/bin/env bash
# Run make targets at once, each into its own log, then print every log as one
# block in the order given and fail if any target failed.
#
#   scripts/parallel-make.sh lint unit e2e
#
# MAKE names the make to run (the Makefile passes its own).
set -uo pipefail

[ $# -gt 0 ] || { sed -n '2,7p' "$0"; exit 2; }
make="${MAKE:-make}"
logs="$(mktemp -d "${TMPDIR:-/tmp}/bro-check.XXXXXX")"
trap 'rm -rf "$logs"' EXIT

pids=()
for target in "$@"; do
  (
    start=$SECONDS
    "$make" --no-print-directory "$target" >"$logs/$target.log" 2>&1
    status=$?
    echo "$status $((SECONDS - start))" >"$logs/$target.status"
  ) &
  pids+=("$!")
done

failed=()
i=0
for target in "$@"; do
  wait "${pids[$i]}"
  i=$((i + 1))
  read -r status seconds <"$logs/$target.status"
  if [ "$status" -eq 0 ]; then
    echo "==> $target: ok (${seconds}s)"
  else
    echo "==> $target: FAILED with exit $status (${seconds}s)"
    failed+=("$target")
  fi
  cat "$logs/$target.log"
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "==> failed: ${failed[*]}"
  exit 1
fi
