#!/usr/bin/env bash
#
# Saves the build before this one: its signed release manifest and the
# manifest's signature, under .orbit-supply-chain/previous/ (#1480), so a
# later consumer -- the launcher's live update test (ai/orbit-launcher#263) --
# can find the previous preview build by branch, with no job IDs. Pinned job
# IDs would break once their artifacts expire.
#
# Two calls, both from the record_image job in .gitlab-ci.yml:
#
#   carry-previous-release.sh --prepare
#       BEFORE the image push. Looks the predecessor up, fetches its pair,
#       verifies each fetched pair against cosign.pub
#       (scripts/ci/verify-release-manifest.sh) and stages them. Any failure
#       fails the job before anything is published (#1607 review item 4).
#
#   carry-previous-release.sh <published-image-digest>
#       AFTER the push, once the registry's digest exists. Picks the staged
#       pair and moves it into previous/ in one rename.
#
# "The build before" is the newest job named record_image with status success
# on the same branch, found with GET /projects/:id/jobs (a job token may call
# it, and the pipelines' job lists and job artifacts, on its own project). A
# pipeline that ran no record_image (a schedule, a web run) cannot hide it
# (#1607 review item 2). Its manifest comes from that job, its signature from
# the sign_evidence job of the same pipeline, both fetched by job id, so the
# two always belong to one build and no second download is needed to prove it.
#
# On a rebuild of the same image (the predecessor's manifest names the digest
# being recorded) the predecessor's own previous/ pair, fetched by the same
# job id, is carried forward instead, so previous/ never points at itself.
# --prepare always looks for that pair (a 404 means the predecessor has none);
# the digest call fails if a rebuild finds none.
#
# A fail-loud, idempotent carry (#1607 D-F1-1, D-F2-1, D-F5). Anything it
# cannot find or trust is an error that names its cause: it prints
# "carry-previous-release: FAILED: <cause>" on stderr, saves nothing under
# previous/ and exits 1 (a usage error exits 2). Every API call's HTTP status
# is read (#1607 review item 3): only a 404 on a by-job artifact file means
# "that file is absent". A 401, a 403, a 5xx, a redirect, a listing that is
# not JSON, a 404 on a listing or a curl transport error always fails,
# naming the status and the URL (never the token).
#
# The one pass-through is a ref's very first release: the whole job listing
# (every page, up to the page cap) holds no successful record_image job on the
# ref. --prepare then logs it and stages a first-release marker (no files);
# the digest call sees the marker and exits 0, saving nothing. A listing that
# hits the page cap without a match is never read as a first release: it fails.
#
# Usage:
#   scripts/ci/carry-previous-release.sh --prepare
#   scripts/ci/carry-previous-release.sh <published-image-digest>
#
# Inputs (environment, all set by GitLab CI):
#   CI_API_V4_URL      API root, e.g. https://gitlab.example/api/v4.
#   CI_PROJECT_ID      Numeric project ID.
#   CI_COMMIT_REF_NAME The branch whose previous build is wanted.
#   CI_JOB_ID          This job, never taken as the predecessor.
#   CI_JOB_TOKEN       Sent as a JOB-TOKEN header read from a mode-600 temp
#                      file (curl -H @file), so it is never in argv or the
#                      log.
#
# Needs curl and jq, plus what the verifier needs: openssl, and curl to fetch
# the pinned cosign (scripts/ci/ensure-cosign.sh) unless ORBIT_COSIGN is set.

set -euo pipefail

mode=""
current_digest=""
if [ "$#" -eq 1 ] && [ "$1" = "--prepare" ]; then
  mode="prepare"
elif [ "$#" -eq 1 ] && [ -n "$1" ]; then
  mode="final"
  current_digest="$1"
else
  echo "usage: $0 --prepare | <published-image-digest>" >&2
  exit 2
fi
verifier="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/verify-release-manifest.sh"

dest=".orbit-supply-chain/previous"
# Where --prepare leaves what the digest call needs. The name is fixed so the
# second call finds it. Inside .orbit-supply-chain so the final rename stays on
# one filesystem and is atomic: previous/ is either absent or complete.
stage=".orbit-supply-chain/.previous-stage"
manifest_name="orbit-release-manifest.json"
sig_name="orbit-release-manifest.json.sig"
# The job listing is walked 100 jobs a page, newest first, for at most 20 pages
# (2000 jobs). Reaching the cap with no match fails, never reads as a first release.
max_listing_pages=20

header_file=""
keep_stage=""
cleanup() {
  [ -z "$header_file" ] || rm -f -- "$header_file"
  [ -n "$keep_stage" ] || rm -rf -- "$stage"
}
trap cleanup EXIT

# fail <cause>: the carry cannot be trusted or finished. Names the cause,
# exits 1 (the cleanup trap removes the staging dir and the header file).
fail() {
  echo "carry-previous-release: FAILED: $1" >&2
  exit 1
}

