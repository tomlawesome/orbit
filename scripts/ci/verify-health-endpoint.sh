#!/usr/bin/env bash
#
# Proves the running stack answers its own health endpoint with the ready
# state, rather than merely having started a container that has not fallen
# over yet.
#
# Extracted verbatim from the "Verify health endpoint" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs: a stack listening on 127.0.0.1:3000.
set -Eeuo pipefail

response="$(curl --fail --silent --show-error http://127.0.0.1:3000/api/health)"
jq --exit-status '.status == "ready" and .service == "orbit"' <<< "${response}"
