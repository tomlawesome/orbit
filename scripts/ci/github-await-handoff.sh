#!/usr/bin/env bash
#
# GitHub's half of the release handoff (#1824): waits for the published
# release handoff-<commit> that GitLab's handoff_to_github job fills and
# publishes (github-upload-handoff.sh) in the separate public handoff
# repository (GITHUB_HANDOFF_REPO, <owner>/orbit-handoff), downloads what this run needs from it, checks
# every file against handoff-complete.json, and checks GitLab's evidence
# against what this run knows on its own. It talks to GitHub's API only, and
# only reads (GET): no GitHub workflow connects to GitLab or writes to the
# handoff repository.
#
# The release is a carrier and is not trusted. These checks keep a wrong or
# half-finished handoff from being acted on; the trust decision is the
# cryptographic one the caller makes next, with
# scripts/ci/verify-validation-evidence.sh and the committed cosign.pub.
#
# It refuses, rather than guessing, when:
#   - no published handoff-<commit> with a handoff-complete.json appears
#     within the wait budget (it polls until then, printing a line each
#     time). A draft is not there: GitLab publishes only once every file is up;
#   - more than one published release has that name;
#   - handoff-complete.json is not for this commit, or a file this run needs
#     is not listed in it, is not on the release, or differs from its listed
#     sha256 or size;
#   - the evidence names another commit, ref or pipeline, is malformed,
#     points outside GitLab's registry, or is older than seven days;
#   - the SBOM is not an SPDX document.
#
# Inputs (environment):
#   GH_TOKEN            the run's own read-only token: the handoff repository
#                       is public, so reading it needs no write access
#                       (#1107, 21a); never printed
#   GITHUB_HANDOFF_REPO owner/name of the handoff repository; GITHUB_REPOSITORY
#                       is never read
#   GITHUB_API_URL      optional; default https://api.github.com
#   GITLAB_REGISTRY     optional; the registry host the evidence must point
#                       into, default GitLab's own. Compared as text only,
#                       never contacted.
#   ORBIT_COMMIT        the commit being published (GITHUB_SHA)
#   ORBIT_REF           the branch it was tested on
#   ORBIT_WAIT_MINUTES  optional; how long to wait for the handoff, default 120
#   ORBIT_POLL_SECONDS  optional; seconds between polls, default 60
#   ORBIT_EVIDENCE_DIR  optional; where to write the files, default
#                       .orbit-supply-chain
#   ORBIT_FETCH_IMAGE   optional; "1" also downloads orbit-image.oci.tar
#   ORBIT_FETCH_LAUNCHER_ASSETS
#                       optional; "1" also downloads the signed release
#                       manifest, its .sig and the two launcher archives
#                       (ADR-0031 #8/#9)
#
# Outputs (appended to $GITHUB_OUTPUT when set, and only once every check has
# passed): digest, source_reference, pipeline_url, evidence, sbom; with
# ORBIT_FETCH_IMAGE=1, image_archive; with ORBIT_FETCH_LAUNCHER_ASSETS=1,
# release_manifest, release_manifest_sig, launcher_amd64_archive,
# launcher_arm64_archive.
set -Eeuo pipefail

fail() { printf 'github-await-handoff: %s\n' "$1" >&2; exit 1; }

# shellcheck source=scripts/release-metadata-patterns.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../release-metadata-patterns.sh"
# shellcheck source=scripts/ci/lib-github-handoff.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib-github-handoff.sh"

readonly COMPLETE=handoff-complete.json
readonly EVIDENCE=gitlab-tested-image.json
readonly SBOM=image.spdx.json
readonly IMAGE=orbit-image.oci.tar

: "${GH_TOKEN:?a GitHub token that can read the handoff repository is required}"
: "${ORBIT_COMMIT:?the commit to publish is required}"
: "${ORBIT_REF:?the tested ref is required}"
# The name GitLab's registry goes by in the evidence. Only compared with the
# evidence below: nothing here connects to it.
registry="${GITLAB_REGISTRY:-registry.tomlawson.io}"

