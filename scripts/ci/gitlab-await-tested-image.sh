#!/usr/bin/env bash
#
# Finds the GitLab pipeline that built, tested and published this exact commit,
# waits for it if it is still running, and fetches the evidence it left:
# .orbit-supply-chain/gitlab-tested-image.json (written by
# gitlab-record-tested-image.sh in the publish_gitlab job) and the SPDX SBOM of
# the same image (from supply_chain_image). Both are checked before anything is
# handed on, because the caller pushes to a public registry on the strength of
# what this script says (#801 step 5).
#
# It refuses, rather than guessing, when:
#   - no push pipeline exists for the commit and ref within the wait budget;
#   - the newest such pipeline finished with anything other than success;
#   - publish_gitlab or supply_chain_image did not succeed in it;
#   - the evidence names another commit, ref or pipeline, is malformed, points
#     outside the project's own registry, or is older than seven days.
#
# Inputs (environment):
#   GITLAB_API_URL      e.g. https://gitlab.tomlawson.io/api/v4
#   GITLAB_PROJECT_ID   numeric project id (ai/orbit is 49)
#   GITLAB_READ_TOKEN   a read_api token; never printed
#   GITLAB_REGISTRY     registry host the evidence must point into
#   ORBIT_COMMIT        the commit being published (GITHUB_SHA)
#   ORBIT_REF           the branch it was pushed to (GITHUB_REF_NAME)
#   ORBIT_WAIT_MINUTES  optional; how long to wait for GitLab, default 120
#   ORBIT_EVIDENCE_DIR  optional; where to write the fetched files,
#                       default .orbit-supply-chain
#
# Outputs (appended to $GITHUB_OUTPUT when set): digest, source_reference,
# pipeline_url, evidence, sbom.
set -Eeuo pipefail

fail() { printf 'gitlab-await-tested-image: %s\n' "$1" >&2; exit 1; }

: "${GITLAB_API_URL:?the GitLab API URL is required}"
: "${GITLAB_PROJECT_ID:?the GitLab project id is required}"
: "${GITLAB_READ_TOKEN:?a read-only GitLab token is required}"
: "${GITLAB_REGISTRY:?the GitLab registry host is required}"
: "${ORBIT_COMMIT:?the commit to publish is required}"
: "${ORBIT_REF:?the pushed ref is required}"

[[ "$ORBIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "ORBIT_COMMIT is not an exact commit SHA: ${ORBIT_COMMIT}"
[[ "$ORBIT_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "ORBIT_REF is not a plain ref name: ${ORBIT_REF}"

wait_minutes="${ORBIT_WAIT_MINUTES:-120}"
[[ "$wait_minutes" =~ ^[0-9]+$ ]] || fail "ORBIT_WAIT_MINUTES is not a whole number: ${wait_minutes}"
evidence_dir="${ORBIT_EVIDENCE_DIR:-.orbit-supply-chain}"
project="${GITLAB_API_URL%/}/projects/${GITLAB_PROJECT_ID}"

# The token travels in a header file, not on the command line, so it never
# appears in a process listing or a shell trace.
header_file="$(mktemp)"
trap 'rm -f "$header_file"' EXIT
printf 'PRIVATE-TOKEN: %s\n' "$GITLAB_READ_TOKEN" > "$header_file"
api() { curl --silent --show-error --fail --location --max-time 60 --header @"$header_file" "$@"; }

# GitLab lists pipelines newest first. Only a push pipeline for this exact
# commit on this exact ref counts: a merge-request pipeline for the same SHA
# tested a different ref and never ran publish_gitlab.
pipeline_query="${project}/pipelines?sha=${ORBIT_COMMIT}&ref=${ORBIT_REF}&source=push&order_by=id&sort=desc&per_page=1"
deadline=$((SECONDS + wait_minutes * 60))
pipeline_id=""
while :; do
  listing="$(api "$pipeline_query")"
  pipeline_id="$(jq -r '.[0].id // empty' <<< "$listing")"
  status="$(jq -r '.[0].status // empty' <<< "$listing")"
  case "$status" in
    success) break ;;
    failed|canceled|skipped)
      fail "GitLab pipeline ${pipeline_id} for ${ORBIT_COMMIT} on ${ORBIT_REF} ended ${status}; nothing to publish" ;;
    "")
      printf 'No push pipeline for %s on %s yet; waiting.\n' "$ORBIT_COMMIT" "$ORBIT_REF" ;;
    *)
      printf 'GitLab pipeline %s is %s; waiting.\n' "$pipeline_id" "$status" ;;
  esac
  ((SECONDS < deadline)) || fail "gave up after ${wait_minutes} minutes waiting for a successful GitLab pipeline for ${ORBIT_COMMIT} on ${ORBIT_REF}"
  sleep 60
