#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly base_url="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:3000}"

command -v pnpm >/dev/null 2>&1 || {
  printf 'Orbit frontend tests: pnpm is required.\n' >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  printf 'Orbit frontend tests: curl is required.\n' >&2
  exit 1
}

curl --fail --silent --show-error --max-time 10 "$base_url/api/health" >/dev/null || {
  printf 'Orbit frontend tests: no healthy Orbit service at %s\n' "$base_url" >&2
  printf 'Start the Compose stack, or set PLAYWRIGHT_BASE_URL to a test deployment.\n' >&2
  exit 1
}

pnpm test:e2e
