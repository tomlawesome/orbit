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
#       verifies each fetched pair against cosign.pub, then against each
#       retired key in cosign-retired/ beside it
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
# naming the status and the URL (never the token). Every call carries
# --max-filesize, so a runaway answer ends the call (curl exit 63) and fails.
#
# Three ways a stuck release recovers without a hand-started pipeline or a CI
# variable: an ordinary push, a job retry, or waiting (#1607 note 48548).
#
#   Key rotation. A retired signing key is kept, public half only, beside
#   cosign.pub as cosign-retired/<YYYY-MM-DD>.pub (the directory next to the key
#   in use). A pair is verified against cosign.pub first, then each retired key in
#   name order; the first pass wins and the log names the file. None passing
#   fails naming every file tried.
#
#   Expired artifacts. record_image and sign_evidence keep their artifacts
#   (expire_in: never), but a predecessor built before that has expiry dates. A
#   404 on its manifest or signature, when the job listing gives an
#   artifacts_expire_at, says the artifacts expired. The recovery is a committed,
#   reviewed line in scripts/ci/carry-accepted-gap (format in that file): --prepare
#   honours it only when the predecessor is that job on that ref and the failure
#   was a 404 on its pair or a verification failure, and then treats the ref as
#   a first release. An API error or a missing sign_evidence is never accepted.
#
#   Busy sign_evidence. The predecessor pipeline's newest sign_evidence job still
#   in flight is polled (ORBIT_CARRY_POLL_SECONDS apart, default 30) for at most
#   20 listings, then the carry fails saying so: wait and run this job again.
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
# Optional:
#   COSIGN_PUBLIC_KEY          The key in use, default cosign.pub in the
#                              repository root; cosign-retired/ is read from
#                              its directory.
#   ORBIT_CARRY_POLL_SECONDS   Seconds between polls of a busy sign_evidence
#                              job, default 30 (tests set 0).
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
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="${script_dir}/verify-release-manifest.sh"
# The committed break-glass file, always beside this script.
gap_file="${script_dir}/carry-accepted-gap"

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
# Size caps for curl --max-filesize, so a runaway answer ends the call rather
# than filling the disk. An artifact is a manifest or a signature, a few KB, so
# 1 MiB is far above any real one; a job listing page is up to 100 jobs of a few
# KB each, so it gets more room.
max_artifact_size="1M"
max_listing_size="16M"
# A sign_evidence job still in flight is polled at most 20 times (listings of
# the pipeline's jobs), ORBIT_CARRY_POLL_SECONDS apart.
max_evidence_polls=20
poll_seconds="${ORBIT_CARRY_POLL_SECONDS:-30}"

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
case "$poll_seconds" in
  '' | *[!0-9]*) fail "ORBIT_CARRY_POLL_SECONDS must be a whole number of seconds, not '${poll_seconds}'" ;;
esac

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

# api_get <url> <body file> <header file> <size limit>: one GET. Sets api_status
# to the HTTP status; a curl transport error (no status) fails here, naming the
# URL.
api_get() {
  local rc=0
  # No --location: these URLs answer directly, and curl would send the
  # JOB-TOKEN header on to whatever host a redirect named. No --fail either:
  # its single exit 22 would hide which status came back.
  api_status="$(curl --silent --show-error \
    --retry 2 --retry-delay 2 --connect-timeout 10 --max-time 30 \
    --max-filesize "$4" \
    -H "@${header_file}" \
    --dump-header "$3" --output "$2" --write-out '%{http_code}' \
    "$1")" || rc=$?
  case "$rc" in
    0) ;;
    63) fail "GET $1 answered more than the ${4} size limit (curl exit status 63), so the answer is not read" ;;
    *) fail "GET $1 failed with a curl transport error (curl exit status ${rc}), so the answer is unknown" ;;
  esac
}

# fail_status <url>: the API answered something other than what was needed.
fail_status() {
  local hint=""
  case "$api_status" in
    401 | 403) hint=" (check that the job token's allowlist includes this project with read jobs)" ;;
  esac
  fail "GET $1 answered HTTP ${api_status}${hint}"
}

# list_page <list url> <page>: reads one page of a job listing (100 jobs) into
# $stage/page.json and sets next_page to the number of the page after it, or to
# "" on the last one.
list_page() {
  local sep="?" url
  case "$1" in *\?*) sep="&" ;; esac
  url="${1}${sep}per_page=100&page=$2"
  api_get "$url" "$stage/page.json" "$stage/page.headers" "$max_listing_size"
  [ "$api_status" = "200" ] || fail_status "$url"
  jq -e 'type == "array"' "$stage/page.json" > /dev/null 2>&1 ||
    fail "GET $url did not answer a JSON array of jobs"
  next_page="$(tr -d '\r' < "$stage/page.headers" | awk -F': *' 'tolower($1) == "x-next-page" && $2 ~ /^[0-9]+$/ { n = $2 } END { print n }')"
}

