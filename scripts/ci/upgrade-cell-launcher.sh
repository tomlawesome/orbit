#!/usr/bin/env bash
#
# Upgrade matrix (#1666, part of #1647): the launcher update cell, latest-1 x
# plain, updated through the launcher instead of install.sh. Steps 0-6 and the
# step 8 checks are upgrade-cell.sh's (#1664), sourced as a library. Step 7 runs
# the launcher's TestLive_UpdateExistingDeployment, which runs the candidate
# installer itself; this cell does not. Verdict line as upgrade-cell.sh, with
# shape=launcher.
#
# Environment, besides upgrade-cell.sh's: ORBIT_UPGRADE_LAUNCHER (false skips),
# ORBIT_LAUNCHER_LIVE_BINARY (build_launcher's binary), and
# UPGRADE_CELL_LAUNCHER_SRC: the launcher source checked out at the pin in
# launcher/pin.json (scripts/ci/checkout-launcher-source.sh), default
# .orbit-launcher-src under the working directory. The job checks it out; this
# script does not fetch code.
set -Eeuo pipefail

# shellcheck source=scripts/ci/upgrade-cell.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/upgrade-cell.sh"

# Step 7. Runs as the current user, the one the old installer ran under; the
# launcher refuses root. go test runs code fetched from another repo, so the CI
# tokens are stripped from its environment, as launcher_install_compat does.
cell_update_launcher() {
  [[ $(id -u) -ne 0 ]] || fail update launcher-update-passed "the launcher test must not run as root"
  local src="${UPGRADE_CELL_LAUNCHER_SRC:-$WORK/.orbit-launcher-src}"
  [[ -d $src ]] || src="$WORK"
  (
    cd "$src" &&
      env -u CI_JOB_TOKEN -u CI_BUILD_TOKEN -u CI_REGISTRY_PASSWORD -u CI_DEPENDENCY_PROXY_PASSWORD \
        -u CI_REPOSITORY_URL -u CI_DEPLOY_PASSWORD -u GITLAB_RELEASE_TOKEN -u GHCR_PUBLISH_TOKEN \
        -u BASE_REPIN_TOKEN -u DOOR_IMPORT_TOKEN -u RENOVATE_TOKEN -u GITHUB_COM_TOKEN \
        -u SIDECAR_ISSUE_TOKEN -u ORBIT_REGISTRY_TOKEN -u ORBIT_READ_TOKEN \
        ORBIT_LIVE_EXISTING_DIR="$TARGET" \
        ORBIT_RELEASE_MANIFEST="${ORBIT_RELEASE_MANIFEST:?}" \
        ORBIT_LAUNCHER_LIVE_BINARY="${ORBIT_LAUNCHER_LIVE_BINARY:?}" \
        ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH="$NEW_INSTALLER" \
        ORBIT_REGISTRY="$REGISTRY_ADDR" ORBIT_REPOSITORY="${IMAGE_NAME:?}" \
        go test -tags live -count=1 -v -timeout 15m -run '^TestLive_UpdateExistingDeployment$' ./test/live/
  ) >"$OUT" 2>&1 || {
    local detail
    detail="$(grep -m1 -- '^--- FAIL' "$OUT" || grep -v '^[[:space:]]*$' "$OUT" | tail -n 1 || true)"
    fail update launcher-update-passed "$detail"
  }
}

main_launcher() {
  SLOT=latest-1 SHAPE=launcher SHAPE_SCRIPT=plain
  cell_init
  trap cell_finish EXIT
  [[ ${ORBIT_UPGRADE_LAUNCHER:-true} != false ]] || skip "the launcher cell is off (ORBIT_UPGRADE_LAUNCHER=false)"
  cell_skip_checks
  mkdir -p "$TARGET"
  cell_registry
  cell_old_tree
  cell_shape provision
  cell_old_install
  cell_seed
  cell_shape after_install
  cell_update_launcher
  cell_assert
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main_launcher "$@"
fi
