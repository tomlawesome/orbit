#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# The lockfile guard (#901): catches the pnpm 11 -> 12.3.4 handoff writing an
# @pnpm/exe block back into the lockfile. Runs via `node --test`, not Vitest --
# see vitest.config.ts's exclude entry for why.
#
# Fatal against the COMMITTED lockfile; advisory against the working tree
# (#1024). The block is written by any local `pnpm` command, including the ones
# further down this very script, so while this ran fatally against the working
# copy it mostly caught pollution the previous local run had caused:
# `set -Eeuo pipefail` then aborted before a single test ran, and the developer
# read a failure about a file they had never edited. Every agent and developer
# hit it, restored the lockfile and ran again, losing a run each time.
#
# What must never happen is the block being IN the repository, and that is a
# property of the commit, not of the working copy. So the fatal reading is of
# `HEAD:pnpm-lock.yaml`. In CI the checkout is the commit, so this is exactly
# the check that ran before, with the same outcome; locally it stays quiet
# about pollution the run itself is about to cause, and the advisory reading at
# the end of this script reports that instead.
#
# Deliberately not a test of an environment variable: `su node -c` decides
# whether CI= survives into the job's unprivileged half, and a guard that
# quietly stops being fatal because a variable was dropped is worse than no
# guard.
committed_lockfile="$(mktemp)"
trap 'rm -f "$committed_lockfile"' EXIT
if git show HEAD:pnpm-lock.yaml > "$committed_lockfile" 2>/dev/null; then
  ORBIT_LOCKFILE_PATH="$committed_lockfile" node --test scripts/lockfile-no-pnpm-exe.test.mjs
else
  # No git, or no lockfile in HEAD: fail closed by judging what is on disk.
  node --test scripts/lockfile-no-pnpm-exe.test.mjs
fi

# Same reason: uses node:test, not vitest globals (#921) -- see
# vitest.config.ts's exclude entry for this file too.
node --test scripts/compose-project-name-resolution.test.mjs

# Also node_modules-free, and it belongs before `pnpm typecheck` below: it
# guards the configuration that decides whether typecheck reads tmp/ at all
# (#995). If that guard has been lost, the next step is what fails, naming a
# scratch prototype instead of the real cause.
node --test scripts/scratch-dir-ignored.test.mjs

# Same reason again (#1020), and it was the only one of the four that no
# runner ever picked up: vitest.config.ts excludes it and nothing invoked it,
# so the regression test #1020 wrote to prove the commit-and-push half works,
# and #1081's proof that the runner's inherited auth header is cleared before
# the push, both ran nowhere. A test that has never run proves nothing.
node --test scripts/ci/repin-base-image.test.mjs

# Same reason (ADR-0031 #2): uses node:test -- see vitest.config.ts's exclude
# entry for this file too.
node --test scripts/bump-launcher-pin.test.mjs

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
  # Only when there is not already a build of these exact sources (#1061). The
  # web app used to be built three times in one pipeline; it is now built once
  # and shared. Locally this is still a plain rebuild, because a clean checkout
  # has no build to stand on and any edit moves the stamp.
  #
  # `svelte-kit sync` in the other branch because check-v19-types.mjs below
  # runs svelte-check, and web/tsconfig.json extends ./.svelte-kit/tsconfig.json
  # -- a generated, gitignored file the build happens to produce. Skipping the
  # build without it leaves svelte-check with no tsconfig to read.
  if node scripts/web-build-stamp.mjs check; then
    pnpm --filter orbit-web exec svelte-kit sync
  else
    pnpm --filter orbit-web build
  fi
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
  # static/licenses, which the SvelteKit build then bundles, and the stamp
  # records what it was built from (#1061).
  if ! node scripts/web-build-stamp.mjs check; then
    (cd web && node scripts/collect-font-licences.mjs \
      && node ../node_modules/vite/bin/vite.js build \
      && node ../scripts/web-build-stamp.mjs write)
  fi
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

# The local half of the lockfile guard above (#1024). Advisory by design: this
# names a self-inflicted, already-understood pollution and tells the developer
# how to undo it. It never restores the file itself -- a lockfile edit can be
# real work, and discarding one to save a message would be the worse fault --
# and it never changes this script's exit code, because the tests above are
# what the run was for.
if ! node --test scripts/lockfile-no-pnpm-exe.test.mjs >/dev/null 2>&1; then
  printf '\n' >&2
  printf 'NOTE: pnpm-lock.yaml now carries a bare @pnpm/exe block.\n' >&2
  printf '      A local pnpm command writes it while handing over to the pinned 12.3.4;\n' >&2
  printf '      it is not your change, and CI rejects it. Restore before committing:\n' >&2
  printf '\n' >&2
  printf '        git checkout -- pnpm-lock.yaml\n' >&2
  printf '\n' >&2
  printf '      If you did mean to change the lockfile, remove just that block instead.\n' >&2
fi
