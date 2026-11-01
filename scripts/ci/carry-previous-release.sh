#!/usr/bin/env bash
#
# Saves the build before this one: its signed release manifest and the
# manifest's signature, under .orbit-supply-chain/previous/ (#1480), so a
# later consumer -- the launcher's live update test (ai/orbit-launcher#263) --
# can find the previous preview build by branch, with no job IDs. Pinned job
# IDs would break once their artifacts expire, and a job token cannot list
# this project's pipelines.
#
# Called by the record_image job in .gitlab-ci.yml after the image is
# published, beside scripts/ci/write-release-manifest.sh. "The build before"
# is the latest successful pipeline on the same branch, read with GitLab's
# latest-artifacts-by-ref endpoint: the manifest from record_image and the
# signature from sign_evidence. The two are separate lookups, and another
# pipeline can finish between them, so the manifest is fetched again after
# the signature and the pair is kept only if both copies are identical.
#
# On a rebuild of the same image (the fetched manifest names the digest being
# recorded) the fetched build's own previous/ pair is carried forward
# instead, so previous/ never points at itself.
#
# Either way the pair is verified against cosign.pub
# (scripts/ci/verify-release-manifest.sh) before it is kept: a tag named
# like the branch can answer the by-ref lookup, so the fetch alone proves
# nothing.
#
# A fail-loud, idempotent carry (#1607 D-F1-1, D-F2-1, D-F5). A missing or
# mismatched predecessor is an error that names its cause, never a silent
# skip: the script prints "carry-previous-release: FAILED: <cause>" on stderr,
# writes nothing under previous/ and exits 1 (a usage error exits 2). So the
# publish job fails with it. Running it again on the same inputs gives the
# same result, and the manifest and signature it saves always come from one
# build: they are fetched as a pair, the manifest is fetched again to prove
# the latest build did not change in between, and the pair must verify.
#
# The one pass-through is a ref's very first release, which has no
# predecessor and cannot be told from a lookup that found nothing. It passes
# only when ORBIT_CARRY_NO_PREDECESSOR is set to a non-empty reason, set for
# that pipeline run (docs/releasing.md); the run logs the variable and the
# reason, saves nothing and exits 0. The override covers only "nothing was
# found" (a manifest or signature that could not be fetched). A predecessor
# that was found and is bad (a mismatch, a changed build, a malformed digest,
# a failed verification) still fails with the override set.
#
# Usage:
#   scripts/ci/carry-previous-release.sh <current-image-digest>
#
# Inputs (environment, all set by GitLab CI):
#   CI_API_V4_URL      API root, e.g. https://gitlab.example/api/v4.
#   CI_PROJECT_ID      Numeric project ID.
#   CI_COMMIT_REF_NAME The branch whose previous build is wanted.
#   CI_JOB_TOKEN       Sent as a JOB-TOKEN header read from a mode-600 temp
#                      file (curl -H @file), so it is never in argv or the
#                      log.
# Input (environment, set per pipeline run, optional):
#   ORBIT_CARRY_NO_PREDECESSOR  A non-empty reason, for a ref's very first
#                      release only. Unset or empty means fail loud.
#
# Needs curl and jq, plus what the verifier needs: openssl, and curl to fetch
# the pinned cosign (scripts/ci/ensure-cosign.sh) unless ORBIT_COSIGN is set.

set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <current-image-digest>" >&2
  exit 2
fi
current_digest="$1"
verifier="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/verify-release-manifest.sh"

dest=".orbit-supply-chain/previous"
manifest_name="orbit-release-manifest.json"
sig_name="orbit-release-manifest.json.sig"

header_file=""
stage=""
cleanup() {
  [ -z "$header_file" ] || rm -f -- "$header_file"
  [ -z "$stage" ] || rm -rf -- "$stage"
}
trap cleanup EXIT

# fail <cause>: the carry cannot be trusted or finished. Names the cause,
# exits 1 (the cleanup trap removes the staging dir and the header file).
fail() {
  echo "carry-previous-release: FAILED: $1" >&2
  exit 1
}

# not_found <cause>: no predecessor was found. Fails loud unless the pipeline
# run declared a first release with ORBIT_CARRY_NO_PREDECESSOR=<reason>; then
# it logs the variable and the reason and passes, saving nothing. Never used
# for a predecessor that was found and is bad: that is always fail.
not_found() {
  local reason
  reason="$(printf '%s' "${ORBIT_CARRY_NO_PREDECESSOR:-}" | tr -d '[:cntrl:]')"
  if [ -n "$reason" ]; then
    echo "carry-previous-release: ORBIT_CARRY_NO_PREDECESSOR is set (reason: ${reason}); passing with no predecessor, nothing saved under ${dest}/. Not found: $1"
    exit 0
  fi
  fail "no predecessor on ${CI_COMMIT_REF_NAME:-this ref}: $1. If this is the ref's very first release, set ORBIT_CARRY_NO_PREDECESSOR to a reason for this pipeline run (docs/releasing.md); otherwise fix the cause and re-run."
}

