#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

command -v pnpm >/dev/null 2>&1 || {
  printf 'Orbit tests: pnpm is required.\n' >&2
  exit 1
}

# Static analysis covers the full-stack boundary; Vitest exercises all fast
# server, authentication, database, domain, and reducer tests without Docker.
pnpm typecheck
pnpm lint
pnpm test
