#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# OIDC provider configured. Never signed in to: R6 on #1647.
SHAPE_ASSERTS=(env-file-intact oidc-intact)
shape_provision() {
  secret_file orbit-oidc-client-secret # the old release accepts only this name
  set_key ORBIT_AUTH_OIDC true
  set_key OIDC_ISSUER "$APP_HOST/oidc/"
  set_key OIDC_CLIENT_ID orbit-upgrade-matrix
  set_key OIDC_CLIENT_SECRET ""
  set_key OIDC_CLIENT_SECRET_FILE /run/orbit-secrets/orbit-oidc-client-secret
}
shape_main "$@"
