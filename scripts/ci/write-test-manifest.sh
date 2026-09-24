#!/usr/bin/env bash
#
# Writes a release manifest (ADR-0031 #1's schema) for a locally built,
# not-yet-published image, so a CI harness can hand install.sh an
# already-verified manifest via ORBIT_RELEASE_MANIFEST instead of install.sh
# self-fetching a signed manifest that does not exist yet for this image
# (ADR-0031 #7's "handed over already verified" path -- get-orbit.sh and the
# launcher use the same path for the real thing).
#
# Why not scripts/ci/write-release-manifest.sh: that script is the real
# publication-time writer, and refuses outside its own narrow context --
# CI_COMMIT_BRANCH must be preview/hotfix/*, and it needs the launcher
# archives, launcher pin and a semantic ORBIT_VERSION, none of which exist in
# an ordinary merge request pipeline. The harnesses this script serves
# (repair_journeys, acceptance, launcher_install_compat) run on every merge
# request and test a throwaway image with none of that context. install.sh
# itself, when handed ORBIT_RELEASE_MANIFEST directly, reads only the
# manifest's "digest" field (scripts/install.sh's manifest_field/
# resolved_reference) -- everything else in the schema is descriptive -- so
# this script fills the rest with fixed, schema-valid placeholder values
# instead of pretending to a real version, launcher pin or file set. The
# shape below matches write-release-manifest.sh's output field for field so
# the two are easy to compare by eye.
#
# Usage:
#   scripts/ci/write-test-manifest.sh <output-path> <image-repository> <image-digest>
#
# <image-repository> is the repository the harness's disposable registry
# serves (e.g. 127.0.0.1:5000/tomlawesome/orbit) -- written into the
# manifest's image.repository field for readability only; install.sh computes
# its own pull reference from ORBIT_REGISTRY/ORBIT_REPOSITORY and reads only
# the digest back out of the manifest.
# <image-digest> is the immutable "sha256:<64 hex>" digest the harness's own
# registry push just produced -- the same value install.sh will pull and then
# re-check against the registry's RepoDigests, so it must be the real digest
# of the exact image under test, not a tag.
#
# Output: writes <output-path> and prints it.
set -Eeuo pipefail

fail() { printf 'write-test-manifest: %s\n' "$1" >&2; exit 1; }

output="${1:-}"
image_repository="${2:-}"
image_digest="${3:-}"

[[ -n "$output" ]] || fail 'an output path is required as the first argument'
[[ -n "$image_repository" ]] || fail 'an image repository is required as the second argument'
[[ -n "$image_digest" ]] || fail 'an image digest is required as the third argument'
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "image digest is not an immutable manifest digest: ${image_digest}"
[[ "$image_repository" =~ ^[A-Za-z0-9._-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)+$ ]] ||
  fail "image repository is not a plain registry reference: ${image_repository}"

output_dir="$(dirname -- "$output")"
mkdir -p "$output_dir"

recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
placeholder_sha="0000000000000000000000000000000000000000000000000000000000000000"
placeholder_sha="${placeholder_sha:0:64}"
placeholder_commit="0000000000000000000000000000000000000000"

cat > "$output" <<JSON
{
  "schema": "https://tomlawson.io/schemas/orbit-release-manifest/v1",
  "version": "0.0.0-ci-test",
  "channel": "ci-test",
  "commit": "${placeholder_commit}",
  "image": {
    "repository": "${image_repository}",
    "digest": "${image_digest}"
  },
  "launcher": {
    "tag": "v0.0.0",
    "commit": "${placeholder_commit}"
  },
  "files": {
    "orbit-launcher_linux_amd64.tar.gz": "sha256:${placeholder_sha}",
    "orbit-launcher_linux_arm64.tar.gz": "sha256:${placeholder_sha}",
    "install.sh": "sha256:${placeholder_sha}",
    "get-orbit.sh": "sha256:${placeholder_sha}"
  },
  "recordedAt": "${recorded_at}"
}
JSON

printf 'write-test-manifest: wrote %s for %s@%s\n' "$output" "$image_repository" "$image_digest"
