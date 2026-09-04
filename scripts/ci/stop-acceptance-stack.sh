#!/usr/bin/env bash
#
# Tears the acceptance stack down, volumes and orphans included. The installer
# evidence that follows binds a disposable registry to a Compose project named
# "orbit", so this must have completed before it starts or the two collide.
#
# Extracted from the "Stop smoke-test services" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   COMPOSE_FILES  overlay set to tear down; defaults to the workflow's
#   ORBIT_IMAGE    defaulted, so Compose can still parse the files when the
#                  run failed before the image was recorded
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

readonly default_compose_files='-f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml'
read -r -a compose_files <<< "${COMPOSE_FILES:-${default_compose_files}}"

export ORBIT_IMAGE="${ORBIT_IMAGE:-orbit-local:000000000000}"
docker compose --env-file .env-orbit "${compose_files[@]}" --profile processing down --volumes --remove-orphans