# digest_of <manifest file>: prints .image.digest; fails unless the whole
# string is sha256:<64 lowercase hex>.
digest_of() {
  jq -er '.image.digest | select(type == "string" and test("\\Asha256:[0-9a-f]{64}\\z"))' "$1" 2> /dev/null
}

if [ "$mode" = "final" ]; then
  ref_label="${CI_COMMIT_REF_NAME:-this ref}"
  if [ -f "$stage/first-release" ]; then
    echo "carry-previous-release: first release on ${ref_label}: nothing carried, no ${dest}/ saved"
    exit 0
  fi
  [ -f "$stage/staged" ] ||
    fail "nothing was staged: carry-previous-release.sh --prepare must run (and pass) before the image push"
  pick="predecessor"
  predecessor_digest="$(digest_of "$stage/predecessor/$manifest_name")" ||
    fail "the staged predecessor manifest has no readable image digest"
  if [ "$predecessor_digest" = "$current_digest" ]; then
    # Rebuild of the image being recorded: the previous build is whatever that
    # build itself carried.
    if [ ! -f "$stage/carried/$manifest_name" ] || [ ! -f "$stage/carried/$sig_name" ]; then
      fail "rebuild of the published digest ${current_digest}, and the build being rebuilt has no carried pair (previous/$manifest_name and previous/$sig_name), so there is nothing to carry"
    fi
    carried_digest="$(digest_of "$stage/carried/$manifest_name")" ||
      fail "the carried manifest has no readable image digest"
    [ "$carried_digest" != "$current_digest" ] ||
      fail "the carried manifest names the published digest ${current_digest} too, so previous/ would point at itself"
    pick="carried"
    predecessor_digest="$carried_digest"
  fi
  # Both files are good (--prepare verified them): move them into place in one rename.
  rm -rf -- "$dest"
  mv -T -- "$stage/$pick" "$dest"
  chmod 755 "$dest"
  echo "carry-previous-release: previous build on ${ref_label} is ${predecessor_digest}; saved to ${dest}/"
  exit 0
fi

# --prepare. Everything below needs the environment; a CI misconfiguration is a failure.
for var in CI_API_V4_URL CI_PROJECT_ID CI_COMMIT_REF_NAME CI_JOB_ID CI_JOB_TOKEN; do
  [ -n "${!var:-}" ] || fail "$var is not set"
done

# The token goes to curl through a header file made outside the working
# directory, readable only by us, and removed on exit (trap above).
umask 077
header_file="$(mktemp "${TMPDIR:-/tmp}/carry-previous-header.XXXXXX")"
printf 'JOB-TOKEN: %s\n' "$CI_JOB_TOKEN" > "$header_file"

mkdir -p .orbit-supply-chain
rm -rf -- "$stage"
mkdir -p -- "$stage/predecessor" "$stage/carried"
stage_abs="$(pwd -P)/$stage"

ref="$(jq -rn --arg ref "$CI_COMMIT_REF_NAME" '$ref | @uri')"
api="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"

# api_get <url> <body file> <header file>: one GET. Sets api_status to the HTTP
# status; a curl transport error (no status) fails here, naming the URL.
api_get() {
  local rc=0
  # No --location: these URLs answer directly, and curl would send the
  # JOB-TOKEN header on to whatever host a redirect named. No --fail either:
  # its single exit 22 would hide which status came back.
  api_status="$(curl --silent --show-error \
    --retry 2 --retry-delay 2 --connect-timeout 10 --max-time 30 \
    -H "@${header_file}" \
    --dump-header "$3" --output "$2" --write-out '%{http_code}' \
    "$1")" || rc=$?
  [ "$rc" -eq 0 ] || fail "GET $1 failed with a curl transport error (curl exit status ${rc}), so the answer is unknown"
}

# fail_status <url>: the API answered something other than what was needed.
fail_status() {
  local hint=""
  case "$api_status" in
    401 | 403) hint=" (check that the job token's allowlist includes this project with read jobs)" ;;
  esac
  fail "GET $1 answered HTTP ${api_status}${hint}"
}

# find_job <list url without paging> <job name> <ref or ""> <job id to skip or "">
# Walks the listing (X-Next-Page, newest first) and sets found_job to the first
# successful job of that name (on that ref, other than that job id) as JSON, or
# to "" when every page was read and there is none. Fails if the page cap is
# reached first.
find_job() {
  local page=1 url next
  found_job=""
  while :; do
    url="$1&per_page=100&page=${page}"
    api_get "$url" "$stage/page.json" "$stage/page.headers"
    [ "$api_status" = "200" ] || fail_status "$url"
    jq -e 'type == "array"' "$stage/page.json" > /dev/null 2>&1 ||
      fail "GET $url did not answer a JSON array of jobs"
    # The ref filter is undocumented, so the ref is checked again here.
    found_job="$(jq -c --arg name "$2" --arg ref "$3" --arg skip "$4" \
      'first(.[] | select(.name == $name and .status == "success" and ($ref == "" or .ref == $ref) and (.id | tostring) != $skip)) // empty' \
      "$stage/page.json")"
    [ -z "$found_job" ] || return 0
    next="$(tr -d '\r' < "$stage/page.headers" | awk -F': *' 'tolower($1) == "x-next-page" && $2 ~ /^[0-9]+$/ { n = $2 } END { print n }')"
    [ -n "$next" ] || return 0
    [ "$page" -lt "$max_listing_pages" ] ||
      fail "reached the page cap (${max_listing_pages} pages of 100 jobs) listing ${1} without finding a ${2} job, so this cannot be called a first release"
    page="$next"
  done
}

