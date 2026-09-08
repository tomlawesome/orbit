#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

command -v node >/dev/null 2>&1 || {
  printf 'Orbit browser setup: Node.js is required.\n' >&2
  exit 1
}
[[ -f node_modules/@playwright/test/cli.js ]] || {
  printf 'Orbit browser setup: node_modules/@playwright/test/cli.js is missing -- install dependencies first (from the main checkout; see AGENTS.md worktree-install trap, #784).\n' >&2
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
