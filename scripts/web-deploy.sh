#!/bin/sh
# Produces the pruned production node_modules the container image ships:
# `orbit-web`'s dependencies and nothing else, in a directory of your choosing.
#
# The image's web-deps stage runs this, and so should anyone reproducing the
# image's packaging locally — because running `pnpm deploy` by hand leaves the
# checkout broken, and this is where that is fixed rather than remembered.
#
# What goes wrong: `pnpm deploy` installs into the TARGET directory, but it
# rewrites `node_modules/.pnpm-workspace-state-v1.json` in the WORKSPACE while
# it does so, recording that the last install here was `--prod --filter`. That
# is untrue — this node_modules was not touched — but every later pnpm command
# believes it, concludes node_modules must be rebuilt as a production install,
# and refuses to do that without a TTY. The failure surfaces much later on an
# unrelated command as ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, which points
# at nothing. So the file is put back exactly as it was, including when the
# deploy fails or is interrupted.
#
# `--legacy` is not optional on pnpm 11: without it `deploy` refuses with
# ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE.
#
# POSIX sh, not bash, for the same reason scripts/container-entrypoint.sh is:
# the runtime base image has no bash, and this runs inside a build stage of it.
set -eu

repo_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_dir"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf 'Orbit web deploy: usage: sh scripts/web-deploy.sh <target-directory>\n' >&2
  exit 1
fi
target="$1"

workspace_state="node_modules/.pnpm-workspace-state-v1.json"
saved_state=""
if [ -f "$workspace_state" ]; then
  saved_state="$(mktemp)"
  cp -- "$workspace_state" "$saved_state"
fi

restore_workspace_state() {
  [ -n "$saved_state" ] || return 0
  cp -- "$saved_state" "$workspace_state"
  rm -f -- "$saved_state"
}
trap restore_workspace_state EXIT

pnpm --filter orbit-web --prod deploy --legacy "$target"
