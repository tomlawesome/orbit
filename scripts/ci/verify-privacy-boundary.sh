#!/usr/bin/env bash
#
# Proves a signed-out request gets nothing: the workspace API answers 401
# rather than leaking a shape, while the public favicon is still served. The
# pair is the point -- one route must refuse, the other must not.
#
# Extracted from the "Verify signed-out privacy boundary and favicon" step of
# the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). The response bodies go to
# private temporary files rather than fixed /tmp paths, so a stale file from
# an earlier run can never be what an assertion reads.
#
# Inputs: a stack listening on 127.0.0.1:3000.
set -Eeuo pipefail

workspace_body="$(mktemp)"
icon_body="$(mktemp)"
readonly workspace_body icon_body

cleanup() {
  rm -f -- "${workspace_body}" "${icon_body}"
}
trap cleanup EXIT

status="$(curl --silent --output "${workspace_body}" --write-out '%{http_code}' http://127.0.0.1:3000/api/workspace)"
test "${status}" = "401"
curl --fail --silent --show-error --output "${icon_body}" http://127.0.0.1:3000/icon.svg
grep --quiet '<svg' "${icon_body}"
