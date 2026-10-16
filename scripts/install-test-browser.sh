#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

command -v node >/dev/null 2>&1 || {
  printf 'Orbit browser setup: Node.js is required.\n' >&2
  exit 1
}
[[ -f node_modules/@playwright/test/cli.js ]] || {
  printf 'Orbit browser setup: node_modules/@playwright/test/cli.js is missing -- install dependencies first (from the main checkout; see docs/testing.md "Local traps", worktree install, #784).\n' >&2
  exit 1
}

# node_modules/@playwright/test/cli.js directly, not `pnpm exec playwright`:
# pnpm exec verifies node_modules against the lockfile before running, and in
# a worktree whose node_modules is symlinked to the main checkout's that
# verification can try to repair a directory it does not own, aborting with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY outside a TTY (#858). The direct
# path is the same binary pnpm's own wrapper would have run.
#
# This is a one-time local download. The headless shell is sufficient for the
# scripted suite and is materially smaller than a full browser installation.
node node_modules/@playwright/test/cli.js install --only-shell chromium
# #1183: desktop-firefox and maintenance-firefox (tests/e2e/playwright.config.ts)
# need Playwright's own Firefox build. Firefox has no headless-shell variant.
# A download only, like the line above: no --with-deps, which needs root.
node node_modules/@playwright/test/cli.js install firefox
# #1192: desktop-webkit and mobile-webkit (tests/e2e/playwright.config.ts) need
# Playwright's own WebKit build the same way; WebKit has no headless-shell
# variant either.
# #1235: scripts/test-e2e-local.sh runs WebKit inside CI's Playwright image,
# whose WebKit is already there, and sets this so the host download -- which
# on a host without WebKit's system libraries only prints a warning -- is
# skipped. Default on: anything else calling this script still gets WebKit.
if [[ "${ORBIT_E2E_SKIP_WEBKIT_DOWNLOAD:-0}" == 1 ]]; then
  echo "install-test-browser: skipping WebKit; the run uses CI's Playwright image (#1235)"
else
  node node_modules/@playwright/test/cli.js install webkit
fi
