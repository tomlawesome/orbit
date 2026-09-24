#!/usr/bin/env bash
#
# Stands up a disposable registry on loopback and puts the exact image that
# was just tested into it, without rebuilding: the installer must resolve the
# image through a real registry round trip, the way an operator's does, and
# the local reference is dropped afterwards so it cannot silently be reused.
# Bound to 127.0.0.1 only -- this registry is evidence, never a publication
# target.
#
# Extracted verbatim from the "Start disposable installer registry" step of
# the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). It must run only after the
# acceptance stack is fully torn down (the Compose project name collides) and
# only before any registry login, push or attestation.
#
# Inputs (environment):
#   TESTED_IMAGE_TAG   the image under test
#   TESTED_IMAGE_ID    its configuration digest; the tag must still resolve to it
#   IMAGE_NAME         repository path used for the disposable tag
#   ORBIT_RUN_ID       CI run identifier, to keep names unique
#   ORBIT_RUN_ATTEMPT  CI run attempt, for the same reason
#
# Outputs: registry_name, channel, registry_id and release_manifest are
# appended to $GITHUB_OUTPUT when it is set. release_manifest (ADR-0031 #7)
# points at a freshly written orbit-release-manifest.json naming this exact
# push's digest -- scripts/ci/write-test-manifest.sh -- so a caller can hand
# it to install.sh via ORBIT_RELEASE_MANIFEST instead of install.sh
# self-fetching a signed manifest that does not exist yet for a locally
# built, unpublished image (#1107 pipeline 1626: "Could not download the
# release manifest").
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

: "${TESTED_IMAGE_TAG:?the tested image tag is required}"
: "${TESTED_IMAGE_ID:?the tested image identity is required}"
: "${IMAGE_NAME:?the image repository name is required}"
: "${ORBIT_RUN_ID:?the run identifier is required}"
: "${ORBIT_RUN_ATTEMPT:?the run attempt is required}"

emit_output() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  printf '%s=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT}"
}

run_attempt="${ORBIT_RUN_ID}-${ORBIT_RUN_ATTEMPT}"
registry_name="orbit-installer-registry-${run_attempt}"
channel="installer-${run_attempt}"
emit_output registry_name "${registry_name}"
emit_output channel "${channel}"

source_id="$(docker image inspect --format '{{.Id}}' "${TESTED_IMAGE_TAG}")"
[[ "${source_id}" == "${TESTED_IMAGE_ID}" ]] || {
  printf 'Source image identity %s does not match the tested identity %s.\n' "${source_id}" "${TESTED_IMAGE_ID}" >&2
  exit 1
}

# Bound to loopback only: this registry is disposable evidence, never a
# publication target.
#
# ORBIT_INSTALLER_REGISTRY_IMAGE lets GitLab CI route this pull through the
# group dependency proxy instead of hitting Docker Hub directly (ai/orbit#1111);
# the fallback is the same image, pinned by the same digest, straight from
# Docker Hub, for the GitHub workflow and any local run that has no proxy.
registry_id="$(
  docker run --detach --name "${registry_name}" --publish 127.0.0.1:5000:5000 \
    "${ORBIT_INSTALLER_REGISTRY_IMAGE:-registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373}"
)"
[[ "${registry_id}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'The disposable registry returned an invalid container identity.\n' >&2
  exit 1
}
emit_output registry_id "${registry_id}"

ready=""
for _ in $(seq 1 30); do
  if curl --silent --fail --output /dev/null http://127.0.0.1:5000/v2/; then
    ready=1
    break
  fi
  sleep 1
done
[[ -n "${ready}" ]] || {
  printf 'The disposable local registry did not become ready.\n' >&2
  exit 1
}

# No rebuild: retag and push the exact image already scanned above,
# then drop the local reference so the installer must resolve it
# through the registry round trip.
local_tag="127.0.0.1:5000/${IMAGE_NAME}:${channel}"
docker tag "${TESTED_IMAGE_TAG}" "${local_tag}"
docker push "${local_tag}" > /dev/null

# The digest this push actually gave the registry -- read from RepoDigests
# now, before the rmi below drops the only local reference that has it.
# Immutable, not a lookup of ${channel} again later: the same digest
# install.sh will pull and then re-check against the registry's own
# RepoDigests (scripts/install.sh's self_fetch/resolved_reference check).
# `grep -m1`, not `| head -n1` (#809): grep itself is the one process that
# stops once it has enough, rather than a separate head risking a SIGPIPE
# against docker still writing.
pushed_digest="$(
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${local_tag}" |
    grep -m1 -F "127.0.0.1:5000/${IMAGE_NAME}@"
)"
pushed_digest="${pushed_digest#*@}"
[[ "${pushed_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'Could not read the digest the disposable registry gave %s.\n' "${local_tag}" >&2
  exit 1
}

release_manifest="${repo_root}/.orbit-installer-registry-manifest.json"
bash "${repo_root}/scripts/ci/write-test-manifest.sh" \
  "${release_manifest}" "127.0.0.1:5000/${IMAGE_NAME}" "${pushed_digest}"
emit_output release_manifest "${release_manifest}"

docker rmi "${local_tag}" > /dev/null
