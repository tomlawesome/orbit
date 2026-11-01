#!/usr/bin/env bash
#
# Pushes the exact image this run tested and then proves the registry is
# holding that image and not another: the returned digest is pulled back and
# its configuration identity compared with the tested one. Publishing without
# that round trip would leave evidence describing something nobody ran.
#
# Extracted verbatim from the "Push exact tested image" step of the
# retired GitHub container workflow, which the GitLab `record_image` job now runs (#801). Registry authentication and
# attestation stay with the caller.
#
# Inputs (environment):
#   IMAGE_TAG        the tag to push
#   TESTED_IMAGE_ID  configuration digest the published image must match
#
# Outputs: digest and id are appended to $GITHUB_OUTPUT when it is set.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"
# shellcheck source=scripts/release-metadata-patterns.sh
source "${repo_root}/scripts/release-metadata-patterns.sh"
# shellcheck source=scripts/ci/lib-digest.sh
source "${repo_root}/scripts/ci/lib-digest.sh"

: "${IMAGE_TAG:?the image tag to publish is required}"
: "${TESTED_IMAGE_ID:?the tested image identity is required}"

docker push "${IMAGE_TAG}"
# The first Digest: line comes from lib-digest.sh, which takes it without
# exiting awk early (the pipefail/SIGPIPE race on GitLab pipeline 169); see there.
published_digest="$(
  docker buildx imagetools inspect "${IMAGE_TAG}" |
    first_inspect_digest "$ORBIT_DIGEST_AWK_PATTERN"
)"
[[ "${published_digest}" =~ $ORBIT_DIGEST_PATTERN ]] || {
  printf 'Registry did not return a valid immutable image digest.\n' >&2
  exit 1
}
repository="${IMAGE_TAG%:*}"
docker pull "${repository}@${published_digest}"
published_image_id="$(
  docker image inspect --format '{{.Id}}' "${repository}@${published_digest}"
)"
[[ "${published_image_id}" == "${TESTED_IMAGE_ID}" ]] || {
  printf 'Published image identity %s does not match tested identity %s.\n' \
    "${published_image_id}" "${TESTED_IMAGE_ID}" >&2
  exit 1
}
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'digest=%s\n' "${published_digest}"
    printf 'id=%s\n' "${published_image_id}"
  } >> "${GITHUB_OUTPUT}"
fi
