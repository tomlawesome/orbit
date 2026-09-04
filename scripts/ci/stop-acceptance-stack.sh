#!/usr/bin/env bash
#
# Tears the acceptance stack down, volumes and orphans included. The installer
# evidence that follows binds a disposable registry to a Compose project named
# "orbit", so this must have completed before it starts or the two collide.
#
# Extracted verbatim from the "Stop smoke-test services" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment): ORBIT_IMAGE, defaulted so that Compose can still parse
# the files when the run failed before the image was recorded.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

export ORBIT_IMAGE="${ORBIT_IMAGE:-orbit-local:000000000000}"
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml --profile processing down --volumes --remove-orphans
