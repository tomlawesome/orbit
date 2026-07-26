#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bash scripts/test-backend.sh

if [[ "${ORBIT_SKIP_E2E:-false}" == "true" ]]; then
  printf 'Orbit tests: browser checks skipped because ORBIT_SKIP_E2E=true.\n'
else
  bash scripts/test-frontend.sh
fi