# find_job <list url> <job name> <ref or ""> <job id to skip or "">
# Walks the listing (X-Next-Page, newest first) and sets found_job to the first
# successful job of that name (on that ref, other than that job id) as JSON, or
# to "" when every page was read and there is none. Fails if the page cap is
# reached first.
find_job() {
  local page=1
  found_job=""
  while :; do
    list_page "$1" "$page"
    # The ref filter is undocumented, so the ref is checked again here.
    found_job="$(jq -c --arg name "$2" --arg ref "$3" --arg skip "$4" \
      'first(.[] | select(.name == $name and .status == "success" and ($ref == "" or .ref == $ref) and (.id | tostring) != $skip)) // empty' \
      "$stage/page.json")"
    [ -z "$found_job" ] || return 0
    [ -n "$next_page" ] || return 0
    [ "$page" -lt "$max_listing_pages" ] ||
      fail "reached the page cap (${max_listing_pages} pages of 100 jobs) listing ${1} without finding a ${2} job, so this cannot be called a first release"
    page="$next_page"
  done
}

# find_newest_job <list url> <job name>: sets found_job to the job of that name
# with the highest id, whatever its status, or to "" when no page has one. The
# order of a pipeline's job list is not relied on, so every page is read.
find_newest_job() {
  local page=1 here
  found_job=""
  while :; do
    list_page "$1" "$page"
    here="$(jq -c --arg name "$2" '[.[] | select(.name == $name)] | max_by(.id) // empty' "$stage/page.json")"
    if [ -n "$here" ]; then
      found_job="$(jq -cn --argjson a "${found_job:-null}" --argjson b "$here" '[$a, $b] | map(select(. != null)) | max_by(.id)')"
    fi
    [ -n "$next_page" ] || return 0
    [ "$page" -lt "$max_listing_pages" ] ||
      fail "reached the page cap (${max_listing_pages} pages of 100 jobs) listing ${1}, so the newest ${2} job is unknown"
    page="$next_page"
  done
}

# fetch_artifact <job id> <path under .orbit-supply-chain> <output file>:
# returns 0 once fetched and 1 when the file is absent (404); any other answer fails.
fetch_artifact() {
  local url="${api}/jobs/$1/artifacts/.orbit-supply-chain/$2"
  api_get "$url" "$3" "$stage/artifact.headers" "$max_artifact_size"
  case "$api_status" in
    200) return 0 ;;
    404)
      rm -f -- "$3"
      return 1
      ;;
    *) fail_status "$url" ;;
  esac
}

