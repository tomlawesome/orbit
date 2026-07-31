#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly base_url="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:3000}"

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
  pnpm test:e2e
else
  node node_modules/@playwright/test/cli.js test
fi
