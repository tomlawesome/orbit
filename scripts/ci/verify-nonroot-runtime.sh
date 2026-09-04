#!/usr/bin/env bash
#
# Proves the application process runs as the unprivileged uid the image
# declares, and that every mounted secret is a regular file owned by that uid
# and readable by nobody else. A container that quietly fell back to root, or
# a secret left world-readable, is a finding this catches before publication.
#
# Extracted verbatim from the "Verify non-root runtime and private secrets"
# step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs: a running acceptance stack.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

runtime_uid="$(docker compose --env-file .env-orbit exec -T orbit-app \
  sh -c "awk '/^Uid:/{print \$2}' /proc/1/status")"
test "${runtime_uid}" = "1001"
docker compose --env-file .env-orbit exec -T orbit-app sh -c '
  for secret in /run/orbit-secrets/*; do
    test -f "${secret}"
    test "$(stat -c %u "${secret}")" = "1001"
    test "$(stat -c %a "${secret}")" = "400"
  done
'
