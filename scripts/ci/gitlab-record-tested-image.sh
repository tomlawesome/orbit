#!/usr/bin/env bash
# Records the image a GitLab pipeline built, tested and pushed to
# registry.tomlawson.io, so a later GitHub job can copy that exact digest to
# GHCR instead of rebuilding it (#801).
#
# The evidence is written the moment the push it describes has succeeded and
# before anything else is attempted, for the same reason the sibling base-image
# pipeline writes its digest there: a record that depends on a later step
# publishes nothing when that step fails, and the digest is lost with the job.
#
# Usage:
#   scripts/ci/gitlab-record-tested-image.sh <image-reference> <image-digest>
#
# Everything else comes from the predefined GitLab job environment. Every value
# is validated before it is written: this file is read by a job that pushes to
# a public registry, so a malformed field must fail here rather than travel.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

fail() { printf 'gitlab-record-tested-image: %s\n' "$1" >&2; exit 1; }

image_reference="${1:-}"
image_digest="${2:-}"

[[ -n "$image_reference" ]] || fail 'an image reference is required as the first argument'
[[ -n "$image_digest" ]] || fail 'an image digest is required as the second argument'

# Deliberately narrow: a registry reference and a manifest digest, nothing that
# needs JSON escaping. Anything else is a bug in the caller, not a value to
# quote around.
[[ "$image_reference" =~ ^[A-Za-z0-9._:/-]+$ ]] ||
  fail "image reference is not a plain registry reference: ${image_reference}"
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "image digest is not an immutable manifest digest: ${image_digest}"

commit="${CI_COMMIT_SHA:-}"
ref="${CI_COMMIT_REF_NAME:-}"
pipeline_id="${CI_PIPELINE_ID:-}"
pipeline_url="${CI_PIPELINE_URL:-}"

[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "CI_COMMIT_SHA is not an exact commit SHA: ${commit:-<unset>}"
[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "CI_COMMIT_REF_NAME is not a plain ref name: ${ref:-<unset>}"
[[ "$pipeline_id" =~ ^[0-9]+$ ]] || fail "CI_PIPELINE_ID is not numeric: ${pipeline_id:-<unset>}"
[[ "$pipeline_url" =~ ^https://[A-Za-z0-9._:/-]+$ ]] || fail "CI_PIPELINE_URL is not an https URL: ${pipeline_url:-<unset>}"

recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
output_dir="${repo_root}/.orbit-supply-chain"
output="${output_dir}/gitlab-tested-image.json"

mkdir -p "$output_dir"
cat > "$output" <<JSON
{
  "commit": "${commit}",
  "ref": "${ref}",
  "pipelineId": ${pipeline_id},
  "pipelineUrl": "${pipeline_url}",
  "imageDigest": "${image_digest}",
  "imageReference": "${image_reference}",
  "recordedAt": "${recorded_at}"
}
JSON

printf 'gitlab-record-tested-image: wrote %s\n' "$output"
