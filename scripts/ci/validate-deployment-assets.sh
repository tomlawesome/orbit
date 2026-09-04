#!/usr/bin/env bash
#
# Proves the base compose file describes a deployment truthfully: an operator
# who fetched only the deployment assets has no Dockerfile and no source, so a
# build declaration there would describe something absent. The assets are
# copied into an empty directory and validated with nothing else present.
#
# Extracted verbatim from the "Validate the deployment asset set without a
# source tree" step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs: none beyond the repository checkout and a generated .env-orbit.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

deployment="$(mktemp -d)"
cp docker-compose.yml docker-compose.mail.yml docker-compose.mail-alias-rotation.yml "${deployment}/"
cp .env-orbit "${deployment}/"
mkdir -p "${deployment}/config"
cp config/tika-config.json "${deployment}/config/"
[[ ! -e "${deployment}/Dockerfile" ]] || {
  printf 'The deployment asset set must not contain a Dockerfile.\n' >&2
  exit 1
}
docker compose --project-directory "${deployment}" --env-file "${deployment}/.env-orbit" \
  -f "${deployment}/docker-compose.yml" config --quiet
docker compose --project-directory "${deployment}" --env-file "${deployment}/.env-orbit" \
  -f "${deployment}/docker-compose.yml" -f "${deployment}/docker-compose.mail.yml" config --quiet
rm -rf "${deployment}"
