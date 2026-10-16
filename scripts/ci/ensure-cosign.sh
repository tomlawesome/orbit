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
#
# Except on the signing path (#1368): with the signing key in reach it never
# downloads. The signing path is keyed on the key mount itself --
# ORBIT_SIGNING_DIR set, as sign_evidence sets it for both signing scripts,
# or the runner's mount point /etc/orbit-signing present -- never on a
# variable an image could set. There the pinned cosign must already be on
# PATH, baked into sign_evidence's $ORBIT_SIGNING_IMAGE by
# ai/orbit-base-image's Dockerfile.signing; anything else is refused. The
# download below stays for every other caller: publish_channel's and
# promote_stable's verifiers, and local runs, none of which can reach the key.
set -Eeuo pipefail

# Renovate bumps COSIGN_VERSION on its own (renovate.json's custom regex
# manager, #1116) but cannot compute COSIGN_SHA256 -- a release asset
# checksum -- so a version-only bump leaves this mismatched and the
# checksum check below fails until a human copies the new checksum from
# that release's cosign_checksums.txt by hand.
readonly COSIGN_VERSION="3.1.3"
readonly COSIGN_SHA256="4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71"
readonly COSIGN_URL="https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64"

# Where the orbit-signing runner mounts the key (docs/releasing.md).
readonly SIGNING_MOUNT="/etc/orbit-signing"

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

fail() { printf 'ensure-cosign: %s\n' "$1" >&2; exit 1; }

signing_path=false
if [[ -n "${ORBIT_SIGNING_DIR:-}" || -e "$SIGNING_MOUNT" ]]; then
  signing_path=true
fi
installed=""

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
  if [[ "$signing_path" == false ]]; then
    printf 'ensure-cosign: PATH has cosign %s, not the pinned %s; installing the pin.\n' \
      "${installed:-<unknown>}" "$COSIGN_VERSION" >&2
  fi
fi

# Checked before the cache as well as the download: on the signing path the
# only cosign trusted is the one the signing image was built with, and no
# directory is created for a download that will not happen.
if [[ "$signing_path" == true ]]; then
  if command -v cosign > /dev/null 2>&1; then
    found="cosign ${installed:-<unknown version>} on PATH"
  else
    found="no cosign on PATH"
  fi
  fail "refusing to download cosign with the signing key in reach (${ORBIT_SIGNING_DIR:-$SIGNING_MOUNT}): found ${found}, need v${COSIGN_VERSION}. sign_evidence must run on \$ORBIT_SIGNING_IMAGE, which bakes in this exact cosign (ai/orbit-base-image Dockerfile.signing, #1368); if the pin moved here, rebuild that image and re-pin it."
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