# Everything below needs the environment; a CI misconfiguration is a failure.
for var in CI_API_V4_URL CI_PROJECT_ID CI_COMMIT_REF_NAME CI_JOB_TOKEN; do
  [ -n "${!var:-}" ] || fail "$var is not set"
done

# The token goes to curl through a header file made outside the working
# directory, readable only by us, and removed on exit (trap above).
umask 077
header_file="$(mktemp "${TMPDIR:-/tmp}/carry-previous-header.XXXXXX")"
printf 'JOB-TOKEN: %s\n' "$CI_JOB_TOKEN" > "$header_file"

ref="$(jq -rn --arg ref "$CI_COMMIT_REF_NAME" '$ref | @uri')"
base="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/jobs/artifacts/${ref}/raw/.orbit-supply-chain"

# Staged inside .orbit-supply-chain so the final rename stays on one
# filesystem and is atomic: previous/ is either absent or complete.
mkdir -p .orbit-supply-chain
stage="$(mktemp -d .orbit-supply-chain/.previous-stage.XXXXXX)"

# fetch <path under .orbit-supply-chain> <job> <output file>
# curl's own error (e.g. a 404 or 403) stays on stderr so a missing previous/
# can be told apart from a refused token; it names the URL, never the token.
fetch() {
  # No --location: these URLs answer directly, and curl would send the
  # JOB-TOKEN header on to whatever host a redirect named.
  curl --fail --silent --show-error \
    --retry 2 --retry-delay 2 --connect-timeout 10 --max-time 30 \
    -H "@${header_file}" \
    --output "$3" \
    "${base}/${1}?job=${2}"
}

# digest_of <manifest file>: prints .image.digest; fails unless the whole
# string is sha256:<64 lowercase hex>.
digest_of() {
  jq -er '.image.digest | select(type == "string" and test("\\Asha256:[0-9a-f]{64}\\z"))' "$1" 2> /dev/null
}

# changed_check <first manifest file>: the latest build must still be the one whose
# manifest was fetched first, else a later download may belong to another
# build.
changed_check() {
  fetch "$manifest_name" record_image "$stage/recheck.json" ||
    fail "could not fetch the manifest again from job record_image, so the manifest and signature cannot be shown to come from one build"
  cmp -s "$1" "$stage/recheck.json" ||
    fail "the latest build on ${CI_COMMIT_REF_NAME} changed while fetching (a different build's manifest answered the second download), so the manifest and signature may not match"
}

fetch "$manifest_name" record_image "$stage/fetched.json" ||
  not_found "the latest successful pipeline on ${CI_COMMIT_REF_NAME} has no manifest from job record_image (a pipeline started by a schedule or by hand runs no record_image, or this is the ref's first release)"
fetched_digest="$(digest_of "$stage/fetched.json")" ||
  fail "the fetched manifest has no readable image digest"

if [ "$fetched_digest" = "$current_digest" ]; then
  # Rebuild of the image being recorded: the previous build is whatever that
  # build itself carried.
  fetch "previous/$manifest_name" record_image "$stage/$manifest_name" ||
    not_found "rebuild of ${current_digest} and the build being rebuilt has no carried manifest (previous/$manifest_name from job record_image)"
  fetch "previous/$sig_name" record_image "$stage/$sig_name" ||
    not_found "rebuild of ${current_digest} and the build being rebuilt has a carried manifest but no carried signature (previous/$sig_name from job record_image)"
  changed_check "$stage/fetched.json"
  fetched_digest="$(digest_of "$stage/$manifest_name")" ||
    fail "the carried manifest has no readable image digest"
  [ "$fetched_digest" != "$current_digest" ] ||
    fail "the carried manifest names the current digest ${current_digest} too, so previous/ would point at itself"
else
  cp -- "$stage/fetched.json" "$stage/$manifest_name"
  fetch "$sig_name" sign_evidence "$stage/$sig_name" ||
    not_found "the latest build on ${CI_COMMIT_REF_NAME} has a manifest but no signature from job sign_evidence"
  changed_check "$stage/$manifest_name"
fi
rm -f -- "$stage/fetched.json" "$stage/recheck.json"

# The verifier cds to the repository root, so it gets absolute paths. It
# never needs the job token, so it never gets it.
stage_abs="$(pwd -P)/$stage"
env -u CI_JOB_TOKEN bash "$verifier" "$stage_abs/$manifest_name" "$stage_abs/$sig_name" ||
  fail "the previous build's manifest does not verify against cosign.pub (its manifest and signature may come from different builds)"

# Both files are good: move them into place in one rename.
rm -rf -- "$dest"
mv -T -- "$stage" "$dest"
stage=""
chmod 755 "$dest"
echo "carry-previous-release: previous build on ${CI_COMMIT_REF_NAME} is ${fetched_digest}; saved to ${dest}/"
