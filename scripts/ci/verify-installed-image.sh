#!/usr/bin/env bash
#
# Proves the installer deployed the exact image this run tested, and nothing
# else: one digest-pinned ORBIT_IMAGE line resolving to the tested
# configuration digest, a running container on that same identity, a revision
# label matching the source, deployment assets identical to the checkout, no
# source tree left behind, no git shell-out, and a deployment that reaches the
# ready health state.
#
# Extracted verbatim from the "Verify exact-image installer evidence" step of
# the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   TESTED_IMAGE_ID   configuration digest of the image under test
#   INSTALL_TARGET    directory the installer was run in
#   GIT_MARKER        file the git guard touches if it is ever invoked
#   IMAGE_NAME        repository path the disposable registry served
#   ORBIT_REVISION    source revision the installed image must carry
#   GITHUB_WORKSPACE  optional; defaults to the repository root
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

: "${TESTED_IMAGE_ID:?the tested image identity is required}"
: "${INSTALL_TARGET:?the installer target is required}"
: "${GIT_MARKER:?the git guard marker path is required}"
: "${IMAGE_NAME:?the image repository name is required}"
: "${ORBIT_REVISION:?the source revision is required}"

workspace="${GITHUB_WORKSPACE:-${repo_root}}"
readonly workspace

[[ ! -e "${GIT_MARKER}" ]] || {
  printf 'The installer invoked git.\n' >&2
  exit 1
}

env_file="${INSTALL_TARGET}/.env-orbit"
[[ -f "${env_file}" && ! -L "${env_file}" ]] || {
  printf '%s is not a regular, non-symlink file.\n' "${env_file}" >&2
  exit 1
}

mapfile -t image_lines < <(grep -- '^ORBIT_IMAGE=' "${env_file}")
[[ "${#image_lines[@]}" -eq 1 ]] || {
  printf 'Expected exactly one ORBIT_IMAGE assignment in %s, found %s.\n' "${env_file}" "${#image_lines[@]}" >&2
  exit 1
}

expected_prefix="ORBIT_IMAGE=127.0.0.1:5000/${IMAGE_NAME}@sha256:"
image_line="${image_lines[0]}"
[[ "${image_line}" == "${expected_prefix}"* ]] || {
  printf '%s is not a digest-pinned disposable-registry reference.\n' "${image_line}" >&2
  exit 1
}
digest="${image_line#"${expected_prefix}"}"
[[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || {
  printf '%s does not carry a lowercase sha256 digest.\n' "${image_line}" >&2
  exit 1
}

resolved_reference="${image_line#ORBIT_IMAGE=}"
resolved_id="$(docker image inspect --format '{{.Id}}' "${resolved_reference}")"
[[ "${resolved_id}" == "${TESTED_IMAGE_ID}" ]] || {
  printf 'Digest-resolved image configuration %s does not match the tested image %s.\n' "${resolved_id}" "${TESTED_IMAGE_ID}" >&2
  exit 1
}

running_id="$(docker inspect --format '{{.Image}}' orbit)"
[[ "${running_id}" == "${TESTED_IMAGE_ID}" ]] || {
  printf 'Running orbit container image %s does not match the tested image %s.\n' "${running_id}" "${TESTED_IMAGE_ID}" >&2
  exit 1
}

revision_label="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${resolved_reference}")"
[[ "${revision_label}" == "${ORBIT_REVISION}" ]] || {
  printf 'Installed image revision %s does not match %s.\n' "${revision_label}" "${ORBIT_REVISION}" >&2
  exit 1
}

cmp --silent "${INSTALL_TARGET}/docker-compose.yml" "${workspace}/docker-compose.yml" || {
  printf 'Fetched docker-compose.yml does not match the checkout.\n' >&2
  exit 1
}
cmp --silent "${INSTALL_TARGET}/scripts/configure.sh" "${workspace}/scripts/configure.sh" || {
  printf 'Fetched scripts/configure.sh does not match the checkout.\n' >&2
  exit 1
}

for marker in .git Dockerfile src package.json package-lock.json pnpm-lock.yaml yarn.lock; do
  [[ ! -e "${INSTALL_TARGET}/${marker}" ]] || {
    printf 'Installer target unexpectedly contains %s after installation.\n' "${marker}" >&2
    exit 1
  }
done

ready=""
for _ in $(seq 1 60); do
  if response="$(curl --silent --fail http://127.0.0.1:3000/api/health)" &&
    jq --exit-status '.status == "ready" and .service == "orbit"' <<< "${response}" > /dev/null; then
    ready=1
    break
  fi
  sleep 2
done
[[ -n "${ready}" ]] || {
  printf 'Orbit did not reach the ready health state through the installer deployment.\n' >&2
  exit 1
}
