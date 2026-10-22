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
# This step never fails the publish: anything it cannot fetch or trust (first
# build on a branch, a network failure, a malformed manifest, a missing
# signature, a pair that does not verify) prints "no predecessor on this
# ref" with the reason, writes nothing and exits 0. Only a usage error exits
# non-zero (2).
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

no_predecessor() {
  echo "carry-previous-release: no predecessor on this ref: $1"
  exit 0
}

# Everything below needs the environment; a CI misconfiguration is still "no
# predecessor", not a failed publish.
for var in CI_API_V4_URL CI_PROJECT_ID CI_COMMIT_REF_NAME CI_JOB_TOKEN; do
  [ -n "${!var:-}" ] || no_predecessor "$var is not set"
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

fetch "$manifest_name" record_image "$stage/fetched.json" ||
  no_predecessor "could not fetch the manifest from job record_image"
fetched_digest="$(digest_of "$stage/fetched.json")" ||
  no_predecessor "the fetched manifest has no readable image digest"

if [ "$fetched_digest" = "$current_digest" ]; then
  # Rebuild of the image being recorded: the previous build is whatever that
  # build itself carried.
  fetch "previous/$manifest_name" record_image "$stage/$manifest_name" ||
    no_predecessor "rebuild of ${current_digest} and no carried manifest"
  fetch "previous/$sig_name" record_image "$stage/$sig_name" ||
    no_predecessor "rebuild of ${current_digest} and no carried signature"
  fetched_digest="$(digest_of "$stage/$manifest_name")" ||
    no_predecessor "the carried manifest has no readable image digest"
  [ "$fetched_digest" != "$current_digest" ] ||
    no_predecessor "the carried manifest names the current digest too"
else
  mv -- "$stage/fetched.json" "$stage/$manifest_name"
  fetch "$sig_name" sign_evidence "$stage/$sig_name" ||
    no_predecessor "could not fetch the signature from job sign_evidence"
  fetch "$manifest_name" record_image "$stage/recheck.json" ||
    no_predecessor "could not fetch the manifest again from job record_image"
  cmp -s "$stage/$manifest_name" "$stage/recheck.json" ||
    no_predecessor "the latest build changed while fetching; its manifest and signature may not match"
fi
rm -f -- "$stage/fetched.json" "$stage/recheck.json"

# The verifier cds to the repository root, so it gets absolute paths. It
# never needs the job token, so it never gets it.
stage_abs="$(pwd -P)/$stage"
env -u CI_JOB_TOKEN bash "$verifier" "$stage_abs/$manifest_name" "$stage_abs/$sig_name" ||
  no_predecessor "the previous build's manifest does not verify against cosign.pub"

# Both files are good: move them into place in one rename.
rm -rf -- "$dest"
mv -T -- "$stage" "$dest"
stage=""
chmod 755 "$dest"
echo "carry-previous-release: previous build on ${CI_COMMIT_REF_NAME} is ${fetched_digest}; saved to ${dest}/"
