#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# Cheapest check first, and node_modules-free: catches the pnpm 11 -> 12.3.4
# handoff writing an @pnpm/exe block back into the lockfile (#901). Runs via
# `node --test`, not Vitest -- see vitest.config.ts's exclude entry for why.
node --test scripts/lockfile-no-pnpm-exe.test.mjs

# Static analysis covers the full-stack boundary; Vitest exercises all fast
# server, authentication, database, domain, and reducer tests without Docker.
#
# The v19 front end compiles here too (#620). `pnpm typecheck` cannot see it --
# the root tsconfig sets allowJs false and web/src holds no TypeScript -- so
# before this, a .svelte file that did not compile first failed at the container
# build on the preview push, long after it merged green. The build is ~10s.
# check-v19-types.mjs is a plain svelte-check gate (#624): zero errors, no
# per-file tolerance left anywhere.
#
# ORBIT_TEST_SKIP_DOCKER (#950): the CI `fast` job runs on the unprivileged
# `big` lane, which has no `docker` binary on PATH at all -- confirmed by
# running every test file that mentions Docker with a PATH built from
# /usr/bin minus `docker`. Two files actually fail that way, not the five
# once assumed (pipeline 163, 2026-09-04, was $NODE_IMAGE with no Docker CLI
# at all, a coarser signal): src/lib/install-script-adapters.test.ts, whose
# beforeAll runs a real `docker build --target vapid-generator .`, and
# src/lib/recovery-bundle.parity.test.ts, whose "no Docker daemon reachable"
# blocks are true to their name -- they never reach a live daemon -- but
# still spawn the real import-recovery-bundle.sh/backup.sh, and both scripts
# gate on `command -v docker`/`docker compose version` in their own preflight
# before the archive-validation logic these tests exercise. `fast_docker`,
# on the privileged `orbit-build` lane, runs both files.
#
# The exclusion itself is read straight from this variable by
# vitest.config.ts, not passed here as a CLI `--exclude`: that flag is
# silently ignored for a project declared through `test.projects` (verified
# directly against this repo's config), so passing it here would look correct
# and run both excluded files anyway. Unset locally, where a daemon is
# normally present and the full suite runs.
if command -v pnpm >/dev/null 2>&1; then
  pnpm typecheck
  pnpm lint
  node scripts/check-rolldown-jsdoc-trap.mjs
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
  node node_modules/eslint/bin/eslint.js . --concurrency auto
  node scripts/check-rolldown-jsdoc-trap.mjs
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
