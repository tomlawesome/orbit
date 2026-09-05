#!/usr/bin/env bash
#
# Proves an unattended installer run into an empty, unconfigured directory
# refuses: it names the exact fields that need attention, refuses to start
# Compose, starts no container, never shells out to git, and leaves the
# target as empty as it found it. A silent partial install here would be an
# operator's first experience of Orbit.
#
# Extracted verbatim from the "Verify empty target refuses unattended
# install" step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). It deliberately does not
# change directory: the caller runs it from the installer target, and the
# emptiness assertion at the end reads the working directory.
#
# Inputs (environment):
#   ORBIT_REGISTRY, ORBIT_REPOSITORY, ORBIT_CHANNEL  the disposable registry
#   GIT_GUARD_DIR      directory holding the guard `git`, prepended to PATH
#   GIT_MARKER         file the guard touches if it is ever invoked
#   ORBIT_RUN_ID, ORBIT_RUN_ATTEMPT  used to name the captured output
#   RUNNER_TEMP        optional; defaults to $TMPDIR or /tmp
#   ORBIT_ASSETS_FROM_TREE  optional; see scripts/ci/assets-from-tree.sh
#
# Outputs: refusal_output is appended to $GITHUB_OUTPUT when it is set.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root

: "${GIT_GUARD_DIR:?the git guard directory is required}"
: "${GIT_MARKER:?the git guard marker path is required}"
: "${ORBIT_RUN_ID:?the run identifier is required}"
: "${ORBIT_RUN_ATTEMPT:?the run attempt is required}"

workspace="${GITHUB_WORKSPACE:-${repo_root}}"
runner_temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
readonly workspace runner_temp

refusal_output="${runner_temp}/orbit-installer-refusal-${ORBIT_RUN_ID}-${ORBIT_RUN_ATTEMPT}.log"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'refusal_output=%s\n' "${refusal_output}" >> "${GITHUB_OUTPUT}"
fi
# shellcheck source=scripts/ci/assets-from-tree.sh
source "${repo_root}/scripts/ci/assets-from-tree.sh"
PATH="$(assets_from_tree_path)${PATH}"

set +e
exec < /dev/null
[[ ! -t 0 ]] || {
  printf 'The refusal check must not have a TTY on standard input.\n' >&2
  exit 1
}
PATH="${GIT_GUARD_DIR}:${PATH}" bash "${workspace}/scripts/install.sh" > "${refusal_output}" 2>&1
installer_status=$?
set -e
# Every check below names what it expected; the file holds what it got, the
# exit code says how far the installer ran, and the directory listing says
# what it left behind. Show all three whenever the script fails, or a
# failure on another runner is a guess (#770).
show_output_on_failure() {
  [[ "$1" -eq 0 ]] || {
    printf -- '--- installer exit status: %s ---\n' "${installer_status}" >&2
    printf -- '--- installer output (%s) ---\n' "${refusal_output}" >&2
    cat "${refusal_output}" >&2
    printf -- '--- target directory contents (%s) ---\n' "$(pwd -P)" >&2
    ls -la >&2
  }
}
trap 'show_output_on_failure $?' EXIT
[[ "${installer_status}" -ne 0 ]] || {
  printf 'An empty non-interactive target unexpectedly accepted installation.\n' >&2
  exit 1
}
# The field-check line and the Compose-refusal line below are printed
# together by the same prepare_configuration() call in install.sh, but a
# failure that never reaches that call (a registry hiccup during the
# earlier image pull, for instance) and a failure that reaches it with a
# wrong field list used to report as the same "did not report the fixed
# required fields" line, with nothing to tell them apart. Check the line's
# fixed prefix on its own first, and show whatever it actually said when it
# is present but wrong (#770).
required_fields_prefix='Orbit installer: configuration fields requiring attention:'
required_fields_line='Orbit installer: configuration fields requiring attention: APP_URL OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CALLBACK_URL.'
if ! grep --fixed-strings --line-regexp --quiet "${required_fields_line}" "${refusal_output}"; then
  if actual_fields_line="$(grep --fixed-strings -m1 -- "${required_fields_prefix}" "${refusal_output}")"; then
    printf 'The empty-target refusal reported the wrong required fields.\n' >&2
    printf 'Expected: %s\n' "${required_fields_line}" >&2
    printf 'Actual:   %s\n' "${actual_fields_line}" >&2
  else
    printf 'The installer exited (status %s) without ever reaching the field check; it never printed a "%s" line.\n' \
      "${installer_status}" "${required_fields_prefix}" >&2
  fi
  exit 1
fi
grep --fixed-strings --line-regexp --quiet \
  'Orbit installer: Required configuration fields require attention; refusing to start Compose.' \
  "${refusal_output}" || {
  printf 'The empty-target refusal did not report the fixed Compose refusal.\n' >&2
  exit 1
}
if docker inspect orbit > /dev/null 2>&1; then
  printf 'The empty-target refusal started an Orbit application container.\n' >&2
  exit 1
fi
[[ ! -e "${GIT_MARKER}" ]] || {
  printf 'The empty-target refusal invoked git.\n' >&2
  exit 1
}
shopt -s nullglob dotglob
entries=(*)
shopt -u nullglob dotglob
[[ "${#entries[@]}" -eq 0 ]] || {
  printf 'The empty-target refusal did not restore the target to empty: %s\n' "${entries[*]}" >&2
  exit 1
}
