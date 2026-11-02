#!/usr/bin/env bash
# The signing-key preflight, shared by the jobs that sign with the orbit-signing
# runner's key (#1363): scripts/ci/attest-tested-image.sh and
# scripts/ci/sign-release-manifest.sh. Source it; it runs nothing by itself.
#
# require_signing_key reports through the sourcing script's own `fail`
# (message in, exit 1), so each job keeps its own message prefix, and it sets
# COSIGN_PRIVATE_KEY and exports COSIGN_PASSWORD in the sourcing shell. It must
# run in that shell, not in a command substitution.
#
# The preflight names the missing piece and where it comes from, because the
# likeliest failure is configuration: the key mount only exists on the
# orbit-signing runner, and only after the owner setup in docs/releasing.md
# has placed the files on its host.
require_signing_key() {
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
}
