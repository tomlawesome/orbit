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
# signature from sign_evidence. A successful pipeline has both jobs, so the
# pair always comes from one build.
#
# On a rebuild of the same image (the fetched manifest names the digest being
# recorded) the fetched build's own previous/ pair is carried forward
# instead, so previous/ never points at itself.
#
# This step never fails the publish: anything it cannot fetch or trust (first
# build on a branch, a network failure, a malformed manifest, a missing
# signature) prints "no predecessor on this ref" with the reason, writes
# nothing and exits 0. Only a usage error exits non-zero (2).
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
# Needs curl and jq.

set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <current-image-digest>" >&2
  exit 2
fi
current_digest="$1"

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
  curl --fail --silent --show-error --location \
    --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 60 \
    -H "@${header_file}" \
    --output "$3" \
    "${base}/${1}?job=${2}"
}

# digest_of <manifest file>: prints .image.digest; fails unless it is a string.
digest_of() {
  jq -er 'if (.image.digest | type) == "string" and .image.digest != "" then .image.digest else empty end' "$1" 2> /dev/null
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
fi
rm -f -- "$stage/fetched.json"

# Both files are good: move them into place in one rename.
rm -rf -- "$dest"
mv -T -- "$stage" "$dest"
stage=""
chmod 755 "$dest"
echo "carry-previous-release: previous build on ${CI_COMMIT_REF_NAME} is ${fetched_digest}; saved to ${dest}/"
