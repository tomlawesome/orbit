#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly base_url="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:3000}"

# The merge gate runs every test but the quarantined ones (tagged @quarantine:
# a test at its third flaky sighting, agent-infra#30). `--quarantine` runs only
# those, after the gate, against the same stack; CI reports its failure
# without failing the job. tests/e2e/playwright.config.ts does the selecting
# (ORBIT_E2E_QUARANTINE; its comment says why not --grep), and
# scripts/test-e2e-local.sh splits its run the same way. In the quarantine run:
#   - the gate has claimed the stack by then, so the config drops the
#     "unclaimed" project, which would fail (ORBIT_E2E_QUARANTINE=only does
#     that; ORBIT_E2E_REUSE is not set, so the #1077 database guard stays);
#   - its HTML report and its test-results go beside the gate's, not over
#     them;
#   - --pass-with-no-tests: a run with no quarantined test in its projects
#     would otherwise exit non-zero with "No tests found".
extra_args=()
case "${1:-}" in
  "")
    export ORBIT_E2E_QUARANTINE=exclude
    # Every @quarantine tag leaves this gate, so each must be on the reviewed
    # list (tests/quarantine.txt, scripts/check-quarantine.mjs).
    node scripts/check-quarantine.mjs || exit 1
    ;;
  --quarantine)
    export ORBIT_E2E_QUARANTINE=only
    export PLAYWRIGHT_HTML_OUTPUT_DIR="${PLAYWRIGHT_HTML_OUTPUT_DIR:-playwright-report/quarantine}"
    extra_args=(--pass-with-no-tests --output test-results/quarantine)
    ;;
  *)
    printf 'Orbit frontend tests: unknown argument %s (expected nothing, or --quarantine)\n' "$1" >&2
    exit 2
    ;;
esac

if ! command -v pnpm >/dev/null 2>&1 && {
  ! command -v node >/dev/null 2>&1 || [[ ! -f node_modules/@playwright/test/cli.js ]];
}; then
  printf 'Orbit frontend tests: pnpm, or Node.js with installed dependencies, is required.\n' >&2
  exit 1
fi
command -v curl >/dev/null 2>&1 || {
  printf 'Orbit frontend tests: curl is required.\n' >&2
  exit 1
}

curl --fail --silent --show-error --max-time 10 "$base_url/api/health" >/dev/null || {
  printf 'Orbit frontend tests: no healthy Orbit service at %s\n' "$base_url" >&2
  printf 'Start the Compose stack, or set PLAYWRIGHT_BASE_URL to a test deployment.\n' >&2
  exit 1
}

if command -v pnpm >/dev/null 2>&1; then
  pnpm test:e2e "${extra_args[@]}"
else
  node node_modules/@playwright/test/cli.js test --config tests/e2e/playwright.config.ts "${extra_args[@]}"
fi
