#!/usr/bin/env bash
#
# Upgrade matrix (#1664, part of #1647): one cell, one old version x one shape.
#
# Installs the old release, seeds it, updates it with the candidate's own
# installer and checks the result. Prints exactly one verdict line, last, and
# writes it to upgrade-cells/<slot>-<shape>.{line,xml} (JUnit) under the
# working directory:
#   upgrade-cell PASS version=<v> shape=<s> seconds=<n>
#   upgrade-cell FAIL version=<v> shape=<s> step=<step> assertion=<id> detail="<one line>"
#   upgrade-cell SKIP version=<v|-> shape=<s> reason="<why>"
# Exit 0 for PASS and SKIP, 1 for FAIL.
#
# Every step's output goes to a private temp file, never the job log: the
# installer and seed output can carry a claim code. Only a sanitised last line
# reaches the verdict.
#
# Environment: SLOT, SHAPE, ORBIT_UPGRADE_MATRIX, ORBIT_UPGRADE_SINCE,
# ORBIT_UPGRADE_SLOT_<NAME>, IMAGE_NAME (the candidate repository),
# ORBIT_RELEASE_MANIFEST (candidate manifest; step 1 replaces it with the one it
# writes), and for step 1 what `acceptance` uses: ORBIT_IMAGE_TAG,
# ORBIT_IMAGE_ID, ORBIT_RUN_ID, ORBIT_RUN_ATTEMPT.
# SHAPE_SCRIPT names the shape script when it differs from SHAPE (the verdict
# label); #1666 sets it. Test hooks: UPGRADE_CELL_{OLD_INSTALLER,NEW_INSTALLER,SEED,SHAPES_DIR,
# OLD_TREE,TARGET} and UPGRADE_CELL_SKIP_REGISTRY=1 (skips step 1).
#
# Run as a script it does everything. Sourced (#1666's launcher cell), it
# defines cell_init and the step functions cell_skip_checks, cell_registry,
# cell_old_tree, cell_shape, cell_old_install, cell_seed and cell_assert;
# the caller installs its own cell_finish trap.
set -Eeuo pipefail

REGISTRY_ADDR=127.0.0.1:5000

# one_line: stdin to a single sanitised line of at most 200 characters. Claim
# codes and anything token-shaped (16+ characters with a digit) are redacted,
# quotes and backslashes are replaced so the line sits inside detail="...".
# shellcheck disable=SC1003 # the backslash is a literal character to translate
one_line() {
  tr '\r\n\t' '   ' |
    sed -E 's/(claim code|#claim=)[: =]*[^ ]+/\1 [redacted]/Ig' |
    awk '{ for (i = 1; i <= NF; i++) if (length($i) >= 16 && $i ~ /[0-9]/) $i = "[redacted]"; print }' |
    tr '"\\' "'/" | cut -c1-200
}

xml_attr() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

cell_init() {
  : "${SLOT:?SLOT is required}" "${SHAPE:?SHAPE is required}"
  REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  WORK="$PWD"
  SHAPES_DIR="${UPGRADE_CELL_SHAPES_DIR:-$REPO_ROOT/scripts/ci/upgrade-shapes}"
  SEED="${UPGRADE_CELL_SEED:-$REPO_ROOT/scripts/ci/upgrade-seed.sh}"
  NEW_INSTALLER="${UPGRADE_CELL_NEW_INSTALLER:-$REPO_ROOT/scripts/install.sh}"
  OLD_TREE="${UPGRADE_CELL_OLD_TREE:-$WORK/old}"
  OLD_INSTALLER="${UPGRADE_CELL_OLD_INSTALLER:-$OLD_TREE/scripts/install.sh}"
  TARGET="${UPGRADE_CELL_TARGET:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-upgrade-target.XXXXXX")}"
  LOGDIR="$(mktemp -d)"
  OUT="$LOGDIR/step.out"
  slot_var="ORBIT_UPGRADE_SLOT_$(printf '%s' "$SLOT" | tr 'a-z-' 'A-Z_')"
  VERSION="${!slot_var:-}"
  V_KIND='' V_LINE='' REGISTRY_NAME='' REGISTRY_ID=''
  # Port from the provisioned .env-orbit when there is one; the example's default otherwise.
  BASE_URL="http://127.0.0.1:3000"
  SECONDS=0
}

# verdict_* record the outcome; cell_finish prints it after clean-up.
skip() {
  V_KIND=SKIP
  V_LINE="upgrade-cell SKIP version=${VERSION:--} shape=$SHAPE reason=\"$1\""
  exit 0
}

