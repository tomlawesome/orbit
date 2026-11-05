#!/usr/bin/env bash
# The acceptance stack's DKIM key (#1681). tests/e2e/v19-mail-collection.spec.ts
# signs forwarded mail with the private half; the orbit-dkim-dns stand-in
# (compose/docker-compose.acceptance.yml) publishes the public half as the
# TXT record for orbit-e2e._domainkey.example.test, which Orbit's DKIM key
# lookup is pointed at. Generated per stack into the gitignored secrets
# directory -- nothing here is ever committed.
#
# Idempotent: a key whose record file still matches it is left alone, so a
# running stack keeps verifying; anything missing or mismatched is replaced.
set -Eeuo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."

directory=".orbit-secrets"
[[ -d "$directory" ]] || { echo "run configure first: $directory missing" >&2; exit 1; }
key="$directory/dkim-test-key.pem"
record="$directory/dkim-test-record.txt"

# The record exactly as tests/support/dkim-signing.ts builds it: the key's
# SubjectPublicKeyInfo, DER, in base64.
record_for() {
  printf 'v=DKIM1; k=rsa; p=%s' "$(openssl pkey -in "$1" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"
}

if [[ -f "$key" && -f "$record" ]] && expected="$(record_for "$key")" && [[ "$expected" == "$(cat "$record")" ]]; then
  echo "dkim test key ready (unchanged)"
  exit 0
fi

(umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key" 2>/dev/null)
record_for "$key" > "$record"
printf '\n' >> "$record"
chmod 600 "$key"
# Read by the stand-in, which runs as an unprivileged user in its container;
# it is a public key.
chmod 644 "$record"
echo "dkim test key ready"
