#!/usr/bin/env bash
# Signs bro binaries with the self-signed certificate from
# scripts/macos-signing-cert.sh, under a designated requirement that stays the
# same across releases. Runs on macOS (the release workflow's macOS runner).
#
# Usage: MACOS_SIGNING_P12_BASE64=... MACOS_SIGNING_P12_PASSWORD=... \
#          scripts/macos-sign.sh BINARY...
set -euo pipefail

: "${MACOS_SIGNING_P12_BASE64:?set MACOS_SIGNING_P12_BASE64}"
: "${MACOS_SIGNING_P12_PASSWORD:?set MACOS_SIGNING_P12_PASSWORD}"
[[ $# -gt 0 ]] || { echo "usage: $0 BINARY..." >&2; exit 2; }

identifier="com.xiaotianxt.bro"
work="$(mktemp -d)"
keychain="$work/signing.keychain-db"
keychain_password="$(openssl rand -hex 16)"
original_keychains=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  original_keychains+=("${line//\"/}")
done < <(security list-keychains -d user)
cleanup() {
  security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

printf '%s' "$MACOS_SIGNING_P12_BASE64" | base64 -d >"$work/signing.p12"
fingerprint="$(openssl pkcs12 -in "$work/signing.p12" -legacy -nokeys -clcerts \
  -passin env:MACOS_SIGNING_P12_PASSWORD | openssl x509 -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"
[[ "$fingerprint" =~ ^[0-9A-F]{40}$ ]] || { echo "could not read the signing certificate" >&2; exit 1; }

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/signing.p12" -k "$keychain" -P "$MACOS_SIGNING_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
# codesign finds an untrusted (self-signed) identity only in a keychain on the
# search list; --keychain alone reports "no identity found".
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"

# The explicit requirement names the certificate itself, not a CA chain: the
# certificate is self-signed, and this is what macOS compares when it decides
# whether an upgraded bro is the program a user already allowed.
requirement="designated => identifier \"$identifier\" and certificate leaf = H\"$fingerprint\""
for binary in "$@"; do
  codesign --force --sign "$fingerprint" --keychain "$keychain" \
    --identifier "$identifier" --timestamp=none \
    --requirements "=$requirement" "$binary"
  codesign --verify --strict "$binary"
  actual="$(codesign --display --requirements - "$binary" 2>&1 | sed -n 's/^designated => //p')"
  # codesign prints the certificate hash in lowercase.
  [[ "$actual" == "identifier \"$identifier\" and certificate leaf = H\"$(printf '%s' "$fingerprint" | tr 'A-F' 'a-f')\"" ]] || {
    echo "$binary: unexpected designated requirement: $actual" >&2
    exit 1
  }
  echo "signed $binary ($identifier, certificate $fingerprint)"
done
