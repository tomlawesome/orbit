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
#   ORBIT_ASSETS_FROM_TREE  optional; a checkout to serve the deployment
#                      assets from instead of raw.githubusercontent.com
#
# Outputs: refusal_output is appended to $GITHUB_OUTPUT when it is set.
#
# The installer downloads its deployment assets from GitHub at the revision
# the image was built from. On GitHub that revision is always there. On the
# GitLab pipeline a merge-request commit reaches GitHub only after it merges
# and mirrors, so ORBIT_ASSETS_FROM_TREE serves the same files from the
# checkout, as scripts/test-install-acceptance.sh already does for the
# lifecycle run. Whether GitHub really has them at that revision is then
# GitHub's own CI's question, asked once the merge is mirrored (owner,
# 2026-09-04, #801). Real installs are untouched: the shim exists only on
# this script's PATH.
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
if [[ -n "${ORBIT_ASSETS_FROM_TREE:-}" ]]; then
  assets_tree="$(CDPATH= cd -- "${ORBIT_ASSETS_FROM_TREE}" && pwd -P)"
  shim_dir="$(mktemp -d "${runner_temp}/orbit-refusal-shim.XXXXXX")"
  cat > "${shim_dir}/curl" <<SHIM
#!/usr/bin/env bash
# Refusal-check shim: serves the deployment assets from the checkout for any
# revision of the repository under test; every other URL fails closed so an
# unexpected network dependency shows up as a failure, not a download.
set -Eeuo pipefail
asset_prefix="https://raw.githubusercontent.com/${ORBIT_REPOSITORY}/"
output="" write_out="" url=""
args=("\$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --output) output="\${args[i+1]}"; ((i++)) ;;
    --write-out) write_out="\${args[i+1]}"; ((i++)) ;;
    --header|--connect-timeout|--max-time|--max-filesize|--proto|--proto-redir) ((i++)) ;;
    --*|-*) ;;
    *) url="\${args[i]}" ;;
  esac
done
case "\$url" in
  "\$asset_prefix"*)
    asset="\${url#"\$asset_prefix"}"
    asset="\${asset#*/}"
    [[ -f "${assets_tree}/\$asset" ]] || exit 22
    [[ -z "\$output" ]] || cp -- "${assets_tree}/\$asset" "\$output"
    [[ -z "\$write_out" ]] || printf '200'
    ;;
  *)
    exit 6
    ;;
esac
SHIM
  chmod 755 "${shim_dir}/curl"
  PATH="${shim_dir}:${PATH}"
fi

set +e
exec < /dev/null
[[ ! -t 0 ]] || {
  printf 'The refusal check must not have a TTY on standard input.\n' >&2
  exit 1
}
PATH="${GIT_GUARD_DIR}:${PATH}" bash "${workspace}/scripts/install.sh" > "${refusal_output}" 2>&1
installer_status=$?
set -e
# Every check below names what it expected; the file holds what it got. Show
# that whenever the script fails, or a failure on another runner is a guess.
show_output_on_failure() {
  [[ "$1" -eq 0 ]] || {
    printf -- '--- installer output (%s) ---\n' "${refusal_output}" >&2
    cat "${refusal_output}" >&2
  }
}
trap 'show_output_on_failure $?' EXIT
[[ "${installer_status}" -ne 0 ]] || {
  printf 'An empty non-interactive target unexpectedly accepted installation.\n' >&2
  exit 1
}
grep --fixed-strings --line-regexp --quiet \
  'Orbit installer: configuration fields requiring attention: APP_URL OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CALLBACK_URL.' \
  "${refusal_output}" || {
  printf 'The empty-target refusal did not report the fixed required fields.\n' >&2
  exit 1
}
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
  printf 'The empty-target refusal did not restore the target to empty.\n' >&2
  exit 1
}
