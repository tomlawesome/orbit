#!/usr/bin/env bash
#
# Creates the empty directory the installer will be run in, proves it really
# is empty and carries no trace of a source tree, and plants a `git` guard
# executable on the path ahead of the real one. The guard proves the installer
# never shells out to git: it records that it was invoked and then fails, so a
# real git call would both leave evidence and abort the run.
#
# Extracted verbatim from the "Prepare empty installer target and Git guard"
# step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment): RUNNER_TEMP, optional; defaults to $TMPDIR or /tmp.
#
# Outputs: install_target, git_guard_dir and git_marker are appended to
# $GITHUB_OUTPUT when it is set.
set -Eeuo pipefail

emit_output() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  printf '%s=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT}"
}

runner_temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
readonly runner_temp

install_target="$(mktemp -d "${runner_temp}/orbit-installer-target.XXXXXX")"
emit_output install_target "${install_target}"

shopt -s nullglob dotglob
entries=("${install_target}"/*)
shopt -u nullglob dotglob
[[ "${#entries[@]}" -eq 0 ]] || {
  printf 'Installer target %s is not empty.\n' "${install_target}" >&2
  exit 1
}
for marker in .git Dockerfile src package.json package-lock.json pnpm-lock.yaml yarn.lock; do
  [[ ! -e "${install_target}/${marker}" ]] || {
    printf 'Installer target unexpectedly contains %s before installation.\n' "${marker}" >&2
    exit 1
  }
done

# A guard executable proves the installer never shells out to git: it
# only records that it was invoked and fails, so a real git call would
# both leave evidence and abort the run.
git_guard_dir="$(mktemp -d "${runner_temp}/orbit-installer-git-guard.XXXXXX")"
git_marker="${git_guard_dir}/git-was-invoked"
emit_output git_guard_dir "${git_guard_dir}"
emit_output git_marker "${git_marker}"
{
  printf '#!/usr/bin/env bash\n'
  printf 'touch %s\n' "$(printf '%q' "${git_marker}")"
  printf 'exit 1\n'
} > "${git_guard_dir}/git"
chmod +x "${git_guard_dir}/git"
