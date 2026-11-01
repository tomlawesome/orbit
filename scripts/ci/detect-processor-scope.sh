#!/usr/bin/env bash
#
# Decides whether the exact hostile-document processor check has to run for
# this commit. It is minutes of a live Tika stack, so it is skipped when
# nothing it covers moved -- the processor configuration, the compose file,
# the document code paths, the test itself (test-tika-processor.mjs and the
# confinement assertions in verify-tika-processor.sh), this gate and
# .gitlab-ci.yml, which runs both. A change to any of those must trigger the
# check, or weakening it merges unverified.
# The whole change is compared, not its last commit: on a merge request
# pipeline that is CI_MERGE_REQUEST_DIFF_BASE_SHA..HEAD (the merge base with
# the target branch), so a weakening in an early commit is not hidden by an
# unrelated last one (#1607). On a push, where there is no such variable, it is
# HEAD^..HEAD (the previous tip, or a merge commit's first parent).
# Unable to compare (no parent commit, or a base SHA that is not a commit here)
# means required, never skipped.
#
# Extracted verbatim from the "Detect exact processor validation scope" step
# of the retired GitHub container workflow, which the GitLab `acceptance` job now runs (#801).
#
# Inputs: the Git checkout. Outputs `required=true|false` on standard output,
# and appends the same line to $GITHUB_OUTPUT when that variable is set.
set -Eeuo pipefail

repo_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

if [[ -n "${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}" ]]; then
  compare_from="${CI_MERGE_REQUEST_DIFF_BASE_SHA}"
else
  compare_from="HEAD^"
fi

if git rev-parse --verify --quiet "${compare_from}^{commit}" >/dev/null &&
   git diff --quiet "${compare_from}..HEAD" -- \
     config/tika-config.json \
     docker-compose.yml \
     src/server/documents \
     src/server/item-document-inspection.ts \
     scripts/test-tika-processor.mjs \
     scripts/ci/verify-tika-processor.sh \
     scripts/ci/detect-processor-scope.sh \
     .gitlab-ci.yml; then
  required=false
else
  required=true
fi

printf 'required=%s\n' "${required}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'required=%s\n' "${required}" >> "${GITHUB_OUTPUT}"
fi