done
pipeline_url="$(jq -r '.[0].web_url' <<< "$listing")"
printf 'GitLab pipeline %s succeeded: %s\n' "$pipeline_id" "$pipeline_url"

# The job that wrote each piece of evidence. include_retried is off, so a job
# retried into success is listed once, by its successful run.
jobs="$(api "${project}/pipelines/${pipeline_id}/jobs?per_page=100")"
job_id() {
  jq -r --arg name "$1" '[.[] | select(.name == $name and .status == "success")] | sort_by(.id) | last | .id // empty' <<< "$jobs"
}
publish_job="$(job_id publish_gitlab)"
sbom_job="$(job_id supply_chain_image)"
[[ -n "$publish_job" ]] || fail "pipeline ${pipeline_id} has no successful publish_gitlab job"
[[ -n "$sbom_job" ]] || fail "pipeline ${pipeline_id} has no successful supply_chain_image job"

mkdir -p "$evidence_dir"
evidence="${evidence_dir}/gitlab-tested-image.json"
sbom="${evidence_dir}/image.spdx.json"
api --output "$evidence" "${project}/jobs/${publish_job}/artifacts/.orbit-supply-chain/gitlab-tested-image.json" ||
  fail "publish_gitlab job ${publish_job} kept no gitlab-tested-image.json artifact"
api --output "$sbom" "${project}/jobs/${sbom_job}/artifacts/.orbit-supply-chain/image.spdx.json" ||
  fail "supply_chain_image job ${sbom_job} kept no image.spdx.json artifact"

# Every field the publisher will act on, checked against what this run knows
# independently. A record for the right commit but another pipeline means two
# pipelines ran for one push; refuse rather than pick.
jq -e 'type == "object"' "$evidence" > /dev/null || fail 'gitlab-tested-image.json is not a JSON object'
field() { jq -r --arg key "$1" '.[$key] // empty' "$evidence"; }
recorded_commit="$(field commit)"
recorded_ref="$(field ref)"
recorded_pipeline="$(jq -r '.pipelineId // empty' "$evidence")"
digest="$(field imageDigest)"
source_reference="$(field imageReference)"
recorded_at="$(field recordedAt)"

[[ "$recorded_commit" == "$ORBIT_COMMIT" ]] || fail "evidence is for commit ${recorded_commit:-<missing>}, not ${ORBIT_COMMIT}"
[[ "$recorded_ref" == "$ORBIT_REF" ]] || fail "evidence is for ref ${recorded_ref:-<missing>}, not ${ORBIT_REF}"
[[ "$recorded_pipeline" == "$pipeline_id" ]] || fail "evidence names pipeline ${recorded_pipeline:-<missing>}, not ${pipeline_id}"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "evidence digest is not an immutable manifest digest: ${digest:-<missing>}"
[[ "$source_reference" == "${GITLAB_REGISTRY}/"*"@${digest}" ]] ||
  fail "evidence image reference ${source_reference:-<missing>} is not ${GITLAB_REGISTRY}/...@${digest}"
[[ "$recorded_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  fail "evidence recordedAt is not a UTC timestamp: ${recorded_at:-<missing>}"
recorded_epoch="$(date -u -d "$recorded_at" +%s)"
now_epoch="$(date -u +%s)"
(( now_epoch - recorded_epoch <= 7 * 24 * 3600 )) || fail "evidence recorded at ${recorded_at} is older than seven days"
(( recorded_epoch <= now_epoch + 300 )) || fail "evidence recorded at ${recorded_at} is in the future"

jq -e '.spdxVersion? // .SPDXID? // empty' "$sbom" > /dev/null || fail 'image.spdx.json is not an SPDX document'

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'digest=%s\n' "$digest"
    printf 'source_reference=%s\n' "$source_reference"
    printf 'pipeline_url=%s\n' "$pipeline_url"
    printf 'evidence=%s\n' "$evidence"
    printf 'sbom=%s\n' "$sbom"
  } >> "$GITHUB_OUTPUT"
fi
printf 'gitlab-await-tested-image: %s tested as %s\n' "$ORBIT_COMMIT" "$source_reference"
