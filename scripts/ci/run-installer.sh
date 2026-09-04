#!/usr/bin/env bash
#
# Runs the real installer, unattended, against the pre-provisioned target and
# the disposable registry. No TTY on standard input, so an installer that
# quietly waited for an answer fails here instead of hanging; the git guard
# stays on the path so a shell-out to git aborts the run.
#
# Extracted verbatim from the "Run installer against the pre-provisioned
# disposable registry" step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). It deliberately does not
# change directory: the caller runs it from the installer target, which is
# where the installer must do its work.
#
# Inputs (environment):
#   ORBIT_REGISTRY, ORBIT_REPOSITORY, ORBIT_CHANNEL  the disposable registry
#   GIT_GUARD_DIR     directory holding the guard `git`, prepended to PATH
#   GITHUB_WORKSPACE  optional; defaults to the repository root
#   ORBIT_ASSETS_FROM_TREE  optional; see scripts/ci/assets-from-tree.sh
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root

: "${GIT_GUARD_DIR:?the git guard directory is required}"

workspace="${GITHUB_WORKSPACE:-${repo_root}}"
readonly workspace

# shellcheck source=scripts/ci/assets-from-tree.sh
source "${repo_root}/scripts/ci/assets-from-tree.sh"
PATH="$(assets_from_tree_path)${PATH}"

exec < /dev/null
[[ ! -t 0 ]] || {
  printf 'The installer run must not have a TTY on standard input.\n' >&2
  exit 1
}
PATH="${GIT_GUARD_DIR}:${PATH}" bash "${workspace}/scripts/install.sh"
