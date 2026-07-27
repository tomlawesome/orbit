#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# Static analysis covers the full-stack boundary; Vitest exercises all fast
# server, authentication, database, domain, and reducer tests without Docker.
if command -v pnpm >/dev/null 2>&1; then
  pnpm typecheck
  pnpm lint
  if [[ "${ORBIT_TEST_COVERAGE:-false}" == "true" ]]; then
    pnpm test:coverage
  else
    pnpm test
  fi
elif command -v node >/dev/null 2>&1 && [[ -d node_modules ]]; then
  # A direct local fallback avoids reinstalling dependencies solely to obtain
  # a package-manager shim; CI continues to use the locked pnpm workflow.
  node node_modules/typescript/bin/tsc --noEmit
  node node_modules/eslint/bin/eslint.js .
  if [[ "${ORBIT_TEST_COVERAGE:-false}" == "true" ]]; then
    node node_modules/vitest/vitest.mjs run --coverage
  else
    node node_modules/vitest/vitest.mjs run
  fi
else
  printf 'Orbit tests: pnpm, or Node.js with installed dependencies, is required.\n' >&2
  exit 1
fi
