#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# OIDC provider configured. Never signed in to: R6 on #1647.
SHAPE_ASSERTS=(env-file-intact oidc-intact)
shape_provision() {
  secret_file oidc-client-secret # the name docker-compose.yml mounts and the old target check wants (#1749)
  set_key ORBIT_AUTH_OIDC true
  set_key OIDC_ISSUER "https://orbit-oidc.invalid:4443/" # the tests/oidc stand-in the cell starts (#1750)
  set_key OIDC_CLIENT_ID orbit-upgrade-matrix
  set_key OIDC_CLIENT_SECRET ""
  set_key OIDC_CLIENT_SECRET_FILE /run/orbit-secrets/orbit-oidc-client-secret
}
shape_main "$@"
