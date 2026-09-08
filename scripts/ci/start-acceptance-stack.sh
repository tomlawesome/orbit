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
#                  compose/docker-compose.ci-cap.yml to it.
#   ORBIT_IMAGE    the image under test, plus the .env-orbit written by
#                  scripts/ci/create-test-configuration.sh
#
# #536: this is the one command in the container-validation-steps sequence
# that creates or attaches to the stack -- every later step in the same job
# (verify-*.sh, show-stack-diagnostics.sh, stop-acceptance-stack.sh) only
# operates on whatever this call already brought up, so guarding here covers
# the whole sequence. It is also the exact shape of the reported defect: a
# bare `docker compose --env-file .env-orbit ... up` with no `-p`, runnable
# by hand from any checkout to reproduce a red job locally. See
# scripts/compose-isolation-preflight.sh.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

# shellcheck source=../compose-isolation-preflight.sh
source "${repo_root}/scripts/compose-isolation-preflight.sh"

readonly default_compose_files='-f docker-compose.yml -f docker-compose.mail.yml -f compose/docker-compose.acceptance.yml'
read -r -a compose_files <<< "${COMPOSE_FILES:-${default_compose_files}}"

project="$(resolve_compose_project .env-orbit "${compose_files[@]}")" ||
  { printf 'start-acceptance-stack: could not resolve the Compose project (is .env-orbit present?).\n' >&2; exit 1; }
readonly project
compose_isolation_preflight "$project" \
  "docker compose -p ${project}-$$ --env-file .env-orbit ${compose_files[*]} up --detach --no-build --wait --wait-timeout 180" ||
  exit 1

docker compose --env-file .env-orbit "${compose_files[@]}" up --detach --no-build --wait --wait-timeout 180
