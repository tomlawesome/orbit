#!/usr/bin/env bash
#
# Puts a pinned, verified opengrep in a cache directory and prints its path --
# the one place the opengrep pin lives, used by scripts/ci/scan-opengrep.sh
# (#1592).
#
# opengrep is a code-pattern scanner (a community fork of Semgrep CE, engine
# LGPL-2.1, https://github.com/opengrep/opengrep). It runs only the rules this
# repository keeps in .opengrep/rules/ (owner, #1592): never a registry or
# downloaded rule set.
#
# Version: v2.0.0 (2026-11-13), the newest release at least three days old on
# 2026-11-24. It is one static binary with no embedded Python, so the 1.x
# advisory where the binary imported Python modules from the scanned
# directory (GHSA-gr98-vh6p-jh9v) cannot apply to it.
#
# Verification, both required, either failure refuses:
#   1. SHA-256 of the release asset. Upstream publishes no checksum file; the
#      value below was recorded by us on 2026-11-24 from the asset we
#      downloaded and Cosign-verified, and it matches the digest GitHub's
#      release API reports for that asset. It refuses a different binary even
#      if upstream's workflow signed it.
#   2. Cosign keyless signature (the asset's .sig and .cert from the same
#      release), checked with the repository's pinned cosign
#      (scripts/ci/ensure-cosign.sh) against the exact signing identity, the
#      GitHub Actions OIDC issuer, and the source commit the v2.0.0 tag points
#      to. The identity is the workflow on main, not the tag, so the commit pin
#      is what ties the signature to this release. This step needs the
#      Sigstore public services (TUF root and Rekor) reachable.
#
# To bump: pick the newest release at least three days old on
# https://github.com/opengrep/opengrep/releases; download opengrep_linux_x86
# with its .sig and .cert; read the identity (Subject Alternative Name) and
# the source commit (the Fulcio "Source Repository Digest" extension) from the .cert
# (base64 -d < opengrep_linux_x86.cert | openssl x509 -noout -text); check that
# commit is the tag's; cosign verify-blob it by hand as below; then set all
# five constants from that one asset. Run `opengrep test .opengrep/tests`
# before committing the bump.
#
# Usage:
#   opengrep="$(bash scripts/ci/ensure-opengrep.sh)"
#
# Output: the absolute path of a verified opengrep binary on stdout; progress
# on stderr. Cached under ${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools};
# a cached copy is re-checked against the SHA-256 on every call. Linux x86_64
# only.
set -Eeuo pipefail

readonly OPENGREP_VERSION="2.0.0"
readonly OPENGREP_SHA256="37e93f4da5fd04a18c5c1febbdd12f7e98dfccd4d0c9cf2593bcb25eeb462da0"
readonly OPENGREP_SOURCE_COMMIT="526deafe6f0519c272bbee316fea8df26dd85dfa"
readonly OPENGREP_CERT_IDENTITY="https://github.com/opengrep/opengrep/.github/workflows/rolling-release.yml@refs/heads/main"
readonly OPENGREP_CERT_ISSUER="https://token.actions.githubusercontent.com"
readonly OPENGREP_URL="https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_linux_x86"

repo_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

fail() { printf 'ensure-opengrep: %s\n' "$1" >&2; exit 1; }

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  fail "only Linux x86_64 is supported (this is $(uname -s) $(uname -m))"
fi

cache_dir="${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}/opengrep-${OPENGREP_VERSION}"
binary="${cache_dir}/opengrep"

verify_sha() {
  printf '%s  %s\n' "$OPENGREP_SHA256" "$1" | sha256sum -c - > /dev/null 2>&1
}

# The SHA-256 is pinned to the exact file that passed Cosign when it was
# recorded, so a cached copy that still matches it is that same file.
if [[ -x "$binary" ]] && verify_sha "$binary"; then
  printf '%s\n' "$binary"
  exit 0
fi

cosign="$(bash "${repo_root}/scripts/ci/ensure-cosign.sh")" ||
  fail "could not get the pinned cosign to verify opengrep"

mkdir -p "$cache_dir"
staging="$(mktemp -d "${cache_dir}/download.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT

printf 'ensure-opengrep: downloading opengrep v%s\n' "$OPENGREP_VERSION" >&2
for suffix in "" ".sig" ".cert"; do
  curl --silent --show-error --fail --location --proto '=https' --max-time 600 \
    --output "${staging}/opengrep${suffix}" "${OPENGREP_URL}${suffix}" ||
    fail "could not download ${OPENGREP_URL}${suffix}"
done

verify_sha "${staging}/opengrep" ||
  fail "downloaded opengrep does not match the pinned SHA-256 ${OPENGREP_SHA256}; refusing to run it"

"$cosign" verify-blob \
  --certificate "${staging}/opengrep.cert" \
  --signature "${staging}/opengrep.sig" \
  --certificate-identity "$OPENGREP_CERT_IDENTITY" \
  --certificate-oidc-issuer "$OPENGREP_CERT_ISSUER" \
  --certificate-github-workflow-sha "$OPENGREP_SOURCE_COMMIT" \
  "${staging}/opengrep" > /dev/null 2>"${staging}/cosign.log" || {
  sed 's/^/ensure-opengrep: cosign: /' "${staging}/cosign.log" >&2
  fail "opengrep v${OPENGREP_VERSION} failed Cosign verification (identity ${OPENGREP_CERT_IDENTITY}, commit ${OPENGREP_SOURCE_COMMIT}); refusing to run it"
}

chmod +x "${staging}/opengrep"
mv "${staging}/opengrep" "$binary"
printf '%s\n' "$binary"
