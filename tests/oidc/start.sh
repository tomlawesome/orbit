#!/bin/sh
set -eu

certificate_dir="$(mktemp -d)"
trap 'rm -rf "$certificate_dir"' EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$certificate_dir/key.pem" \
  -out "$certificate_dir/cert.pem" \
  -subj '/CN=Orbit browser-test OIDC' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
  >/dev/null 2>&1

exec node server.mjs "$certificate_dir/key.pem" "$certificate_dir/cert.pem"
