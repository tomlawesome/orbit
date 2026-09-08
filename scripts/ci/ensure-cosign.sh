#!/usr/bin/env bash
#
# Puts a pinned cosign on PATH and prints its path -- the one place the pin
# lives, shared by the attesting job (scripts/ci/attest-tested-image.sh) and
# every verifier (scripts/ci/verify-validation-evidence.sh), so the two can
# never drift onto different releases (#661).
#
# cosign is the signing dependency the #661 spec adds: the only maintained way
# to bind validation evidence to a digest cryptographically on a self-hosted
# GitLab CE instance (keyless Sigstore needs an OIDC issuer the public trust
# root will accept, and gitlab.tomlawson.io is not one). Apache-2.0,
# https://github.com/sigstore/cosign. Installed as a release binary pinned by
# version and SHA-256 checksum, like the Trivy pin in
# .github/supply-chain-policy.json; the checksum below is from that release's
# cosign_checksums.txt (v3.1.3 verified current 2026-09-08).
#
# Usage:
#   cosign="$(bash scripts/ci/ensure-cosign.sh)"
#
# Output: the absolute path of a verified cosign binary on stdout; progress on
# stderr. An already-installed cosign of exactly the pinned version is used as
# is; anything else is downloaded, checksum-verified and cached under
# ORBIT_COSIGN_DIR (default: .orbit-cosign/ in the repository root).
set -Eeuo pipefail

readonly COSIGN_VERSION="3.1.3"
readonly COSIGN_SHA256="4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71"
readonly COSIGN_URL="https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64"

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

fail() { printf 'ensure-cosign: %s\n' "$1" >&2; exit 1; }

# A cosign already on PATH is only trusted at exactly the pinned version:
# "some cosign" is not a pin.
if command -v cosign > /dev/null 2>&1; then
  # sed reads to EOF and gitVersion appears once, so no early-exit consumer
  # sits downstream of the pipe (the SIGPIPE race of #809).
  installed="$(cosign version --json 2> /dev/null | sed -n 's/.*"gitVersion": *"v\{0,1\}\([0-9.]*\)".*/\1/p' || :)"
  if [[ "$installed" == "$COSIGN_VERSION" ]]; then
    command -v cosign
    exit 0
  fi
  printf 'ensure-cosign: PATH has cosign %s, not the pinned %s; installing the pin.\n' \
    "${installed:-<unknown>}" "$COSIGN_VERSION" >&2
fi

cache_dir="${ORBIT_COSIGN_DIR:-${repo_root}/.orbit-cosign}"
binary="${cache_dir}/cosign-${COSIGN_VERSION}"

verify() {
  printf '%s  %s\n' "$COSIGN_SHA256" "$1" | sha256sum -c - > /dev/null 2>&1
}

if [[ -x "$binary" ]] && verify "$binary"; then
  printf '%s\n' "$binary"
  exit 0
fi

mkdir -p "$cache_dir"
printf 'ensure-cosign: downloading cosign v%s\n' "$COSIGN_VERSION" >&2
curl --silent --show-error --fail --location --max-time 300 \
  --output "${binary}.download" "$COSIGN_URL" ||
  fail "could not download cosign v${COSIGN_VERSION} from ${COSIGN_URL}"
verify "${binary}.download" ||
  fail "downloaded cosign does not match the pinned SHA-256 ${COSIGN_SHA256}; refusing to run it"
chmod +x "${binary}.download"
mv "${binary}.download" "$binary"
printf '%s\n' "$binary"
