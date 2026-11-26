#!/usr/bin/env bash
# Creates bro's self-signed macOS code-signing certificate, once.
#
# macOS remembers permissions granted to a program by its designated
# requirement. An ad-hoc signature's requirement is the binary's hash, so every
# release looked like a new program. Signing every release with this one
# certificate makes the requirement "identifier com.xiaotianxt.bro and this
# certificate", which stays the same across releases. It does not satisfy
# Gatekeeper; bro installs through Homebrew or curl, which do not quarantine.
#
# Usage: scripts/macos-signing-cert.sh OUT_DIR
# Writes OUT_DIR/bro-signing.p12 and OUT_DIR/bro-signing.password, and prints
# how to store them as GitHub Actions secrets. Keep both in a password
# manager: losing them means the next release asks for permissions again.
set -euo pipefail

out="${1:?usage: $0 OUT_DIR}"
mkdir -p "$out"
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat >"$work/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = bro self-signed code signing
O = xiaotianxt
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

# Twenty years: macOS checks the certificate when it evaluates the signature,
# and an expired one would end the stable identity.
openssl req -x509 -newkey rsa:3072 -nodes -days 7300 \
  -keyout "$work/key.pem" -out "$work/cert.pem" \
  -config "$work/cert.cnf" -extensions ext 2>/dev/null

openssl rand -base64 24 | tr -d '\n' >"$out/bro-signing.password"
# macOS `security import` reads only the legacy PKCS#12 algorithms.
openssl pkcs12 -export -legacy \
  -inkey "$work/key.pem" -in "$work/cert.pem" -name "bro self-signed code signing" \
  -passout "file:$out/bro-signing.password" -out "$out/bro-signing.p12"

fingerprint="$(openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"
cat <<EOF
Created $out/bro-signing.p12 (certificate SHA-1 $fingerprint).

Store it for the release workflow:
  base64 < "$out/bro-signing.p12" | gh secret set MACOS_SIGNING_P12_BASE64 --repo xiaotianxt/bro
  gh secret set MACOS_SIGNING_P12_PASSWORD --repo xiaotianxt/bro < "$out/bro-signing.password"
EOF