# fetch_artifact <job id> <path under .orbit-supply-chain> <output file>:
# returns 0 once fetched and 1 when the file is absent (404); any other answer fails.
fetch_artifact() {
  local url="${api}/jobs/$1/artifacts/.orbit-supply-chain/$2"
  api_get "$url" "$3" "$stage/artifact.headers"
  case "$api_status" in
    200) return 0 ;;
    404)
      rm -f -- "$3"
      return 1
      ;;
    *) fail_status "$url" ;;
  esac
}

# verify_pair <staged dir> <what>: against cosign.pub. The verifier cds to the
# repository root, so it gets absolute paths. It never needs the job token, so
# it never gets it.
verify_pair() {
  env -u CI_JOB_TOKEN bash "$verifier" "$stage_abs/$1/$manifest_name" "$stage_abs/$1/$sig_name" ||
    fail "the ${2} manifest does not verify against cosign.pub (its manifest and signature may come from different builds)"
}

find_job "${api}/jobs?scope%5B%5D=success&ref=${ref}" record_image "$CI_COMMIT_REF_NAME" "$CI_JOB_ID"
if [ -z "$found_job" ]; then
  : > "$stage/first-release"
  keep_stage=1
  echo "carry-previous-release: no successful record_image job on ${CI_COMMIT_REF_NAME}: first release, nothing carried"
  exit 0
fi
ids="$(printf '%s' "$found_job" | jq -r '"\(.id) \(.pipeline.id)"')"
case "$ids" in
  [0-9]*" "[0-9]*) ;;
  *) fail "the record_image job found on ${CI_COMMIT_REF_NAME} has no readable job or pipeline id" ;;
esac
rec_job="${ids% *}"
rec_pipeline="${ids#* }"

# The signature belongs to the sign_evidence job of the same pipeline.
find_job "${api}/pipelines/${rec_pipeline}/jobs?scope%5B%5D=success" sign_evidence "" ""
[ -n "$found_job" ] ||
  fail "pipeline ${rec_pipeline} (record_image job ${rec_job}, the build before this one on ${CI_COMMIT_REF_NAME}) has no successful sign_evidence job: retry its sign_evidence job, then run this job again"
sign_job="$(printf '%s' "$found_job" | jq -r '.id')"

fetch_artifact "$rec_job" "$manifest_name" "$stage/predecessor/$manifest_name" ||
  fail "job record_image ${rec_job} has no ${manifest_name} artifact (HTTP 404 at ${api}/jobs/${rec_job}/artifacts/.orbit-supply-chain/${manifest_name})"
digest_of "$stage/predecessor/$manifest_name" > /dev/null ||
  fail "the fetched manifest has no readable image digest"
fetch_artifact "$sign_job" "$sig_name" "$stage/predecessor/$sig_name" ||
  fail "job sign_evidence ${sign_job} has no ${sig_name} artifact (HTTP 404 at ${api}/jobs/${sign_job}/artifacts/.orbit-supply-chain/${sig_name})"
verify_pair predecessor "previous build's"

# The predecessor's own carried pair, for a rebuild. Absent (404) means it has none.
have_manifest=""
have_sig=""
fetch_artifact "$rec_job" "previous/$manifest_name" "$stage/carried/$manifest_name" && have_manifest=1
fetch_artifact "$rec_job" "previous/$sig_name" "$stage/carried/$sig_name" && have_sig=1
if [ -n "$have_manifest" ] && [ -z "$have_sig" ]; then
  fail "job record_image ${rec_job} carried a manifest (previous/$manifest_name) but no carried signature (previous/$sig_name)"
elif [ -z "$have_manifest" ] && [ -n "$have_sig" ]; then
  fail "job record_image ${rec_job} carried a signature (previous/$sig_name) but no carried manifest (previous/$manifest_name)"
elif [ -n "$have_manifest" ]; then
  digest_of "$stage/carried/$manifest_name" > /dev/null ||
    fail "the carried manifest has no readable image digest"
  verify_pair carried "carried"
fi

: > "$stage/staged"
keep_stage=1
echo "carry-previous-release: staged the build before this one on ${CI_COMMIT_REF_NAME} (record_image job ${rec_job}); nothing is saved until the digest call"
