#!/usr/bin/env bash
# orbit-update-sh
set -euo pipefail
#
# Updates the Orbit deployment this file sits in (#1770). The installer
# writes it to the top of the Orbit directory, and every update replaces it
# with that release's copy. Run it from anywhere:
#   ./update.sh
#   ORBIT_VERSION=vX.Y.Z ./update.sh
#
# Step 1, self-update. It downloads the newest update.sh from one fixed
# address that never moves (docs/installer-guarantees.md). A failed download
# stops here, so a possibly stale installer address is never run. When the
# download differs from this file, it must be a bash script carrying the
# marker line above; it then replaces this file (temporary file in the same
# directory, then rename) and the new copy runs with the same arguments.
# ORBIT_UPDATE_SELF_REPLACED=1, set for that re-run, skips step 1, so it
# never replaces itself twice in one run.
#
# Step 2, the installer. Its address lives only here, so moving the installer
# means changing this file at the fixed address and nothing else. It fetches
# get-orbit.sh and runs it from this directory. It adds no checks of its own:
# get-orbit.sh verifies the signed release manifest, the launcher and
# install.sh before anything runs. ORBIT_VERSION, when set, reaches it
# through the environment. Its exit code is this script's.

readonly self_update_url="https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/update.sh"
readonly get_orbit_url="https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh"
readonly marker="# orbit-update-sh"

self="$(readlink -f -- "${BASH_SOURCE[0]}")"
orbit_dir="$(dirname -- "$self")"

work_dir=""
replacement=""
cleanup() {
  if [[ -n "$replacement" ]]; then rm -f -- "$replacement"; fi
  if [[ -n "$work_dir" ]]; then rm -rf -- "$work_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-update.XXXXXXXX")"

fail() {
  printf 'Orbit update: %s\n' "$1" >&2
  exit 1
}

if [[ "${ORBIT_UPDATE_SELF_REPLACED:-}" != 1 ]]; then
  downloaded="$work_dir/update.sh"
  if ! curl -fsSL -o "$downloaded" "$self_update_url"; then
    fail "could not download the newest update.sh from $self_update_url; nothing was run. Check the network and try again."
  fi
  if ! cmp -s -- "$downloaded" "$self"; then
    first_line=""
    IFS= read -r first_line < "$downloaded" || true
    if [[ ! -s "$downloaded" ]] ||
      [[ ! "$first_line" =~ ^#!.*bash ]] ||
      ! grep -qxF -- "$marker" "$downloaded"; then
      fail "the update.sh downloaded from $self_update_url is not a valid update.sh; nothing was replaced or run."
    fi
    replacement="$(mktemp "$orbit_dir/.update.sh.XXXXXXXX")"
    cat -- "$downloaded" > "$replacement"
    chmod 0755 -- "$replacement"
    mv -f -- "$replacement" "$self"
    replacement=""
    printf 'Orbit update: update.sh updated itself; running the new copy.\n' >&2
    # exec replaces this process, so the EXIT trap would not run: clean up first.
    trap - EXIT INT TERM
    cleanup
    ORBIT_UPDATE_SELF_REPLACED=1 exec bash "$self" "$@"
  fi
fi

# Fetched whole to a file and only run once curl reports success, so a
# partial download is never run.
if ! curl -fsSL -o "$work_dir/get-orbit.sh" "$get_orbit_url"; then
  fail "could not download get-orbit.sh from $get_orbit_url."
fi

cd -- "$orbit_dir"
status=0
bash "$work_dir/get-orbit.sh" || status=$?
exit "$status"
