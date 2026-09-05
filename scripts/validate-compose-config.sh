#!/usr/bin/env bash
#
# Thin wrapper: the checks live in scripts/ci/validate-compose.sh (#804), so
# CI and this operator-facing preview preflight can never drift again. This
# adds only the preflight's own success banner around that shared call.
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bash scripts/ci/validate-compose.sh

printf 'Orbit preview preflight: Compose configuration valid for %s at %s.\n' \
  "$ORBIT_VERSION" "$ORBIT_REVISION"