[[ "$ORBIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "ORBIT_COMMIT is not an exact commit SHA: ${ORBIT_COMMIT}"
[[ "$ORBIT_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "ORBIT_REF is not a plain ref name: ${ORBIT_REF}"
[[ "$registry" =~ ^[A-Za-z0-9._-]+(:[0-9]+)?$ ]] || fail "GITLAB_REGISTRY is not a registry host: ${registry}"

wait_minutes="${ORBIT_WAIT_MINUTES:-120}"
[[ "$wait_minutes" =~ ^[0-9]+$ ]] || fail "ORBIT_WAIT_MINUTES is not a whole number: ${wait_minutes}"
poll_seconds="${ORBIT_POLL_SECONDS:-60}"
[[ "$poll_seconds" =~ ^[0-9]+$ ]] || fail "ORBIT_POLL_SECONDS is not a whole number: ${poll_seconds}"
evidence_dir="${ORBIT_EVIDENCE_DIR:-.orbit-supply-chain}"
fetch_image="${ORBIT_FETCH_IMAGE:-}"
fetch_launcher="${ORBIT_FETCH_LAUNCHER_ASSETS:-}"

wanted=("$EVIDENCE" "$SBOM")
if [[ "$fetch_image" == 1 ]]; then wanted+=("$IMAGE"); fi
launcher=(orbit-release-manifest.json orbit-release-manifest.json.sig
  orbit-launcher_linux_amd64.tar.gz orbit-launcher_linux_arm64.tar.gz)
if [[ "$fetch_launcher" == 1 ]]; then wanted+=("${launcher[@]}"); fi

gh_init "$GH_TOKEN"
tag="handoff-${ORBIT_COMMIT}"

# Poll until the release is published and carries handoff-complete.json, which
# GitLab uploads last. A draft is ignored: a read-only token is not shown one
# anyway, and GitLab publishes only once every file is up.
deadline=$((SECONDS + wait_minutes * 60))
while :; do
  mine="$(gh_releases | awk -F '\t' -v tag="$tag" '$2 == tag && $3 == "false"')"
  found="$(grep -c . <<< "$mine" || :)"
  ((found <= 1)) || fail "${found} published releases are named ${tag}; refusing to pick one"
  if ((found == 1)); then
    release_id="$(cut -f1 <<< "$mine")"
    [[ "$release_id" =~ ^[0-9]+$ ]] || fail "GitHub gave no release id for ${tag}"
    assets="$(gh_assets "$release_id")"
    awk -F '\t' -v c="$COMPLETE" '$2 == c { found = 1 } END { exit !found }' <<< "$assets" && break
    waiting="${tag} has no ${COMPLETE} yet"
  else
    waiting="no published ${tag} in ${gh_repo} yet"
  fi
  if ((SECONDS >= deadline)); then
    fail "gave up after ${wait_minutes} minutes: ${waiting}. GitLab's handoff_to_github job for ${ORBIT_COMMIT} uploads it last; if that job failed, retry it on GitLab, then re-run this with \`gh run rerun <id> --failed\`"
  fi
  printf 'Waiting: %s.\n' "$waiting"
  sleep "$poll_seconds"
done
printf 'Found %s with %s.\n' "$tag" "$COMPLETE"

asset_id() { awk -F '\t' -v n="$1" '$2 == n { print $1; exit }' <<< "$assets"; }

# Downloads one asset by its API URL, so every request goes to GitHub's API
# for the handoff repository. GitHub answers with a redirect to its storage host;
# curl drops the Authorization header when it follows a redirect to another
# host, so the token goes to GitHub's API only.
download() { # $1 asset name, $2 destination
  local id
  id="$(asset_id "$1")"
  [[ "$id" =~ ^[0-9]+$ ]] || fail "$1 is listed in ${COMPLETE} but is not on ${tag}"
  gh_curl --location --max-time 1800 --retry 2 --retry-delay 3 \
    --header 'Accept: application/octet-stream' \
    --output "$2" "${gh_api}/repos/${gh_repo}/releases/assets/${id}" ||
    fail "could not download $1 from ${tag}"
}

download "$COMPLETE" "${gh_tmp}/${COMPLETE}"
complete="${gh_tmp}/${COMPLETE}"
[[ "$(json 'typeof input === "object" && input !== null && !Array.isArray(input) && Array.isArray(input.assets)' < "$complete" || :)" == true ]] ||
  fail "${COMPLETE} is not a JSON object with an assets list"
listed_commit="$(json 'input.commit' < "$complete")"
[[ "$listed_commit" == "$ORBIT_COMMIT" ]] || fail "${COMPLETE} is for commit ${listed_commit:-<missing>}, not ${ORBIT_COMMIT}"
pipeline_url="$(json 'input.pipelineUrl' < "$complete")"
[[ "$pipeline_url" =~ ^https://[A-Za-z0-9._:/-]+/pipelines/([0-9]+)$ ]] ||
  fail "${COMPLETE} names no GitLab pipeline URL: ${pipeline_url:-<missing>}"
handoff_pipeline="${BASH_REMATCH[1]}"

# Each wanted file: listed once, on the release, and the same bytes as listed.
# Downloaded beside its final name and moved there only once it checks out.
mkdir -p "$evidence_dir"
for name in "${wanted[@]}"; do
  # shellcheck disable=SC2016 # a JavaScript template literal, not shell
  entry="$(json 'input.assets.filter((a) => a && a.name === arg).map((a) => `${a.sha256} ${a.size}`)' "$name" < "$complete")"
  [[ -n "$entry" ]] || fail "${COMPLETE} does not list ${name}"
  [[ "$entry" != *$'\n'* ]] || fail "${COMPLETE} lists ${name} more than once"
  read -r want_sha want_size <<< "$entry"
  [[ "$want_sha" =~ ^[0-9a-f]{64}$ && "$want_size" =~ ^[0-9]+$ ]] || fail "${COMPLETE} lists ${name} without a sha256 and size"
  partial="${evidence_dir}/${name}.partial"
  download "$name" "$partial"
  got_sha="$(sha256sum < "$partial" | cut -d' ' -f1)"
  got_size="$(stat -c %s "$partial")"
  if [[ "$got_sha" != "$want_sha" || "$got_size" != "$want_size" ]]; then
    rm -f "$partial"
    fail "${name} on ${tag} is not the file GitLab listed (sha256 ${got_sha}, ${got_size} bytes; listed ${want_sha}, ${want_size} bytes)"
  fi
  mv -f "$partial" "${evidence_dir}/${name}"
done

# Every field the publisher will act on, checked against what this run knows
# independently.
evidence="${evidence_dir}/${EVIDENCE}"
sbom="${evidence_dir}/${SBOM}"
[[ "$(json 'typeof input === "object" && input !== null && !Array.isArray(input)' < "$evidence" || :)" == true ]] ||
  fail "${EVIDENCE} is not a JSON object"
field() { json 'input[arg]' "$1" < "$evidence"; }
recorded_commit="$(field commit)"
recorded_ref="$(field ref)"
recorded_pipeline="$(field pipelineId)"
digest="$(field imageDigest)"
source_reference="$(field imageReference)"
recorded_at="$(field recordedAt)"

[[ "$recorded_commit" == "$ORBIT_COMMIT" ]] || fail "evidence is for commit ${recorded_commit:-<missing>}, not ${ORBIT_COMMIT}"
[[ "$recorded_ref" == "$ORBIT_REF" ]] || fail "evidence is for ref ${recorded_ref:-<missing>}, not ${ORBIT_REF}"
[[ "$recorded_pipeline" == "$handoff_pipeline" ]] ||
  fail "evidence names pipeline ${recorded_pipeline:-<missing>}, but the handoff came from pipeline ${handoff_pipeline}"
[[ "$digest" =~ $ORBIT_DIGEST_PATTERN ]] || fail "evidence digest is not an immutable manifest digest: ${digest:-<missing>}"
[[ "$source_reference" == "${registry}/"*"@${digest}" && "$source_reference" =~ $ORBIT_REGISTRY_REFERENCE_PATTERN ]] ||
  fail "evidence image reference ${source_reference:-<missing>} is not ${registry}/...@${digest}"
[[ "$recorded_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  fail "evidence recordedAt is not a UTC timestamp: ${recorded_at:-<missing>}"
recorded_epoch="$(date -u -d "$recorded_at" +%s)"
now_epoch="$(date -u +%s)"
((now_epoch - recorded_epoch <= 7 * 24 * 3600)) || fail "evidence recorded at ${recorded_at} is older than seven days"
((recorded_epoch <= now_epoch + 300)) || fail "evidence recorded at ${recorded_at} is in the future"

[[ -n "$(json 'input.spdxVersion ?? input.SPDXID' < "$sbom" || :)" ]] || fail "${SBOM} is not an SPDX document"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'digest=%s\n' "$digest"
    printf 'source_reference=%s\n' "$source_reference"
    printf 'pipeline_url=%s\n' "$pipeline_url"
    printf 'evidence=%s\n' "$evidence"
    printf 'sbom=%s\n' "$sbom"
    if [[ "$fetch_image" == 1 ]]; then
      printf 'image_archive=%s\n' "${evidence_dir}/${IMAGE}"
    fi
    if [[ "$fetch_launcher" == 1 ]]; then
      printf 'release_manifest=%s\n' "${evidence_dir}/${launcher[0]}"
      printf 'release_manifest_sig=%s\n' "${evidence_dir}/${launcher[1]}"
      printf 'launcher_amd64_archive=%s\n' "${evidence_dir}/${launcher[2]}"
      printf 'launcher_arm64_archive=%s\n' "${evidence_dir}/${launcher[3]}"
    fi
  } >> "$GITHUB_OUTPUT"
fi
printf 'github-await-handoff: %s tested as %s (%s)\n' "$ORBIT_COMMIT" "$source_reference" "$pipeline_url"
