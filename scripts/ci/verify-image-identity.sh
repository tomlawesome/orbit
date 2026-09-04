#!/usr/bin/env bash
#
# Proves the image that was just built is the one this pipeline believes it
# built: exactly one tag, a valid configuration digest, labels that match the
# calculated version/revision/channel, files baked inside it that agree with
# those labels, and a `--version` the container reports for itself. Nothing
# downstream -- scan, acceptance, installer, publication -- means anything if
# the identity is not pinned here first.
#
# Extracted verbatim from the "Record exact local image identity" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   IMAGE_TAGS           newline-separated tag list from the metadata step;
#                        exactly one tag is required
#   EXPECTED_VERSION     the version the release-train calculator produced
#   ORBIT_REVISION       the source revision the image must carry
#   PUBLICATION_CHANNEL  the release stage the image must be labelled with
#
# Outputs: id, tag and version are appended to $GITHUB_OUTPUT and ORBIT_IMAGE
# to $GITHUB_ENV when those variables are set; a pipeline without them can
# point either at a file of its own.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

: "${IMAGE_TAGS:?the built image tag list is required}"
: "${EXPECTED_VERSION:?the calculated version is required}"
: "${ORBIT_REVISION:?the source revision is required}"
: "${PUBLICATION_CHANNEL:?the publication channel is required}"

mapfile -t image_tags < <(printf '%s\n' "${IMAGE_TAGS}" | sed '/^$/d')
[[ "${#image_tags[@]}" -eq 1 ]] || {
  printf 'Expected exactly one image tag, received %s.\n' "${#image_tags[@]}" >&2
  exit 1
}
image_tag="${image_tags[0]}"
image_id="$(docker image inspect --format '{{.Id}}' "${image_tag}")"
revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image_tag}")"
version="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "${image_tag}")"
release_stage="$(docker image inspect --format '{{ index .Config.Labels "io.github.tomlawesome.orbit.release-stage" }}' "${image_tag}")"
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'Built image has no valid configuration identity.\n' >&2
  exit 1
}
[[ "${revision}" == "${ORBIT_REVISION}" ]] || {
  printf 'Built image revision %s does not match workflow revision %s.\n' "${revision}" "${ORBIT_REVISION}" >&2
  exit 1
}
[[ "${version}" == "${EXPECTED_VERSION}" ]] || {
  printf 'Built image version %s does not match calculated version %s.\n' \
    "${version}" "${EXPECTED_VERSION}" >&2
  exit 1
}
[[ "${release_stage}" == "${PUBLICATION_CHANNEL}" ]] || {
  printf 'Built image stage %s does not match channel %s.\n' "${release_stage}" "${PUBLICATION_CHANNEL}" >&2
  exit 1
}
embedded_version="$(docker run --rm --entrypoint cat "${image_tag}" /opt/orbit/VERSION)"
embedded_revision="$(docker run --rm --entrypoint cat "${image_tag}" /opt/orbit/REVISION)"
embedded_channel="$(docker run --rm --entrypoint cat "${image_tag}" /opt/orbit/CHANNEL)"
[[ "${embedded_version}" == "${version}" ]] || {
  printf 'Embedded version does not match the image version label.\n' >&2
  exit 1
}
[[ "${embedded_revision}" == "${revision}" ]] || {
  printf 'Embedded revision does not match the image revision label.\n' >&2
  exit 1
}
[[ "${embedded_channel}" == "${release_stage}" ]] || {
  printf 'Embedded channel does not match the image release-stage label.\n' >&2
  exit 1
}
reported_version="$(docker run --rm "${image_tag}" --version)"
[[ "${reported_version}" == "Orbit ${version}" ]] || {
  printf 'Container version command did not report the embedded version.\n' >&2
  exit 1
}
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'id=%s\n' "${image_id}"
    printf 'tag=%s\n' "${image_tag}"
    printf 'version=%s\n' "${version}"
  } >> "${GITHUB_OUTPUT}"
fi
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'ORBIT_IMAGE=%s\n' "${image_tag}" >> "${GITHUB_ENV}"
fi
