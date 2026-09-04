#!/usr/bin/env bash
#
# Prints what a failed acceptance run left behind: the service table, the full
# uncoloured logs, and the application container's health history. Without it
# a red tick says the stack was unhealthy and never says how.
#
# Extracted verbatim from the "Show service diagnostics" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). Runs on failure only, so it
# must never itself be the reason a run is red.
#
# Inputs (environment): ORBIT_IMAGE, defaulted so that Compose can still parse
# the files when the run failed before the image was recorded.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

export ORBIT_IMAGE="${ORBIT_IMAGE:-orbit-local:000000000000}"
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml ps
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml logs --no-color
app_container="$(docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml ps --quiet orbit-app)"
if [[ -n "${app_container}" ]]; then
  docker inspect --format='{{json .State.Health}}' "${app_container}"
fi
