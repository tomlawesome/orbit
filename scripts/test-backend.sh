#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# Static analysis covers the full-stack boundary; Vitest exercises all fast
# server, authentication, database, domain, and reducer tests without Docker.
#
# The v19 front end compiles here too (#620). `pnpm typecheck` cannot see it --
# the root tsconfig sets allowJs false and web/src holds no TypeScript -- so
# before this, a .svelte file that did not compile first failed at the container
# build on the preview push, long after it merged green. The build is ~10s.
if command -v pnpm >/dev/null 2>&1; then
  pnpm typecheck
  pnpm lint
  pnpm --filter orbit-web build
  node scripts/check-v19-types.mjs
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
  # Mirrors web/package.json's own `build`: the licence collector writes
  # static/licenses, which the SvelteKit build then bundles.
  (cd web && node scripts/collect-font-licences.mjs \
    && node ../node_modules/vite/bin/vite.js build)
  node scripts/check-v19-types.mjs
  if [[ "${ORBIT_TEST_COVERAGE:-false}" == "true" ]]; then
    node node_modules/vitest/vitest.mjs run --coverage
  else
    node node_modules/vitest/vitest.mjs run
  fi
else
  printf 'Orbit tests: pnpm, or Node.js with installed dependencies, is required.\n' >&2
  exit 1
fi
