#!/usr/bin/env bash
set -euo pipefail
#
# Updates the Orbit deployment this file sits in (#1770). The installer
# writes it to the top of the Orbit directory, and every update replaces it
# with that release's copy. Run it from anywhere:
#   ./update.sh
#   ORBIT_VERSION=vX.Y.Z ./update.sh
#
# It fetches the current get-orbit.sh, the same file the documented install
# command pipes into bash, and runs it from this directory. It adds no checks
# of its own: get-orbit.sh verifies the signed release manifest, the launcher
# and install.sh before anything runs. ORBIT_VERSION, when set, reaches
# get-orbit.sh through the environment. Its exit code is this script's.
#
# First it compares itself with the latest published update.sh and says so
# in one line when they differ; the update it then runs replaces this copy.
# That check is best effort: when it cannot fetch, it stays quiet.

readonly get_orbit_url="https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh"
readonly published_update_url="https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/update.sh"

self="$(readlink -f -- "${BASH_SOURCE[0]}")"
orbit_dir="$(dirname -- "$self")"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-update.XXXXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT

if curl -fsSL -o "$work_dir/update.sh" "$published_update_url" 2>/dev/null &&
  ! cmp -s -- "$work_dir/update.sh" "$self"; then
  printf 'Orbit update: a newer update.sh is published; the update below replaces this one.\n' >&2
fi

# Fetched whole to a file and only run once curl reports success, so a
# partial download is never run.
if ! curl -fsSL -o "$work_dir/get-orbit.sh" "$get_orbit_url"; then
  printf 'Orbit update: could not download get-orbit.sh from %s.\n' "$get_orbit_url" >&2
  exit 1
fi

cd -- "$orbit_dir"
status=0
bash "$work_dir/get-orbit.sh" || status=$?
exit "$status"
