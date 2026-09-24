#!/usr/bin/env bash
#
# Writes orbit-release-manifest.json (ADR-0031 #1): the one statement that
# binds a specific launcher build to a specific image digest, so a user's
# get-orbit.sh (ADR-0031 #6) can verify the pair together instead of trusting
# per-file signatures that would prove each file is ours without proving they
# belong together.
#
# Called by the record_image job in .gitlab-ci.yml, the moment the digest it
# describes has been pushed -- the same reason
# scripts/ci/gitlab-record-tested-image.sh writes its own transport record at
# that point rather than later: a record depending on a later step publishes
# nothing if that step fails.
#
# Slice 3 of ADR-0031's implementation list. record_image's wiring names two
# inputs this script cannot itself produce yet:
#
#   - the two launcher archives (ORBIT_LAUNCHER_AMD64_ARCHIVE,
#     ORBIT_LAUNCHER_ARM64_ARCHIVE) come from the `build_launcher` job
#     (ADR-0031 #3, implementation slice 2, not yet written); record_image
#     must add `needs: job: build_launcher, artifacts: true` and pass the
#     artifact paths through once that job exists.
#   - the launcher pin (ORBIT_LAUNCHER_TAG, ORBIT_LAUNCHER_COMMIT) comes from
#     launcher/pin.json (ADR-0031 #2, implementation slice 1, not yet
#     written).
#   - scripts/get-orbit.sh (ORBIT_GET_ORBIT_SCRIPT) does not exist until
#     implementation slice 6.
#
# Until all three land, invoking this from record_image fails the refusals
# below rather than writing a manifest -- the same fail-closed shape
# gitlab-record-tested-image.sh takes with a malformed field.
#
# Usage:
#   scripts/ci/write-release-manifest.sh <image-repository> <image-digest>
#
# Inputs (environment):
#   ORBIT_VERSION                 The Orbit version this manifest describes,
#                                  e.g. from the image's
#                                  org.opencontainers.image.version label
#                                  (scripts/ci/publish-channel.sh already
#                                  reads that label the same way).
#   ORBIT_LAUNCHER_TAG            launcher/pin.json's "tag" (vX.Y.Z).
#   ORBIT_LAUNCHER_COMMIT         launcher/pin.json's "commit" (40 hex).
#   ORBIT_LAUNCHER_AMD64_ARCHIVE  Path to orbit-launcher_linux_amd64.tar.gz.
#   ORBIT_LAUNCHER_ARM64_ARCHIVE  Path to orbit-launcher_linux_arm64.tar.gz.
#   ORBIT_INSTALL_SCRIPT          Path to install.sh. Default:
#                                  scripts/install.sh.
#   ORBIT_GET_ORBIT_SCRIPT        Path to get-orbit.sh. Default:
#                                  scripts/get-orbit.sh.
#   CI_COMMIT_SHA                 The commit this manifest is for, from the
#                                  predefined GitLab job environment.
#   CI_COMMIT_BRANCH              The branch this manifest is for, from the
#                                  predefined GitLab job environment. The
#                                  manifest's "channel" field is derived from
#                                  it by scripts/ci/channel-name.sh -- the one
#                                  place that mapping lives, shared with
#                                  scripts/ci/publish-channel.sh's channel
#                                  tag -- so record_image's own job script
#                                  carries no channel logic of its own.
#
# Output: writes .orbit-supply-chain/orbit-release-manifest.json and prints
# its path.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'write-release-manifest: %s\n' "$1" >&2; exit 1; }

image_repository="${1:-}"
image_digest="${2:-}"

[[ -n "$image_repository" ]] || fail 'an image repository is required as the first argument'
[[ -n "$image_digest" ]] || fail 'an image digest is required as the second argument'
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "image digest is not an immutable manifest digest: ${image_digest}"
[[ "$image_repository" =~ ^[A-Za-z0-9._-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)+$ ]] ||
  fail "image repository is not a plain registry reference: ${image_repository}"

