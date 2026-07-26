#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# Static analysis covers the full-stack boundary; Vitest exercises all fast
# server, authentication, database, domain, and reducer tests without Docker.
if command -v pnpm >/dev/null 2>&1; then
  pnpm typecheck
  pnpm lint
  pnpm test
elif command -v node >/dev/null 2>&1 && [[ -d node_modules ]]; then
  # A direct local fallback avoids reinstalling dependencies solely to obtain
  # a package-manager shim; CI continues to use the locked pnpm workflow.
  node node_modules/typescript/bin/tsc --noEmit
  node node_modules/eslint/bin/eslint.js .
  node node_modules/vitest/vitest.mjs run
else
  printf 'Orbit tests: pnpm, or Node.js with installed dependencies, is required.\n' >&2
  exit 1
fi
