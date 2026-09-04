#!/usr/bin/env bash
#
# Decides whether the exact hostile-document processor check has to run for
# this commit. It is minutes of a live Tika stack, so it is skipped when
# nothing it covers moved -- the processor configuration, the compose file,
# the document code paths, the test itself, or the workflow that runs it.
# Unable to compare (no parent commit) means required, never skipped.
#
# Extracted verbatim from the "Detect exact processor validation scope" step
# of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs: the Git checkout. Outputs `required=true|false` on standard output,
# and appends the same line to $GITHUB_OUTPUT when that variable is set.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

if git rev-parse --verify HEAD^ >/dev/null 2>&1 &&
   git diff --quiet HEAD^ HEAD -- \
     config/tika-config.json \
     docker-compose.yml \
     src/server/document-drafts.ts \
     src/server/documents \
     src/server/item-document-inspection.ts \
     scripts/test-tika-processor.mjs \
     .github/workflows/publish-container.yml; then
  required=false
else
  required=true
fi

printf 'required=%s\n' "${required}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'required=%s\n' "${required}" >> "${GITHUB_OUTPUT}"
fi
