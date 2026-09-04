#!/usr/bin/env bash
#
# Proves a signed-out request gets nothing: the workspace API answers 401
# rather than leaking a shape, while the public favicon is still served. The
# pair is the point -- one route must refuse, the other must not.
#
# Extracted verbatim from the "Verify signed-out privacy boundary and favicon"
# step of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs: a stack listening on 127.0.0.1:3000.
set -Eeuo pipefail

status="$(curl --silent --output /tmp/orbit-workspace.json --write-out '%{http_code}' http://127.0.0.1:3000/api/workspace)"
test "${status}" = "401"
curl --fail --silent --show-error --output /tmp/orbit-icon.svg http://127.0.0.1:3000/icon.svg
grep --quiet '<svg' /tmp/orbit-icon.svg
