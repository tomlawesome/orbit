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

# #1151 D1-S3: snapshot-and-restore alone is not safe against two concurrent
# runs sharing this workspace -- the second run's own snapshot can be taken
# mid-deploy (already-corrupted) content, and whichever restore runs last
# wins regardless of which deploy it actually belongs to, leaving
# node_modules broken until a manual `pnpm install`. A plain `mkdir` is
# atomic on every POSIX filesystem, so it needs no extra tool (unlike
# flock, not installed in this script's own build-stage base image, and
# unverifiable here without a Docker build this fix cannot run) to
# serialize concurrent runs against the same checkout. The held PID lets a
# run reclaim a lock abandoned by a process that no longer exists, rather
# than hanging forever on a kill -9's leftover lock directory.
lock_dir="$repo_dir/.web-deploy.lock"
lock_pid_file="$lock_dir/pid"

acquire_lock() {
  waited=0
  no_pid_waited=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    held_pid=""
    [ -f "$lock_pid_file" ] && held_pid="$(cat -- "$lock_pid_file" 2>/dev/null || true)"
    if [ -n "$held_pid" ]; then
      no_pid_waited=0
      if ! kill -0 "$held_pid" 2>/dev/null; then
        rm -rf -- "$lock_dir" 2>/dev/null || true
        continue
      fi
    else
      # #1151 RANGE-F4: the lock dir exists but carries no pid file yet.
      # That is normally just the instant between this run's own mkdir and
      # its pid write below -- but if a run was killed (SIGKILL) in that
      # same window, no process will ever write one, and nothing but a
      # bound on this wait would notice. A legitimate holder writes its pid
      # within the same second it creates the directory, so a few seconds
      # with no pid file means the mkdir's owner is gone.
      no_pid_waited=$((no_pid_waited + 1))
      if [ "$no_pid_waited" -ge 5 ]; then
        rm -rf -- "$lock_dir" 2>/dev/null || true
        no_pid_waited=0
        continue
      fi
    fi
    if [ "$waited" -eq 0 ]; then
      printf 'Orbit web deploy: another web-deploy is already running; waiting for it to finish...\n' >&2
    fi
    waited=$((waited + 1))
    sleep 1
  done
  # Written to a temp name inside the lock dir we just created, then renamed
  # into place, rather than written straight to lock_pid_file -- `mv` within
  # the same directory is atomic, so a reader never sees a partially written
  # pid, and the window in which the dir exists with no pid file at all is
  # just this one rename rather than everything restore_workspace_state and
  # the deploy itself do afterwards.
  tmp_pid_file="$lock_dir/pid.$$"
  printf '%s\n' "$$" > "$tmp_pid_file"
  mv -- "$tmp_pid_file" "$lock_pid_file"
}

release_lock() {
  rm -rf -- "$lock_dir" 2>/dev/null || true
}

workspace_state="node_modules/.pnpm-workspace-state-v1.json"
saved_state=""

restore_workspace_state() {
  [ -n "$saved_state" ] || return 0
  cp -- "$saved_state" "$workspace_state"
  rm -f -- "$saved_state"
}

cleanup() {
  restore_workspace_state
  release_lock
}
trap cleanup EXIT

acquire_lock

if [ -f "$workspace_state" ]; then
  saved_state="$(mktemp)"
  cp -- "$workspace_state" "$saved_state"
fi

pnpm --filter orbit-web --prod deploy --legacy "$target"
