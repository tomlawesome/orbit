#!/usr/bin/env bash
#
# Installs the pinned knip from tools/knip and the app's own dependencies, and
# prints the directory holding the installed tool (#1596; owner decision 106a,
# 2026-11-25). Used by scripts/ci/scan-knip.sh, which runs knip only inside a
# network-less, read-only container: nothing here runs knip or any package code.
#
# knip finds unused files, exports and dependencies. ISC,
# https://github.com/webpro-nl/knip. It lives in tools/knip with its own
# package.json (an exact version) and package-lock.json (an integrity hash per
# package), outside Orbit's package.json and pnpm workspace, so it never enters
# the app build. Renovate ignores tools/knip: upgrades are by hand, to a
# version at least 3 days old, with its diff read first. To bump: edit the pin
# in tools/knip/package.json, then from tools/knip run
#   npm install --package-lock-only --ignore-scripts --before=<now minus 3 days>
# so no package in the tree is younger than that.
#
# Both installs use --ignore-scripts, so no install script of any package runs
# here. `npm ci` checks every tarball against the lockfile's integrity hash and
# refuses a mismatch. The app's dependencies are installed because knip loads
# the app's config files (vite, svelte, vitest, eslint); a checkout that
# already has node_modules keeps it (a local worktree must never be installed
# into from here, see pnpm-workspace.yaml), and CI starts without one.
#
# Output: the tools directory on stdout; progress on stderr.
set -Eeuo pipefail

repo_root="$(CDPATH="" cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tool_dir="${repo_root}/tools/knip"

fail() { printf 'ensure-knip: %s\n' "$1" >&2; exit 1; }

[[ -f "${tool_dir}/package.json" && -f "${tool_dir}/package-lock.json" ]] ||
  fail "tools/knip/package.json or its package-lock.json is missing"

printf 'ensure-knip: installing knip from tools/knip/package-lock.json (--ignore-scripts)\n' >&2
(cd "$tool_dir" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) >&2 ||
  fail "installing tools/knip failed (a lockfile integrity mismatch is refused here)"

# Reads both manifests as JSON; no package code is loaded.
node -e '
const fs = require("fs");
const want = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies.knip;
const got = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).version;
if (want !== got) { console.error("ensure-knip: installed knip " + got + " is not the pinned " + want); process.exit(1); }
' "${tool_dir}/package.json" "${tool_dir}/node_modules/knip/package.json" ||
  fail "the installed knip does not match the pin"

if [[ -d "${repo_root}/node_modules" ]]; then
  printf 'ensure-knip: node_modules already present; not installing the app dependencies\n' >&2
else
  printf 'ensure-knip: installing the app dependencies (--frozen-lockfile --ignore-scripts)\n' >&2
  (cd "$repo_root" && pnpm install --frozen-lockfile --ignore-scripts) >&2 ||
    fail "installing the app dependencies failed"
fi

printf '%s\n' "$tool_dir"
