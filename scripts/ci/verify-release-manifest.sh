#!/usr/bin/env bash
#
# Verifies orbit-release-manifest.json's signature two ways (ADR-0031 #4),
# both against the same committed key (cosign.pub): with cosign, and with
# openssl. Both must pass or this refuses -- proving on every publish that
# the openssl-compatible reading of a cosign key-based blob signature still
# holds, rather than assuming it. If a cosign upgrade ever changes the
# output format, this fails closed here rather than downstream in a user's
# get-orbit.sh, and the ADR's documented fallback is to sign with
# `openssl dgst -sha256 -sign` on the signing runner instead.
#
# cosign's key-based blob signature is the base64 of a DER-encoded ECDSA
# signature over the file's SHA-256, which is exactly what
# `openssl dgst -sha256 -verify` checks once the base64 is decoded back to
# the DER bytes.
#
# Called by publish_channel (scripts/ci/publish-channel.sh) before it
# creates the channel tag; shared by every other consumer named in
# ADR-0031 #5 (publish-from-gitlab.yml, release-on-tag.yml) so the
# verification logic cannot fork into drifting copies -- call this, do not
# inline a second version.
#
# Usage:
#   scripts/ci/verify-release-manifest.sh <manifest-path> [signature-path]
#
# signature-path defaults to "<manifest-path>.sig".
#
# Inputs (environment):
#   COSIGN_PUBLIC_KEY   Optional; path to the committed public key, default
#                        cosign.pub in the repository root.
#   ORBIT_COSIGN         Optional; the cosign command to run, overridable
#                        only so tests can stub it. Real use resolves the
#                        pinned binary via scripts/ci/ensure-cosign.sh.
#
# Output: a one-line acceptance naming the manifest and signature paths on
# success; a refusal naming which of the two checks failed, on stderr, exit
# 1.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'verify-release-manifest: %s\n' "$1" >&2; exit 1; }

manifest_path="${1:-}"
signature_path="${2:-${manifest_path:+${manifest_path}.sig}}"

[[ -n "$manifest_path" ]] || fail 'a manifest path is required as the first argument'
[[ -f "$manifest_path" ]] || fail "no manifest at ${manifest_path}"
[[ -n "$signature_path" ]] || fail 'no signature path (derived from the manifest path, or given as the second argument)'
[[ -f "$signature_path" ]] || fail "no signature at ${signature_path}"
[[ -s "$signature_path" ]] || fail "the signature at ${signature_path} is empty"

public_key="${COSIGN_PUBLIC_KEY:-${repo_root}/cosign.pub}"
[[ -f "$public_key" ]] ||
  fail "the validation public key is not at ${public_key}; the owner commits cosign.pub at the repository root (docs/releasing.md), and without it nothing can be verified"

# --- Check 1: cosign, the same key-based, no-transparency-log stance every
# other verifier in this repository takes (scripts/ci/verify-validation-evidence.sh).
cosign_cmd="${ORBIT_COSIGN:-}"
if [[ -z "$cosign_cmd" ]]; then
  cosign_cmd="$(bash scripts/ci/ensure-cosign.sh)"
fi

cosign_err="$(mktemp)"
der_file="$(mktemp)"
trap 'rm -f "$cosign_err" "$der_file"' EXIT

if ! "$cosign_cmd" verify-blob \
  --key "$public_key" \
  --signature "$signature_path" \
  --insecure-ignore-tlog=true \
  "$manifest_path" > /dev/null 2> "$cosign_err"; then
  sed 's/^/verify-release-manifest: cosign: /' "$cosign_err" >&2
  fail "cosign could not verify ${signature_path} against ${manifest_path} with ${public_key}"
fi

# --- Check 2: openssl, decoding the same base64 cosign wrote back to the DER
# ECDSA signature bytes it always is, then checking it the plain way -- the
# fact this script proves on every publish rather than assumes, per ADR-0031
# #4.
if ! base64 -d < "$signature_path" > "$der_file" 2> /dev/null; then
  fail "the signature at ${signature_path} is not valid base64; cosign sign-blob output is always base64-encoded DER"
fi
[[ -s "$der_file" ]] || fail "the signature at ${signature_path} decoded to no bytes"

if ! openssl dgst -sha256 -verify "$public_key" -signature "$der_file" "$manifest_path" > /dev/null 2>&1; then
  fail "openssl could not verify ${signature_path} against ${manifest_path} with ${public_key}"
fi

printf 'verify-release-manifest: verified %s against %s with cosign and openssl\n' \
  "$signature_path" "$manifest_path"
