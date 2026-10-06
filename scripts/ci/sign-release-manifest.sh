#!/usr/bin/env bash
#
# Signs orbit-release-manifest.json (ADR-0031 #4): a cosign key-based
# blob signature, the second thing `sign_evidence` mints after the
# validation attestation (scripts/ci/attest-tested-image.sh) over the same
# digest. Same key, same no-transparency-log stance, same runner-only
# reasoning -- see the comment above attest-tested-image.sh and the
# sign_evidence job in .gitlab-ci.yml for why only that job may run this.
#
# Before signing, it refuses if the manifest's own image digest is not the
# digest this pipeline recorded as tested (gitlab-tested-image.json): a
# manifest naming a different digest would bind the launcher to the wrong
# image, which the whole point of a single signed manifest (ADR-0031 #1) is
# to prevent.
#
# cosign's key-based blob signature is the base64 of a DER-encoded ECDSA
# signature over the file's SHA-256 -- exactly what
# scripts/ci/verify-release-manifest.sh checks two ways, with cosign and with
# openssl, against the same committed key (cosign.pub).
#
# Usage:
#   scripts/ci/sign-release-manifest.sh <manifest-path> <expected-image-digest>
#
# Inputs (environment): the same three as scripts/ci/attest-tested-image.sh,
# for the same reason -- this runs in the same job, on the same runner.
#   ORBIT_SIGNING_DIR      The signing runner's read-only key mount
#                          (docs/releasing.md): must hold `cosign.key` and
#                          `password`. When set it supplies both values
#                          below.
#   COSIGN_PRIVATE_KEY     Path to the cosign private key. Derived from
#                          ORBIT_SIGNING_DIR when that is set; settable
#                          directly for tests. Never printed.
#   COSIGN_PASSWORD        The key's password. Read from
#                          ORBIT_SIGNING_DIR/password when that is set.
#   ORBIT_COSIGN           Optional; the cosign command to run, overridable
#                          only so tests can stub it. Real use resolves the
#                          pinned binary via scripts/ci/ensure-cosign.sh.
#
# Output: writes "<manifest-path>.sig" and prints its path.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'sign-release-manifest: %s\n' "$1" >&2; exit 1; }

manifest_path="${1:-}"
expected_digest="${2:-}"

[[ -n "$manifest_path" ]] || fail 'a manifest path is required as the first argument'
[[ -f "$manifest_path" ]] || fail "no manifest at ${manifest_path}"
[[ -n "$expected_digest" ]] || fail 'an expected image digest is required as the second argument'
[[ "$expected_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "expected image digest is not an immutable manifest digest: ${expected_digest}"

manifest_digest="$(node -e '
  const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof doc?.image?.digest === "string" ? doc.image.digest : "");
' -- "$manifest_path")"
[[ "$manifest_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "${manifest_path} has no well-formed image.digest; unusable as the thing to sign"
[[ "$manifest_digest" == "$expected_digest" ]] ||
  fail "the manifest's image digest (${manifest_digest}) differs from the digest this pipeline tested (${expected_digest}); refusing to sign a manifest for the wrong image"

# The preflight names the missing piece and where it comes from, exactly as
# attest-tested-image.sh does: the likeliest failure here is the same
# configuration gap, not a bad manifest.
if [[ -n "${ORBIT_SIGNING_DIR:-}" ]]; then
  [[ -d "$ORBIT_SIGNING_DIR" ]] ||
    fail "ORBIT_SIGNING_DIR is not a directory: ${ORBIT_SIGNING_DIR}. It is the orbit-signing runner's read-only key mount (docs/releasing.md); either this job is not running on that runner, or the owner setup has not created the host directory yet."
  COSIGN_PRIVATE_KEY="${ORBIT_SIGNING_DIR}/cosign.key"
  [[ -f "${ORBIT_SIGNING_DIR}/password" ]] ||
    fail "ORBIT_SIGNING_DIR has no password file: ${ORBIT_SIGNING_DIR}/password. The owner setup in docs/releasing.md places the key password there."
  COSIGN_PASSWORD="$(< "${ORBIT_SIGNING_DIR}/password")"
  export COSIGN_PASSWORD
fi
[[ -n "${COSIGN_PRIVATE_KEY:-}" ]] ||
  fail 'COSIGN_PRIVATE_KEY is not set and ORBIT_SIGNING_DIR is not set either. CI supplies ORBIT_SIGNING_DIR (the signing runner mount, docs/releasing.md); tests may set COSIGN_PRIVATE_KEY directly.'
[[ -f "$COSIGN_PRIVATE_KEY" ]] ||
  fail "COSIGN_PRIVATE_KEY does not point at a readable file: ${COSIGN_PRIVATE_KEY}. On the signing runner this is ORBIT_SIGNING_DIR/cosign.key; the owner setup in docs/releasing.md places it there."
[[ -n "${COSIGN_PASSWORD:-}" ]] ||
  fail 'COSIGN_PASSWORD is not set. It comes from ORBIT_SIGNING_DIR/password on the signing runner (docs/releasing.md); tests may set it directly.'

cosign_cmd="${ORBIT_COSIGN:-}"
if [[ -z "$cosign_cmd" ]]; then
  cosign_cmd="$(bash scripts/ci/ensure-cosign.sh)"
fi

signature_path="${manifest_path}.sig"
rm -f "$signature_path"

# Same two flags together as attest-tested-image.sh, for the same cosign v3
# reason: no Rekor here, key-based trust only, and --use-signing-config
# defaults to true so --tlog-upload=false must be paired with it or cosign
# refuses. --yes answers the interactive prompt a job cannot.
"$cosign_cmd" sign-blob \
  --key "$COSIGN_PRIVATE_KEY" \
  --tlog-upload=false \
  --use-signing-config=false \
  --yes \
  --output-signature "$signature_path" \
  "$manifest_path" ||
  fail "cosign could not sign ${manifest_path}"

[[ -s "$signature_path" ]] ||
  fail "cosign reported success but wrote no signature to ${signature_path}"

printf 'sign-release-manifest: signed %s (%s) as %s\n' \
  "$manifest_path" "$expected_digest" "$signature_path"
