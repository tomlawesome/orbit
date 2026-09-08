#!/usr/bin/env bash
#
# Mints the validation attestation: a cosign key-based attestation, pushed to
# the registry alongside the image, saying "this digest passed the full bar
# under policy version P at time T" (#661, implementing the #573 ruling). It
# is minted at the moment the digest first exists -- before any
# consumer-visible tag -- and every job that later adds such a tag verifies
# it with the committed public key (scripts/ci/verify-validation-evidence.sh)
# before doing so.
#
# Only the attesting job may run this: the private key lives in CI/CD
# variables scoped to the `validation-signing` protected environment, which
# exactly one job declares (attest_image in .gitlab-ci.yml). If the
# publishing job could reach the key, the split would be theatre -- #661
# criterion 6.
#
# Usage:
#   scripts/ci/attest-tested-image.sh <image-reference@digest> <image-digest>
#
# The arguments mirror scripts/ci/gitlab-record-tested-image.sh, which writes
# the unsigned transport copy of the same facts: same reference shape, same
# digest, validated the same way.
#
# Inputs (environment):
#   COSIGN_PRIVATE_KEY     Path to the cosign private key. A GitLab CI/CD
#                          *file* variable, protected, scoped to the
#                          validation-signing environment. Never printed.
#   COSIGN_PASSWORD        The key's password; cosign reads it from the
#                          environment itself. Masked, same scoping.
#   CI_COMMIT_SHA          }
#   CI_COMMIT_REF_NAME     }  the predicate's provenance fields, from the
#   CI_PIPELINE_ID         }  predefined GitLab job environment
#   CI_PIPELINE_URL        }
#   ORBIT_POLICY_VERSION   Optional; the policy version to bind. Computed by
#                          scripts/ci/policy-version.sh when unset.
#   ORBIT_COSIGN           Optional; the cosign command to run, overridable
#                          only so tests can stub it. Real use resolves the
#                          pinned binary via scripts/ci/ensure-cosign.sh.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

# The predicate type names what this attestation claims. Verifiers filter on
# it; scripts/ci/verify-validation-evidence.sh carries the same constant and
# a test asserts the two never drift apart.
readonly PREDICATE_TYPE="https://tomlawson.io/attestations/orbit-validation/v1"

fail() { printf 'attest-tested-image: %s\n' "$1" >&2; exit 1; }

image_reference="${1:-}"
image_digest="${2:-}"

[[ -n "$image_reference" ]] || fail 'an image reference is required as the first argument'
[[ -n "$image_digest" ]] || fail 'an image digest is required as the second argument'
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "image digest is not an immutable manifest digest: ${image_digest}"
[[ "$image_reference" =~ ^[A-Za-z0-9._-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)+@sha256:[0-9a-f]{64}$ ]] ||
  fail "image reference is not a plain registry reference pinned to a digest: ${image_reference}"
[[ "$image_reference" == *"@${image_digest}" ]] ||
  fail "image reference ${image_reference} does not name digest ${image_digest}"

# The preflight names the missing variable and where it comes from, because
# the likeliest failure is configuration: a protected variable is silently
# absent on an unprotected branch, and an environment-scoped one is silently
# absent from a job that does not declare the environment.
[[ -n "${COSIGN_PRIVATE_KEY:-}" ]] ||
  fail 'COSIGN_PRIVATE_KEY is not set. It is a protected CI/CD file variable scoped to the validation-signing environment (docs/releasing.md); either this job does not declare `environment: validation-signing`, or the branch is not protected, or the owner setup has not run yet.'
[[ -f "$COSIGN_PRIVATE_KEY" ]] ||
  fail "COSIGN_PRIVATE_KEY does not point at a readable file (is it a Variable rather than a File variable?): ${COSIGN_PRIVATE_KEY}"
[[ -n "${COSIGN_PASSWORD:-}" ]] ||
  fail 'COSIGN_PASSWORD is not set. It is the masked, protected CI/CD variable holding the signing key password, scoped to the validation-signing environment (docs/releasing.md).'

commit="${CI_COMMIT_SHA:-}"
ref="${CI_COMMIT_REF_NAME:-}"
pipeline_id="${CI_PIPELINE_ID:-}"
pipeline_url="${CI_PIPELINE_URL:-}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "CI_COMMIT_SHA is not an exact commit SHA: ${commit:-<unset>}"
[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "CI_COMMIT_REF_NAME is not a plain ref name: ${ref:-<unset>}"
[[ "$pipeline_id" =~ ^[0-9]+$ ]] || fail "CI_PIPELINE_ID is not numeric: ${pipeline_id:-<unset>}"
[[ "$pipeline_url" =~ ^https://[A-Za-z0-9._:/-]+$ ]] || fail "CI_PIPELINE_URL is not an https URL: ${pipeline_url:-<unset>}"

policy_version="${ORBIT_POLICY_VERSION:-$(bash scripts/ci/policy-version.sh)}"
[[ "$policy_version" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "policy version is not a sha256 value: ${policy_version}"

recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Every field above is validated to shapes that need no JSON escaping, the
# same stance gitlab-record-tested-image.sh takes: anything else is a bug in
# the caller, not a value to quote around.
predicate_file="$(mktemp)"
trap 'rm -f "$predicate_file"' EXIT
cat > "$predicate_file" <<JSON
{
  "commit": "${commit}",
  "ref": "${ref}",
  "pipelineId": ${pipeline_id},
  "pipelineUrl": "${pipeline_url}",
  "imageDigest": "${image_digest}",
  "policyVersion": "${policy_version}",
  "recordedAt": "${recorded_at}"
}
JSON

cosign_cmd="${ORBIT_COSIGN:-}"
if [[ -z "$cosign_cmd" ]]; then
  cosign_cmd="$(bash scripts/ci/ensure-cosign.sh)"
fi

# Key-based signing against private infrastructure: there is no Rekor here, and
# verifiers pass --insecure-ignore-tlog to match. Both flags are needed on the
# pinned cosign v3: --use-signing-config defaults to true, and cosign refuses
# --tlog-upload=false alongside it ("not supported with --signing-config or
# --use-signing-config"). Verified against the pinned binary, 2026-09-08.
# --yes answers cosign's interactive prompts, which a job cannot.
"$cosign_cmd" attest \
  --predicate "$predicate_file" \
  --type "$PREDICATE_TYPE" \
  --key "$COSIGN_PRIVATE_KEY" \
  --use-signing-config=false \
  --tlog-upload=false \
  --yes \
  "$image_reference" ||
  fail "cosign could not attest ${image_reference}"

printf 'attest-tested-image: attested %s (policy %s) as %s\n' \
  "$image_digest" "$policy_version" "$PREDICATE_TYPE"
