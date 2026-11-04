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
# UPGRADE_CELL_LAUNCHER_SRC (required, no default): the launcher source checked
# out at the pin in launcher/pin.json (scripts/ci/checkout-launcher-source.sh).
# The job checks it out; this script does not fetch code. It must run as a
# non-root user.
set -Eeuo pipefail

# shellcheck source=scripts/ci/upgrade-cell.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/upgrade-cell.sh"

# Refusals before any work. The launcher refuses root (ai/orbit-launcher#331),
# so the job runs the whole script as a non-root user (#1665 wires that).
cell_preflight() {
  [[ $(id -u) -ne 0 ]] || fail update runs-as-non-root "the launcher cell must run as a non-root user, not root"
  local src="${UPGRADE_CELL_LAUNCHER_SRC:-}"
  [[ -n $src && -d $src/test/live ]] ||
    fail update launcher-source-present "no launcher source with test/live/ at UPGRADE_CELL_LAUNCHER_SRC (${src:-unset})"
  [[ -n ${IMAGE_NAME:-} ]] || fail update launcher-inputs-present "IMAGE_NAME is not set"
  [[ -n ${ORBIT_LAUNCHER_LIVE_BINARY:-} && -r $ORBIT_LAUNCHER_LIVE_BINARY ]] ||
    fail update launcher-inputs-present "ORBIT_LAUNCHER_LIVE_BINARY is unset or unreadable"
  cell_preflight_manifest
}

# The manifest is checked after cell_registry, which replaces it with the one it writes.
cell_preflight_manifest() {
  [[ -n ${ORBIT_RELEASE_MANIFEST:-} && -r $ORBIT_RELEASE_MANIFEST ]] ||
    fail update launcher-inputs-present "ORBIT_RELEASE_MANIFEST is unset or unreadable"
}

# Step 7. Runs as the current user, the one the old installer ran under. go test
# runs code fetched from another repo, so the CI tokens are stripped from its
# environment, as launcher_install_compat does.
cell_update_launcher() {
  (
    cd "$UPGRADE_CELL_LAUNCHER_SRC" &&
      env -u CI_JOB_TOKEN -u CI_BUILD_TOKEN -u CI_REGISTRY_PASSWORD -u CI_DEPENDENCY_PROXY_PASSWORD \
        -u CI_REPOSITORY_URL -u CI_DEPLOY_PASSWORD -u GITLAB_RELEASE_TOKEN -u GHCR_PUBLISH_TOKEN \
        -u BASE_REPIN_TOKEN -u DOOR_IMPORT_TOKEN -u RENOVATE_TOKEN -u GITHUB_COM_TOKEN \
        -u SIDECAR_ISSUE_TOKEN -u ORBIT_REGISTRY_TOKEN -u ORBIT_READ_TOKEN \
        ORBIT_LIVE_EXISTING_DIR="$TARGET" \
        ORBIT_RELEASE_MANIFEST="$ORBIT_RELEASE_MANIFEST" \
        ORBIT_LAUNCHER_LIVE_BINARY="$ORBIT_LAUNCHER_LIVE_BINARY" \
        ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH="$NEW_INSTALLER" \
        ORBIT_REGISTRY="$REGISTRY_ADDR" ORBIT_REPOSITORY="$IMAGE_NAME" \
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
  cell_preflight
  mkdir -p "$TARGET"
  cell_registry
  cell_preflight_manifest
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
