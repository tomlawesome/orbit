#!/usr/bin/env bash
#
# Publication, split from validation (#661, implementing the #573 ruling):
# gives an already-validated digest its consumer-visible channel tag
# (`preview`, or `hotfix-*`), and nothing else. It consumes the validation
# evidence -- it can never produce it: the signing key lives in a protected
# environment this job does not declare, so a publishing job that wanted to
# mint its own permission has nothing to mint it with.
#
# Before tagging it refuses, via the shared verifier
# (scripts/ci/verify-validation-evidence.sh), on evidence that is mismatched,
# missing, ambiguous or expired -- and then re-runs the cheap identity and
# policy checks against the pulled digest rather than trusting the
# attestation alone (#573 ruling 24, belt and braces). The expensive checks
# -- the scan, the acceptance suite -- are deliberately not re-run: saving
# them on a re-publish is the point of the split, and their freshness is what
# the seven-day evidence expiry bounds.
#
# The tag is created registry-side with `docker buildx imagetools create`: no
# bytes move, so the digest cannot change between validation and publication.
# Retrying this job alone re-publishes a validated digest without re-running
# validation.
#
# Called by the publish_channel job in .gitlab-ci.yml; kept as its own script
# so the refusal paths can be unit tested against stub docker and a stub
# verifier (scripts/publish-channel.test.mjs).
#
# Usage:
#   scripts/ci/publish-channel.sh
#
# Inputs (environment):
#   CI_REGISTRY_IMAGE     The project's registry repository.
#   CI_COMMIT_SHA         }  from the predefined GitLab job environment;
#   CI_COMMIT_BRANCH      }  the commit and branch this publication is for
#   CI_COMMIT_REF_NAME    }
#   ORBIT_EVIDENCE_FILE   Optional; the transport record written by
#                         attest_image, default
#                         .orbit-supply-chain/gitlab-tested-image.json. Used
#                         only to discover which digest to verify -- trust
#                         comes from the attestation, not this file.
#   ORBIT_VERIFY_SCRIPT   Optional; the verifier to run, overridable only so
#                         tests can stub it. Real use always takes
#                         scripts/ci/verify-validation-evidence.sh.
#
# The caller must already be logged in to the registry; this script only ever
# reads image content and creates tags, never pushes bytes.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'publish-channel: %s\n' "$1" >&2; exit 1; }

: "${CI_REGISTRY_IMAGE:?CI_REGISTRY_IMAGE is not set; this script must run inside a GitLab CI job}"
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is not set; this script must run inside a GitLab CI job}"
: "${CI_COMMIT_BRANCH:?CI_COMMIT_BRANCH is not set; publication runs only on branch pipelines}"

[[ "$CI_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "CI_COMMIT_SHA is not an exact commit SHA: ${CI_COMMIT_SHA}"

channel_tag=preview
case "$CI_COMMIT_BRANCH" in
  preview) ;;
  hotfix/*) channel_tag="hotfix-$(printf '%s' "${CI_COMMIT_BRANCH#hotfix/}" | tr -c 'A-Za-z0-9._-' '-')" ;;
  *) fail "branch ${CI_COMMIT_BRANCH} is not a publishing branch; only preview and hotfix/* take a channel tag" ;;
esac

evidence_file="${ORBIT_EVIDENCE_FILE:-.orbit-supply-chain/gitlab-tested-image.json}"
[[ -f "$evidence_file" ]] ||
  fail "no evidence file at ${evidence_file}; attest_image writes it as an artifact, and publication has nothing to publish without it"

# Discovery only: which digest to put in front of the verifier. Everything
# this JSON claims is re-established cryptographically or re-measured below.
digest="$(node -e '
  const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof doc.imageDigest === "string" ? doc.imageDigest : "");
' -- "$evidence_file")"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "the evidence file names no immutable manifest digest (got ${digest:-<nothing>})"

pinned="${CI_REGISTRY_IMAGE}@${digest}"

# The four refusals -- mismatch, missing, ambiguous, expired -- live in the
# shared verifier, nowhere else. Its message and exit code pass through
# untouched.
ORBIT_IMAGE="$CI_REGISTRY_IMAGE" \
ORBIT_DIGEST="$digest" \
ORBIT_COMMIT="$CI_COMMIT_SHA" \
ORBIT_REF="${CI_COMMIT_REF_NAME:-$CI_COMMIT_BRANCH}" \
  bash "${ORBIT_VERIFY_SCRIPT:-${repo_root}/scripts/ci/verify-validation-evidence.sh}"

# --- The cheap checks, re-run against the digest itself (#573 ruling 24) ---

docker pull "$pinned" > /dev/null

revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$pinned")"
version="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$pinned")"
release_stage="$(docker image inspect --format '{{ index .Config.Labels "io.github.tomlawesome.orbit.release-stage" }}' "$pinned")"
embedded_version="$(docker run --rm --entrypoint cat "$pinned" /opt/orbit/VERSION)"
embedded_revision="$(docker run --rm --entrypoint cat "$pinned" /opt/orbit/REVISION)"
embedded_channel="$(docker run --rm --entrypoint cat "$pinned" /opt/orbit/CHANNEL)"
reported_version="$(docker run --rm "$pinned" --version)"

[[ "$revision" == "$CI_COMMIT_SHA" ]] ||
  fail "the image's revision label (${revision:-<none>}) is not the commit being published (${CI_COMMIT_SHA})"
[[ "$embedded_version" == "$version" && "$reported_version" == "Orbit ${version}" ]] ||
  fail 'embedded and reported versions do not match the image version label'
[[ "$embedded_revision" == "$revision" ]] ||
  fail 'embedded revision does not match the image revision label'
[[ "$embedded_channel" == "$release_stage" ]] ||
  fail 'embedded channel does not match the image release-stage label'

node scripts/supply-chain-policy.mjs validate

# --- Publication: the tag is the only thing this script creates ------------

channel_reference="${CI_REGISTRY_IMAGE}:${channel_tag}"
docker buildx imagetools create --tag "$channel_reference" "$pinned"

# Post-publication re-check: the tag must resolve to the exact digest that
# was verified, or something moved underneath this job. Same awk shape as
# scripts/ci/promote-stable.sh, for the same mawk and SIGPIPE reasons.
resolved="$(
  docker buildx imagetools inspect "$channel_reference" 2> /dev/null |
    awk '$1 == "Digest:" && length($2) == 71 && $2 ~ /^sha256:[0-9a-f]+$/ && !found { digest = $2; found = 1 }
         END { if (found) print digest }'
)"
[[ "$resolved" == "$digest" ]] ||
  fail "${channel_reference} did not retain the validated digest (resolves to ${resolved:-<nothing>}, expected ${digest})"

printf 'publish-channel: published %s as %s\n' "$digest" "$channel_reference"
