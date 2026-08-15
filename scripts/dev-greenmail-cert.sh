#!/usr/bin/env bash
# The mail proving ground's TLS identity (#459). Orbit's provider construction
# hardcodes certificate verification (rightly), so the disposable GreenMail
# sidecar needs a cert with the right name that Orbit can be told to trust.
# Generated fresh into the gitignored secrets directory — nothing here is ever
# committed. The keystore password protects a throwaway key on this machine
# only, same class as the acceptance overlay's other test-only literals.
set -Eeuo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."

directory=".orbit-secrets"
[[ -d "$directory" ]] || { echo "run configure first: $directory missing" >&2; exit 1; }

openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout "$directory/greenmail-key.pem" \
  -out "$directory/greenmail-ca.pem" \
  -subj "/CN=orbit-greenmail" \
  -addext "subjectAltName=DNS:orbit-greenmail" >/dev/null 2>&1

openssl pkcs12 -export \
  -in "$directory/greenmail-ca.pem" \
  -inkey "$directory/greenmail-key.pem" \
  -name greenmail \
  -out "$directory/greenmail.p12" \
  -passout pass:orbit-proving-ground

chmod 600 "$directory"/greenmail-key.pem
chmod 644 "$directory"/greenmail.p12
chmod 644 "$directory"/greenmail-ca.pem
echo "greenmail certificate ready"
