#!/usr/bin/env bash
#
# Proves the running application printed its startup banner exactly once and,
# with it, one immutable identity line naming the version, channel and source
# revision it was built from. Once, not at least once: a duplicate line means
# the process restarted, and an identity that disagrees with the build means
# the stack is running something other than the image under test.
#
# Extracted verbatim from the "Verify startup banner and immutable identity"
# step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   TESTED_IMAGE_VERSION  version the banner must report
#   PUBLICATION_CHANNEL   channel the banner must report
#   ORBIT_REVISION        source revision the banner must report
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

: "${TESTED_IMAGE_VERSION:?the tested image version is required}"
: "${PUBLICATION_CHANNEL:?the publication channel is required}"
: "${ORBIT_REVISION:?the source revision is required}"

startup_logs="$(docker compose --env-file .env-orbit logs --no-color orbit-app)"
startup_logs="$(sed -E 's/^[^|]*\| //' <<< "${startup_logs}")"
banner_line='  ·      ·    ·    ██████╗  ██████╗  ██████╗  ██╗ ████████╗   ·      ·      ·'
version="${TESTED_IMAGE_VERSION}"
release_stage="${PUBLICATION_CHANNEL}"
revision="${ORBIT_REVISION}"
identity_line="Orbit ${version} | channel=${release_stage} | revision=${revision}"
banner_count="$(grep --fixed-strings --line-regexp --count "${banner_line}" <<< "${startup_logs}" || true)"
identity_count="$(grep --fixed-strings --line-regexp --count "${identity_line}" <<< "${startup_logs}" || true)"
[[ "${banner_count}" -eq 1 ]] || {
  printf 'Expected the Orbit startup banner once, found %s.\n' "${banner_count}" >&2
  exit 1
}
[[ "${identity_count}" -eq 1 ]] || {
  printf 'Expected the immutable startup identity once, found %s.\n' "${identity_count}" >&2
  exit 1
}
