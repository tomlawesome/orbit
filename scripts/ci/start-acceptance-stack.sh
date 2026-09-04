#!/usr/bin/env bash
#
# Brings up the acceptance stack -- application, database, mail sidecar and
# the disposable OIDC provider -- and waits for Compose to report every
# service healthy. `--no-build` is load-bearing: the stack must run the image
# that was built, scanned and identity-checked, never a rebuild of it.
#
# Extracted from the "Start application and database" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   COMPOSE_FILES  overlay set to bring up. Defaults to the set the workflow
#                  uses, which passes nothing; the GitLab lane appends its own
#                  docker-compose.ci-cap.yml to it.
#   ORBIT_IMAGE    the image under test, plus the .env-orbit written by
#                  scripts/ci/create-test-configuration.sh
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

readonly default_compose_files='-f docker-compose.yml -f docker-compose.mail.yml -f docker-compose.acceptance.yml'
read -r -a compose_files <<< "${COMPOSE_FILES:-${default_compose_files}}"

docker compose --env-file .env-orbit "${compose_files[@]}" up --detach --no-build --wait --wait-timeout 180
