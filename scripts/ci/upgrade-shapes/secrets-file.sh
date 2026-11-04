#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Every secret that can be a file stays a *_FILE reference, including OIDC's.
SHAPE_ASSERTS=(env-file-intact secret-file-referenced)
shape_provision() {
  secret_file oidc-client-secret
  set_key OIDC_CLIENT_SECRET_FILE .orbit-secrets/oidc-client-secret
}
shape_main "$@"
