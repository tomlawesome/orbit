#!/usr/bin/env bash
#
# Scans the exact image that was built and tested -- not a rebuild of the same
# source -- for vulnerabilities, records an SPDX SBOM beside the report, and
# hands both to the supply-chain policy, which fails the run when the findings
# breach it. The evidence names the image configuration digest, so a report
# can never be read as describing an image nobody ran.
#
# Extracted verbatim from the "Scan exact local image" step of the
# &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801).
#
# Inputs (environment):
#   TESTED_IMAGE_ID       configuration digest of the image under test
#   TESTED_IMAGE_TAG      local tag that resolves to it
#   TRIVY_IMAGE           pinned scanner image
#   TRIVY_DB_REPOSITORY   vulnerability database, passed into the scanner
#   ORBIT_REVISION        source revision recorded in the evidence
#   GITHUB_WORKSPACE      optional; defaults to the repository root
#   RUNNER_TEMP           optional; defaults to $TMPDIR or /tmp
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly repo_root
cd "${repo_root}"

: "${TESTED_IMAGE_ID:?the tested image identity is required}"
: "${TESTED_IMAGE_TAG:?the tested image tag is required}"
: "${TRIVY_IMAGE:?the pinned scanner image is required}"
: "${ORBIT_REVISION:?the source revision is required}"

workspace="${GITHUB_WORKSPACE:-${repo_root}}"
runner_temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
readonly workspace runner_temp

mkdir -p .orbit-supply-chain "${runner_temp}/trivy-cache"
bash scripts/trivy-db-retry.sh docker run --rm \
  --env TRIVY_DB_REPOSITORY \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "${workspace}:/workspace" \
  --volume "${runner_temp}/trivy-cache:/root/.cache/trivy" \
  "${TRIVY_IMAGE}" image \
  --scanners vuln \
  --format json \
  --output /workspace/.orbit-supply-chain/image-vulnerabilities.json \
  "${TESTED_IMAGE_TAG}"
bash scripts/trivy-db-retry.sh docker run --rm \
  --env TRIVY_DB_REPOSITORY \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "${workspace}:/workspace" \
  --volume "${runner_temp}/trivy-cache:/root/.cache/trivy" \
  "${TRIVY_IMAGE}" image \
  --scanners vuln \
  --format spdx-json \
  --output /workspace/.orbit-supply-chain/image.spdx.json \
  "${TESTED_IMAGE_TAG}"
docker run --rm \
  --volume "${runner_temp}/trivy-cache:/root/.cache/trivy" \
  "${TRIVY_IMAGE}" version --format json \
  > .orbit-supply-chain/trivy-version.json
node scripts/supply-chain-policy.mjs image \
  --input .orbit-supply-chain/image-vulnerabilities.json \
  --sbom .orbit-supply-chain/image.spdx.json \
  --output .orbit-supply-chain/image-evidence.json \
  --expected-image-id "${TESTED_IMAGE_ID}" \
  --expected-tag "${TESTED_IMAGE_TAG}" \
  --revision "${ORBIT_REVISION}"