# The break-glass file, scripts/ci/carry-accepted-gap: lines of
# "<ref> <record_image job id> <reason>", # comments and blank lines allowed.
# A malformed line fails --prepare naming it, before anything is fetched.
gap_refs=()
gap_jobs=()
gap_reasons=()
load_gap_file() {
  local line trimmed g_ref g_job g_reason n=0
  [ -f "$gap_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in '' | '#'*) continue ;; esac
    g_ref="" g_job="" g_reason=""
    read -r g_ref g_job g_reason <<< "$trimmed" || true
    if [ -z "$g_reason" ] || ! [[ "$g_job" =~ ^[0-9]+$ ]]; then
      fail "scripts/ci/carry-accepted-gap line ${n} is malformed (want '<ref> <record_image job id> <reason>'): ${line}"
    fi
    gap_refs+=("$g_ref")
    gap_jobs+=("$g_job")
    gap_reasons+=("$g_reason")
  done < "$gap_file"
}

# predecessor_failure <cause>: the predecessor's pair is gone (a 404) or does not
# verify. Passes only for a committed carry-accepted-gap line naming this ref and
# this record_image job: the carry then stages a first-release marker, so nothing
# is carried and the digest call saves nothing. Every other line is logged as
# stale and ignored. With no matching line, this is a failure like any other.
# API errors and a missing sign_evidence never come through here.
predecessor_failure() {
  local i reason="" matched=""
  if [ "${#gap_refs[@]}" -gt 0 ]; then
    for i in "${!gap_refs[@]}"; do
      if [ "${gap_refs[$i]}" = "$CI_COMMIT_REF_NAME" ] && [ "${gap_jobs[$i]}" = "$rec_job" ]; then
        if [ -z "$matched" ]; then
          matched=1
          reason="${gap_reasons[$i]}"
        fi
      else
        echo "carry-previous-release: ignoring stale line in carry-accepted-gap (${gap_refs[$i]} ${gap_jobs[$i]}): the build before this one on ${CI_COMMIT_REF_NAME} is record_image job ${rec_job}" >&2
      fi
    done
  fi
  [ -n "$matched" ] || fail "$1"
  rm -rf -- "$stage/predecessor" "$stage/carried"
  : > "$stage/first-release"
  keep_stage=1
  echo "carry-previous-release: gap accepted for record_image job ${rec_job} on ${CI_COMMIT_REF_NAME} (${reason}): ${1}; nothing carried"
  exit 0
}

# absent_artifact <job kind> <job id> <file name> <artifacts_expire_at or "">:
# the predecessor's file answered 404. A job listing that gave an expiry date
# says why, and the way out.
absent_artifact() {
  local msg="job $1 $2 has no $3 artifact (HTTP 404 at ${api}/jobs/$2/artifacts/.orbit-supply-chain/$3)"
  if [ -n "$4" ]; then
    msg="${msg}: the job's artifacts had expiry $4 and have expired, so the build before this one is lost; to release anyway, add the line '${CI_COMMIT_REF_NAME} ${rec_job} <reason>' to scripts/ci/carry-accepted-gap, reviewed and pushed (docs/releasing.md)"
  fi
  predecessor_failure "$msg"
}

# The key in use, and the retired public keys beside it (cosign-retired/*.pub),
# kept so builds signed before a rotation still verify. Name order.
trust_key="${COSIGN_PUBLIC_KEY:-$(CDPATH='' cd -- "${script_dir}/../.." && pwd -P)/cosign.pub}"
trust_keys=("$trust_key")
trust_labels=("$(basename -- "$trust_key")")
if [ -d "$(dirname -- "$trust_key")/cosign-retired" ]; then
  while IFS= read -r retired; do
    trust_keys+=("$retired")
    trust_labels+=("cosign-retired/$(basename -- "$retired")")
  done < <(find "$(dirname -- "$trust_key")/cosign-retired" -maxdepth 1 -type f -name '*.pub' | LC_ALL=C sort)
fi

# verify_pair <staged dir> <what>: against the key in use, then each retired
# key, through the shared verifier; the first pass wins and the log names the
# file. The verifier cds to the repository root, so it gets absolute paths. It
# never needs the job token, so it never gets it. No key passing is a
# predecessor_failure naming every file tried.
verify_pair() {
  local i tried=""
  for i in "${!trust_keys[@]}"; do
    if env -u CI_JOB_TOKEN COSIGN_PUBLIC_KEY="${trust_keys[$i]}" bash "$verifier" \
      "$stage_abs/$1/$manifest_name" "$stage_abs/$1/$sig_name" > "$stage/verify.out" 2>&1; then
      echo "carry-previous-release: the ${2} manifest verified against ${trust_labels[$i]}"
      return 0
    fi
    sed "s|^|carry-previous-release: ${trust_labels[$i]}: |" "$stage/verify.out" >&2
    tried="${tried:+${tried}, }${trust_labels[$i]}"
  done
  if [ "${#trust_keys[@]}" -eq 1 ]; then
    predecessor_failure "the ${2} manifest does not verify against ${tried} (its manifest and signature may come from different builds)"
  fi
  predecessor_failure "the ${2} manifest does not verify against any trusted key (tried ${tried}; its manifest and signature may come from different builds)"
}

load_gap_file

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
rec_expires="$(printf '%s' "$found_job" | jq -r '.artifacts_expire_at // empty')"

# The signature belongs to the sign_evidence job of the same pipeline: the
# newest one (highest id), whatever its status, so one still in flight is seen.
# In flight is waited for, a bounded number of polls; failed or canceled is not.
polls=0
while :; do
  find_newest_job "${api}/pipelines/${rec_pipeline}/jobs" sign_evidence
  polls=$((polls + 1))
  where="pipeline ${rec_pipeline} (record_image job ${rec_job}, the build before this one on ${CI_COMMIT_REF_NAME})"
  [ -n "$found_job" ] ||
    fail "${where} has no successful sign_evidence job: retry its sign_evidence job, then run this job again"
  sign_status="$(printf '%s' "$found_job" | jq -r '.status // ""')"
  case "$sign_status" in
    success) break ;;
    created | pending | running | preparing | waiting_for_resource | scheduled)
      [ "$polls" -lt "$max_evidence_polls" ] ||
        fail "${where} has a sign_evidence job that is still running (status ${sign_status} after ${polls} polls ${poll_seconds}s apart): wait for it to finish, then run this job again"
      sleep "$poll_seconds"
      ;;
    *)
      fail "${where} has no successful sign_evidence job (its newest is ${sign_status:-of unknown status}): retry its sign_evidence job, then run this job again"
      ;;
  esac
done
sign_job="$(printf '%s' "$found_job" | jq -r '.id')"
sign_expires="$(printf '%s' "$found_job" | jq -r '.artifacts_expire_at // empty')"
[[ "$sign_job" =~ ^[0-9]+$ ]] || fail "the sign_evidence job found in pipeline ${rec_pipeline} has no readable job id"

fetch_artifact "$rec_job" "$manifest_name" "$stage/predecessor/$manifest_name" ||
  absent_artifact record_image "$rec_job" "$manifest_name" "$rec_expires"
digest_of "$stage/predecessor/$manifest_name" > /dev/null ||
  fail "the fetched manifest has no readable image digest"
fetch_artifact "$sign_job" "$sig_name" "$stage/predecessor/$sig_name" ||
  absent_artifact sign_evidence "$sign_job" "$sig_name" "$sign_expires"
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
