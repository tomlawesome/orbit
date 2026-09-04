#!/usr/bin/env bash
#
# Brings up the acceptance stack -- application, database, mail sidecar and
# the disposable OIDC provider -- and waits for Compose to report every
# service healthy. `--no-build` is load-bearing: the stack must run the image
# that was built, scanned and identity-checked, never a rebuild of it.
#
# Extracted verbatim from the "Start application and database" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment): ORBIT_IMAGE, plus the .env-orbit written by
# scripts/ci/create-test-configuration.sh.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml up --detach --no-build --wait --wait-timeout 180