version="${ORBIT_VERSION:-}"
branch="${CI_COMMIT_BRANCH:-}"
launcher_tag="${ORBIT_LAUNCHER_TAG:-}"
launcher_commit="${ORBIT_LAUNCHER_COMMIT:-}"
amd64_archive="${ORBIT_LAUNCHER_AMD64_ARCHIVE:-}"
arm64_archive="${ORBIT_LAUNCHER_ARM64_ARCHIVE:-}"
install_script="${ORBIT_INSTALL_SCRIPT:-scripts/install.sh}"
get_orbit_script="${ORBIT_GET_ORBIT_SCRIPT:-scripts/get-orbit.sh}"
commit="${CI_COMMIT_SHA:-}"

[[ -n "$version" ]] || fail 'ORBIT_VERSION is not set'
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
  fail "ORBIT_VERSION is not a plain semantic version: ${version}"
[[ -n "$branch" ]] || fail 'CI_COMMIT_BRANCH is not set'
# The mapping itself lives in scripts/ci/channel-name.sh, shared with
# publish-channel.sh's channel tag, so this script carries no copy of it.
channel="$(bash "${repo_root}/scripts/ci/channel-name.sh" "$branch" 2> /dev/null)" ||
  fail "CI_COMMIT_BRANCH (${branch}) is neither preview nor hotfix/*; the release manifest only covers publishing branches"
[[ -n "$launcher_tag" ]] || fail 'ORBIT_LAUNCHER_TAG is not set (launcher/pin.json "tag")'
[[ "$launcher_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
  fail "ORBIT_LAUNCHER_TAG is not a plain vX.Y.Z tag: ${launcher_tag}"
[[ -n "$launcher_commit" ]] || fail 'ORBIT_LAUNCHER_COMMIT is not set (launcher/pin.json "commit")'
[[ "$launcher_commit" =~ ^[0-9a-f]{40}$ ]] ||
  fail "ORBIT_LAUNCHER_COMMIT is not an exact commit SHA: ${launcher_commit}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "CI_COMMIT_SHA is not an exact commit SHA: ${commit:-<unset>}"

[[ -n "$amd64_archive" ]] || fail 'ORBIT_LAUNCHER_AMD64_ARCHIVE is not set (the build_launcher artifact, ADR-0031 implementation slice 2)'
[[ -n "$arm64_archive" ]] || fail 'ORBIT_LAUNCHER_ARM64_ARCHIVE is not set (the build_launcher artifact, ADR-0031 implementation slice 2)'
[[ -f "$amd64_archive" ]] || fail "ORBIT_LAUNCHER_AMD64_ARCHIVE does not point at a readable file: ${amd64_archive}"
[[ -f "$arm64_archive" ]] || fail "ORBIT_LAUNCHER_ARM64_ARCHIVE does not point at a readable file: ${arm64_archive}"
[[ -f "$install_script" ]] || fail "install script is not a readable file: ${install_script}"
[[ -f "$get_orbit_script" ]] || fail "get-orbit script is not a readable file: ${get_orbit_script} (does not exist until ADR-0031 implementation slice 6)"

sha256_of() {
  # sha256sum's first field, the same way ensure-cosign.sh's verify() reads it.
  sha256sum "$1" | awk '{ print $1 }'
}

amd64_sha="$(sha256_of "$amd64_archive")"
arm64_sha="$(sha256_of "$arm64_archive")"
install_sha="$(sha256_of "$install_script")"
get_orbit_sha="$(sha256_of "$get_orbit_script")"

recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
output_dir="${repo_root}/.orbit-supply-chain"
output="${output_dir}/orbit-release-manifest.json"

mkdir -p "$output_dir"
cat > "$output" <<JSON
{
  "schema": "https://tomlawson.io/schemas/orbit-release-manifest/v1",
  "version": "${version}",
  "channel": "${channel}",
  "commit": "${commit}",
  "image": {
    "repository": "${image_repository}",
    "digest": "${image_digest}"
  },
  "launcher": {
    "tag": "${launcher_tag}",
    "commit": "${launcher_commit}"
  },
  "files": {
    "orbit-launcher_linux_amd64.tar.gz": "sha256:${amd64_sha}",
    "orbit-launcher_linux_arm64.tar.gz": "sha256:${arm64_sha}",
    "install.sh": "sha256:${install_sha}",
    "get-orbit.sh": "sha256:${get_orbit_sha}"
  },
  "recordedAt": "${recorded_at}"
}
JSON

printf 'write-release-manifest: wrote %s\n' "$output"
