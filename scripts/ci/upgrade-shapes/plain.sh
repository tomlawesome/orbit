#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/ci/upgrade-shapes/lib.sh disable=SC2034
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# The defaults: the old example's active keys, nothing else.
shape_main "$@"
