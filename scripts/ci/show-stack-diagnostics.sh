#!/usr/bin/env bash
#
# Prints what a failed acceptance run left behind: the service table, the full
# uncoloured logs, and the application container's health history. Without it
# a red tick says the stack was unhealthy and never says how.
#
# Extracted from the "Show service diagnostics" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). Runs on failure only, so it
# must never itself be the reason a run is red.
#
# Deliberately without `set -e`: the run has already failed by the time this
# starts, and the first command that errors must not stop the rest of the
# evidence printing. `docker compose ps` failing is exactly the case where the
# logs are most wanted, and aborting there is how a red tick ends up naming
# nothing.
#
# Inputs (environment):
#   COMPOSE_FILES  overlay set to inspect; defaults to the workflow's
#   ORBIT_IMAGE    defaulted, so Compose can still parse the files when the
#                  run failed before the image was recorded
set -Euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
# Without `set -e` a failed cd would otherwise carry on and inspect whatever
# Compose project the working directory happens to hold.
cd "${repo_root}" || exit 1

readonly default_compose_files='-f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml'
read -r -a compose_files <<< "${COMPOSE_FILES:-${default_compose_files}}"

export ORBIT_IMAGE="${ORBIT_IMAGE:-orbit-local:000000000000}"
docker compose --env-file .env-orbit "${compose_files[@]}" ps
docker compose --env-file .env-orbit "${compose_files[@]}" logs --no-color
app_container="$(docker compose --env-file .env-orbit "${compose_files[@]}" ps --quiet orbit-app)"
if [[ -n "${app_container}" ]]; then
  docker inspect --format='{{json .State.Health}}' "${app_container}"
fi
