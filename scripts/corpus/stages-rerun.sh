#!/usr/bin/env bash
# Run one shell command inside a throwaway Node container on the
# document-processing network (#1374).
#
#   scripts/corpus/stages-rerun.sh [--dry-run] '<shell command>'
#
# Eval runs that ask the model (`eval:stages`, `eval:holdout`,
# `eval:extraction`) must run here, not on the host: from the host
# `orbit-ollama` does not resolve, every answer comes back blank and the run
# scores 0% in seconds.
#
# The checkout this script lives in is mounted at /app, so it works from a
# worktree and from any current directory. ORBIT_STAGES_NETWORK and
# ORBIT_STAGES_IMAGE override the network and image. --dry-run prints the
# docker command and runs nothing.
set -euo pipefail

usage() {
  echo "usage: scripts/corpus/stages-rerun.sh [--dry-run] '<shell command>'" >&2
  exit 64
}

dry_run=0
if [ "${1-}" = "--dry-run" ]; then
  dry_run=1
  shift
fi
[ "$#" -eq 1 ] || usage
command=$1
[ -n "$command" ] || usage

network=${ORBIT_STAGES_NETWORK:-orbit_orbit-document-processing}
image=${ORBIT_STAGES_IMAGE:-node:22}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)

if [ "$dry_run" -eq 1 ]; then
  echo "docker run --rm --network $network -v $repo_root:/app -w /app --entrypoint sh $image -c $command"
  exit 0
fi

if ! docker network inspect "$network" >/dev/null 2>&1; then
  echo "stages-rerun: docker network '$network' is missing; bring the document-processing stack up first." >&2
  exit 2
fi

exec docker run --rm --network "$network" -v "$repo_root:/app" -w /app \
  --entrypoint sh "$image" -c "$command"