# fail STEP ID DETAIL: DETAIL is sanitised here.
fail() {
  V_KIND=FAIL
  V_LINE="upgrade-cell FAIL version=${VERSION:--} shape=$SHAPE step=$1 assertion=$2 detail=\"$(printf '%s' "$3" | one_line)\""
  exit 1
}

# fail_from_out STEP DEFAULT_ID: the id the script printed, else DEFAULT_ID; the
# detail it printed, else its last non-blank line.
fail_from_out() {
  local id detail
  id="$(grep -oE 'assertion=[A-Za-z0-9_-]+' "$OUT" | tail -n 1 | cut -d= -f2 || true)"
  detail="$(sed -nE 's/.*detail="([^"]*)".*/\1/p' "$OUT" | tail -n 1)"
  [[ -n $detail ]] || detail="$(grep -v '^[[:space:]]*$' "$OUT" | tail -n 1 || true)"
  fail "$1" "${id:-$2}" "$detail"
}

# in_target CMD...: run in the install directory, output to $OUT.
in_target() { (cd "$TARGET" && "$@") >"$OUT" 2>&1; }

# Step 0.
cell_skip_checks() {
  # orbit_lane_admits is a CI shell function; it is only there when exported or sourced.
  if [[ ${ORBIT_UPGRADE_MATRIX:-true} == false ]] ||
    { declare -F orbit_lane_admits >/dev/null && ! orbit_lane_admits upgrade_cell >/dev/null; }; then
    skip "nothing install-relevant changed since ${ORBIT_UPGRADE_SINCE:-?} (#1647)"
  fi
  [[ -n $VERSION ]] || skip "slot $SLOT is empty"
}

# Step 1: the same scripts `acceptance` runs, then the candidate manifest they write.
cell_registry() {
  [[ ${UPGRADE_CELL_SKIP_REGISTRY:-0} != 1 ]] || return 0
  local outputs="$LOGDIR/registry.outputs"
  : >"$outputs"
  { docker load --input image.tar &&
    # The candidate updates this cell's own old release, so the manifest must
    # list it in updateFrom or install.sh refuses the path (#1665).
    TESTED_IMAGE_TAG="${ORBIT_IMAGE_TAG:?}" TESTED_IMAGE_ID="${ORBIT_IMAGE_ID:?}" GITHUB_OUTPUT="$outputs" \
      ORBIT_TEST_MANIFEST_UPDATE_FROM="$VERSION" \
      bash "$REPO_ROOT/scripts/ci/start-installer-registry.sh"; } >"$OUT" 2>&1 ||
    { REGISTRY_NAME="$(sed -n 's/^registry_name=//p' "$outputs")" REGISTRY_ID="$(sed -n 's/^registry_id=//p' "$outputs")"
      fail install candidate-registry "$(grep -v '^[[:space:]]*$' "$OUT" | tail -n 1 || true)"; }
  REGISTRY_NAME="$(sed -n 's/^registry_name=//p' "$outputs")"
  REGISTRY_ID="$(sed -n 's/^registry_id=//p' "$outputs")"
  ORBIT_RELEASE_MANIFEST="$(sed -n 's/^release_manifest=//p' "$outputs")"
  export ORBIT_RELEASE_MANIFEST
}

# Step 2.
cell_old_tree() {
  [[ -z ${UPGRADE_CELL_OLD_TREE:-} ]] || return 0
  { git fetch --depth=1 origin tag "$VERSION" &&
    mkdir -p "$OLD_TREE" &&
    git archive "$VERSION" scripts .env-orbit.example | tar -xf - -C "$OLD_TREE"; } >"$OUT" 2>&1 ||
    fail install old-tree-fetched "$(grep -v '^[[:space:]]*$' "$OUT" | tail -n 1 || true)"
}

# cell_shape VERB: provision (step 3) and after_install (step 6); assert is cell_assert's.
cell_shape() {
  "$SHAPES_DIR/${SHAPE_SCRIPT:-$SHAPE}.sh" "$1" "$TARGET" "$OLD_TREE" >"$OUT" 2>&1 || fail_from_out shape shape-exited-0
  if [[ -f $TARGET/.env-orbit ]]; then
    local port
    port="$(sed -n 's/^ORBIT_PORT=//p' "$TARGET/.env-orbit" | tail -n 1 | tr -d "\"'\r")"
    BASE_URL="http://127.0.0.1:${port:-3000}"
  fi
}

# Step 4.
cell_old_install() {
  in_target env ORBIT_CHANNEL="$VERSION" bash "$OLD_INSTALLER" --plain --install || fail_from_out install install-exited-0
}

# Step 5.
cell_seed() {
  "$SEED" seed "$TARGET" "$BASE_URL" >"$OUT" 2>&1 || fail_from_out seed seed-exited-0
}

# Step 7: ORBIT_CHANNEL=preview because any other channel counts as stable, and
# with cosign on PATH install.sh then refuses the candidate's missing
# countersignature (spike, #1647). install.sh builds the image name from
# ORBIT_REGISTRY/ORBIT_REPOSITORY and ignores the manifest's repository.
cell_update() {
  in_target env ORBIT_REGISTRY="$REGISTRY_ADDR" ORBIT_REPOSITORY="${IMAGE_NAME:?}" ORBIT_CHANNEL=preview \
    ORBIT_RELEASE_MANIFEST="${ORBIT_RELEASE_MANIFEST:?}" bash "$NEW_INSTALLER" --plain --update ||
    fail_from_out update update-exited-0
  grep -q 'preflight passed' "$OUT" || fail update preflight-accepted "the update did not print its preflight-passed line"
}

# Step 8, in order, stopping at the first failure.
cell_assert() {
  local digest want running env_image
  # The image digest by name: the manifest also holds file checksums.
  digest="$(jq -r '.image.digest // .digest // empty' "${ORBIT_RELEASE_MANIFEST:?}" 2>/dev/null || true)"
  [[ -n $digest ]] || fail assert image-is-candidate "no digest in the candidate manifest"
  want="$REGISTRY_ADDR/$IMAGE_NAME@$digest"
  running="$(docker inspect orbit --format '{{.Config.Image}}' 2>/dev/null || true)"
  env_image="$(sed -n 's/^ORBIT_IMAGE=//p' "$TARGET/.env-orbit" | tail -n 1)"
  [[ $running == "$want" ]] || fail assert image-is-candidate "the running container image is not the candidate's"
  [[ $env_image == "$want" ]] || fail assert image-is-candidate "ORBIT_IMAGE differs from the candidate"
  "$SHAPES_DIR/${SHAPE_SCRIPT:-$SHAPE}.sh" assert "$TARGET" "$OLD_TREE" >"$OUT" 2>&1 || fail_from_out assert assert-exited-0
  "$SEED" readback "$TARGET" "$BASE_URL" >"$OUT" 2>&1 || fail_from_out assert readback-exited-0
}

# Clean-up, whatever the outcome; its own failures never change the verdict.
cell_cleanup() {
  (cd "$TARGET" && docker compose --env-file .env-orbit down -v --remove-orphans) >/dev/null 2>&1 || true
  REGISTRY_NAME="$REGISTRY_NAME" REGISTRY_ID="$REGISTRY_ID" bash "$REPO_ROOT/scripts/ci/clean-up-installer.sh" >/dev/null 2>&1 || true
  rm -rf -- "$LOGDIR"
}

# Verdict last, after clean-up: print it, write the .line and JUnit artefacts.
cell_finish() {
  local rc=$?
  set +e
  trap - EXIT
  cell_cleanup
  if [[ -z $V_KIND ]]; then
    if [[ $rc -eq 0 ]]; then
      V_KIND=PASS V_LINE="upgrade-cell PASS version=$VERSION shape=$SHAPE seconds=$SECONDS"
    else
      V_KIND=FAIL V_LINE="upgrade-cell FAIL version=${VERSION:--} shape=$SHAPE step=shape assertion=cell-error detail=\"the cell script stopped unexpectedly\""
      rc=1
    fi
  fi
  local dir="$WORK/upgrade-cells" base="$SLOT-$SHAPE" failure=''
  mkdir -p "$dir"
  printf '%s\n' "$V_LINE" >"$dir/$base.line"
  [[ $V_KIND != FAIL ]] || failure="<failure message=\"$(printf '%s' "$V_LINE" | xml_attr)\"/>"
  printf '<testsuite name="upgrade-cell" tests="1" failures="%s"><testcase name="%s/%s">%s</testcase></testsuite>\n' \
    "$([[ $V_KIND == FAIL ]] && echo 1 || echo 0)" "${VERSION:--}" "$SHAPE" "$failure" >"$dir/$base.xml"
  printf '%s\n' "$V_LINE"
  exit "$rc"
}

main() {
  cell_init
  trap cell_finish EXIT
  cell_skip_checks
  mkdir -p "$TARGET"
  cell_registry
  cell_old_tree
  cell_shape provision
  cell_old_install
  cell_seed
  cell_shape after_install
  cell_update
  cell_assert
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
