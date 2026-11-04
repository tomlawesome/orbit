#!/usr/bin/env bash
#
# Promotes a tested `preview` digest to a stable release (#821). GitLab is the
# source of truth, so the release itself is made here rather than on GitHub.
# This ports .github/workflows/promote-container.yml's "Resolve and verify
# tested preview" step and scripts/stable-promotion-policy.mjs's promote
# phase verbatim in spirit -- same inputs, same checks, same failure modes --
# onto GitLab: the accepted digest is the image main's own commit was
# published as, or an operator's PREVIEW_DIGEST when given (#1482) -- never a
# typed version; the version comes from the image itself, exactly as it
# always has -- and everything else is derived and verified from that.
#
# GHCR stays the public image source; the GitLab registry keeps only
# `:sha-*`/`:preview`. So this script retags ghcr.io/tomlawesome/orbit by
# digest with plain `docker`/`docker buildx imagetools` (no crane: GHCR is
# the only registry involved, and `docker` already does everything needed),
# then creates the matching annotated tag on GitLab. GitLab's push mirror
# carries the tag to GitHub, where .github/workflows/release-on-tag.yml turns
# it into a GitHub release -- GitHub does no judging of its own.
#
# The tested commit (#1640): the merge request's Merge button leaves `main` at
# a merge commit, a commit GitLab never built an image for. So the commit
# promoted is main's head when `:sha-<main head>` exists, else the merged-in
# (second) parent of a two-parent main head whose `:sha-<parent>` exists and
# whose tree is identical to main's -- the merge added nothing the tested
# commit did not already have. Anything else is refused. The digest, the
# evidence check and the GitLab tag all use that tested commit, and the tag
# message records the branch it was tested on for release-on-tag.yml.
#
# Called by the manual `promote_stable` job in .gitlab-ci.yml; see that job
# for when it may run and what it installs first. Kept as its own script
# rather than inline YAML so it can be unit tested against stub
# docker/git/curl (scripts/promote-stable.test.mjs).
#
# Usage:
#   scripts/ci/promote-stable.sh
#
# Inputs (environment):
#   CI_COMMIT_BRANCH       GitLab's predefined branch name. Must be `main`
#                          (#1564): the job's `rules:` already say so, and
#                          this refuses again so a later change to them cannot
#                          reopen a release button on a branch a Developer can
#                          push to.
#   CI_COMMIT_SHA          GitLab's predefined commit of this pipeline. With
#                          no PREVIEW_DIGEST it must be main's head (#1482),
#                          the merge commit's own pipeline (#1640).
#   PREVIEW_DIGEST         Optional (#1482). The accepted preview digest,
#                          "sha256:<64 hex>", set as a job variable by whoever
#                          runs the job. Unset or empty, the digest is the one
#                          :sha-<main's commit> resolves to on GHCR; either
#                          way :preview and :sha-<tested commit> must both
#                          resolve to it, and the evidence gate below must pass for it.
#   CI_API_V4_URL          GitLab's predefined API base URL, for the release
#                          tag created at the end.
#   CI_PROJECT_ID          GitLab's predefined numeric project id, for that
#                          same release-tag call.
#   CI_REGISTRY            GitLab's predefined registry hostname. Logged into
#                          with CI_REGISTRY_USER/CI_REGISTRY_PASSWORD (both
#                          predefined) so the evidence gate below can read the
#                          attestation cosign attached there.
#   CI_REGISTRY_USER,
#   CI_REGISTRY_PASSWORD   GitLab's predefined registry credentials, for the
#                          same login.
#   CI_REGISTRY_IMAGE      GitLab's predefined repository reference
#                          (CI_REGISTRY plus this project's path). The
#                          evidence gate verifies against this image, never
#                          against GHCR_IMAGE: sign_evidence attests beside
#                          the image here, and GHCR never receives that
#                          attestation -- the GitHub publish lane mints its
#                          own, differently-shaped one instead.
#   GHCR_PUBLISH_TOKEN     A masked CI/CD variable: a GHCR token scoped only
#                          to write:packages. Never printed or passed as a
#                          command-line argument -- piped to `docker login`
#                          on stdin.
#   GITLAB_RELEASE_TOKEN   A masked CI/CD variable: a project access token,
#                          Maintainer role, `api` scope, named
#                          `release-tagging`. Sent to curl as a header file,
#                          never a command-line argument or logged.
#   GHCR_IMAGE             Optional; default ghcr.io/tomlawesome/orbit.
#   GIT_REMOTE             Optional; default origin. The remote to read
#                          main/preview HEADs, existing tags and branch
#                          history from.
#   ORBIT_RELEASE_MANIFEST Optional (#1667). Path to the signed release manifest
#                          of the preview being promoted; its updateFrom must
#                          equal the newest stable tags, or promotion stops.
#                          Unset, the script downloads preview's newest
#                          record_image copy with GITLAB_RELEASE_TOKEN; if that
#                          fails, promotion stops. ORBIT_PROMOTE_SKIP_UPDATE_PATH=1
#                          skips the check (local runs and tests; CI never sets it).
#   PROMOTE_NODE           Optional; default node. The command this script
#                          uses to run scripts/calculate-version.mjs and
#                          scripts/stable-promotion-policy.mjs, overridable
#                          only so a test can point it at a wrapper; real use
#                          always takes the default.
#   PROMOTE_VERIFY_SCRIPT  Optional; default
#                          scripts/ci/verify-validation-evidence.sh. The
#                          shared verifier this runs against the digest
#                          before promoting (#877), overridable only so a
#                          test can point it at a stub; real use always takes
#                          the default.
set -Eeuo pipefail

# scripts/calculate-version.mjs and scripts/stable-promotion-policy.mjs are
# invoked below by their path relative to the repository root, so the repo
# root is where this runs from regardless of the caller's own cwd -- the same
# resolution scripts/ci/publish-image.sh uses.
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"
# shellcheck source=scripts/release-metadata-patterns.sh
source "${repo_root}/scripts/release-metadata-patterns.sh"
# shellcheck source=scripts/ci/lib-digest.sh
source "${repo_root}/scripts/ci/lib-digest.sh"

fail() { printf 'promote-stable: %s\n' "$1" >&2; exit 1; }

# Promoting to stable is for protected `main` only (#1564), where a manual job
# needs Maintainer rights. Before anything else, so nothing is read or called
# from a pipeline on any other branch, however it was started.
[[ "${CI_COMMIT_BRANCH:-}" == "main" ]] ||
  fail "stable promotion runs only on main (CI_COMMIT_BRANCH is '${CI_COMMIT_BRANCH:-}')"

: "${CI_API_V4_URL:?CI_API_V4_URL is not set; this script must run inside a GitLab CI job}"
: "${CI_PROJECT_ID:?CI_PROJECT_ID is not set; this script must run inside a GitLab CI job}"
: "${CI_REGISTRY:?CI_REGISTRY is not set; this script must run inside a GitLab CI job}"
: "${CI_REGISTRY_USER:?CI_REGISTRY_USER is not set; this script must run inside a GitLab CI job}"
: "${CI_REGISTRY_PASSWORD:?CI_REGISTRY_PASSWORD is not set; this script must run inside a GitLab CI job}"
: "${CI_REGISTRY_IMAGE:?CI_REGISTRY_IMAGE is not set; this script must run inside a GitLab CI job}"
: "${GHCR_PUBLISH_TOKEN:?GHCR_PUBLISH_TOKEN is not set. Create a GHCR token scoped only to write:packages and set it as a masked CI/CD variable (docs/releasing.md).}"
: "${GITLAB_RELEASE_TOKEN:?GITLAB_RELEASE_TOKEN is not set. Create a project access token (Maintainer, scope: api) named release-tagging and set it as a masked CI/CD variable (docs/releasing.md).}"

if [[ -n "${PREVIEW_DIGEST:-}" ]]; then
  [[ "$PREVIEW_DIGEST" =~ $ORBIT_DIGEST_PATTERN ]] ||
    fail "PREVIEW_DIGEST must be sha256 followed by 64 lowercase hexadecimal characters (got ${PREVIEW_DIGEST})"
fi

image="${GHCR_IMAGE:-ghcr.io/tomlawesome/orbit}"
remote="${GIT_REMOTE:-origin}"

run_node() { "${PROMOTE_NODE:-node}" "$@"; }

# The first Digest: line comes from lib-digest.sh, which reads to EOF rather
# than exiting early (the pipefail/SIGPIPE race) and works on a mawk without
# interval expressions; see there.
#
# A tag that does not exist makes `inspect` fail; under pipefail that would end
# the script with no message (#1482), so a missing tag resolves to nothing and
# the caller names it.
resolve_digest() {
  { docker buildx imagetools inspect "$1" 2> /dev/null || true; } |
    first_inspect_digest "$ORBIT_DIGEST_AWK_PATTERN"
}

main_head="$(git ls-remote "$remote" refs/heads/main | cut -f1)"
[[ -n "$main_head" ]] || fail "could not read main's HEAD from ${remote}"

# The tested commit (#1640): stable promotes what GitLab already built and
# tested, never a rebuild. That is main's head when an image exists for it;
# otherwise main's head must be a two-parent merge (the Merge button) whose
# second parent has the image and whose tree is identical to that parent's.
# An octopus merge or a single-parent main without an image is refused as
# having no published image.
tested_commit="$main_head"
if [[ -z "$(resolve_digest "${image}:sha-${main_head}")" ]]; then
  parents_line="$(git rev-list --parents -n 1 "$main_head")" ||
    fail "cannot read the parents of main's head ${main_head}; is it in this checkout?"
  read -r -a main_line <<< "$parents_line"
  if [[ "${#main_line[@]}" -eq 3 ]]; then
    second_parent="${main_line[2]}"
    if [[ -n "$(resolve_digest "${image}:sha-${second_parent}")" ]]; then
      git diff --quiet "${second_parent}^{tree}" "${main_head}^{tree}" ||
        fail "main (${main_head}) is a merge commit but its tree differs from the tested commit ${second_parent}'s tree"
      tested_commit="$second_parent"
      printf 'promote-stable: tested commit %s (main %s is its merge commit with an identical tree)\n' "$tested_commit" "$main_head"
    fi
  fi
fi

# The accepted digest must still be exactly what :preview names, and what the
# pipeline for the tested commit published as :sha-<commit> -- never a later
# push that moved :preview out from under this promotion, and never a digest
# that never reached the tested commit.
preview_ref="${image}:preview"
sha_ref="${image}:sha-${tested_commit}"
preview_resolved="$(resolve_digest "$preview_ref")"
sha_resolved="$(resolve_digest "$sha_ref")"
# With no digest given (#1482), the one the tested commit was published as is
# the accepted one: the button on main's pipeline is the acceptance, and the
# checks below and the evidence gate hold it to the same standard.
if [[ -n "${PREVIEW_DIGEST:-}" ]]; then
  printf 'promote-stable: digest from PREVIEW_DIGEST: %s\n' "$PREVIEW_DIGEST"
else
  # The button is pressed on one pipeline's page, but main's head is what is
  # promoted; with nothing typed, refuse a press on an older main pipeline so
  # the image promoted is the one whose pipeline the operator was looking at.
  [[ "${CI_COMMIT_SHA:-}" == "$main_head" ]] ||
    fail "this pipeline is for ${CI_COMMIT_SHA:-<unknown commit>}, but main is now ${main_head}; run promote_stable in main's newest pipeline, or set PREVIEW_DIGEST"
  [[ -n "$sha_resolved" ]] ||
    fail "${sha_ref} resolves to nothing; main's commit has no published image to promote"
  PREVIEW_DIGEST="$sha_resolved"
  printf 'promote-stable: digest from %s: %s\n' "$sha_ref" "$PREVIEW_DIGEST"
fi
[[ "$preview_resolved" == "$PREVIEW_DIGEST" ]] ||
  fail "${preview_ref} resolves to ${preview_resolved:-<nothing>}, not the accepted ${PREVIEW_DIGEST}"
[[ "$sha_resolved" == "$PREVIEW_DIGEST" ]] ||
  fail "${sha_ref} resolves to ${sha_resolved:-<nothing>}, not the accepted ${PREVIEW_DIGEST}"

# --- Resolve and verify tested preview (ported from promote-container.yml) --

docker buildx imagetools inspect "${image}@${PREVIEW_DIGEST}" > /dev/null
docker pull "${image}@${PREVIEW_DIGEST}"
revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}@${PREVIEW_DIGEST}")"
version="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "${image}@${PREVIEW_DIGEST}")"
release_stage="$(docker image inspect --format '{{ index .Config.Labels "io.github.tomlawesome.orbit.release-stage" }}' "${image}@${PREVIEW_DIGEST}")"
source_branch="$(docker image inspect --format '{{ index .Config.Labels "io.github.tomlawesome.orbit.source-branch" }}' "${image}@${PREVIEW_DIGEST}")"
embedded_version="$(docker run --rm --entrypoint cat "${image}@${PREVIEW_DIGEST}" /opt/orbit/VERSION)"
embedded_revision="$(docker run --rm --entrypoint cat "${image}@${PREVIEW_DIGEST}" /opt/orbit/REVISION)"
embedded_channel="$(docker run --rm --entrypoint cat "${image}@${PREVIEW_DIGEST}" /opt/orbit/CHANNEL)"
reported_version="$(docker run --rm "${image}@${PREVIEW_DIGEST}" --version)"

[[ "${embedded_version}" == "${version}" && "${reported_version}" == "Orbit ${version}" ]] ||
  fail "Embedded and reported versions do not match the image version label."
[[ "${embedded_revision}" == "${revision}" ]] ||
  fail "Embedded revision does not match the image revision label."
[[ "${embedded_channel}" == "${release_stage}" ]] ||
  fail "Embedded channel does not match the image release-stage label."

channel=preview
if [[ "${source_branch}" == hotfix/* ]]; then
  channel=hotfix
elif [[ "${source_branch}" != "preview" ]]; then
  fail "Preview source branch is not eligible for stable promotion."
fi

# --- Evidence gate: refuse to promote a digest whose validation evidence
# does not check out (#877) ---
#
# The shared cryptographic verifier #661 specified now exists
# (scripts/ci/verify-validation-evidence.sh), and every hop that gives a
# validated digest a consumer-visible name runs it before doing so --
# publish_channel (scripts/ci/publish-channel.sh) was first; this closes the
# gap #661's own spec (section 7) named as this issue's own follow-up
# (promote_stable staying unguarded). It refuses on all four grounds --
# mismatch, missing, ambiguous, expired -- against the committed cosign key
# (cosign.pub).
#
# This replaces the interim gate that ran here until now: gitlab-await-
# tested-image.sh plus a hand-written digest comparison. That gate's
# missing/expired checks and its partial mismatch check (commit, ref,
# pipeline, registry) are exactly what the verifier now proves
# cryptographically over the same four grounds, so running both would be two
# copies of one judgement. Removed entirely rather than kept alongside --
# #661's whole point is exactly one verifier, and this was the last caller
# still running a paraphrase of it. (The GitHub publish lane's own call to
# gitlab-await-tested-image.sh is unrelated and untouched: it fetches
# GitLab's transport record to learn *which* digest to copy, before any
# evidence exists to verify.)
#
# The attestation lives on registry.tomlawson.io, next to the image
# sign_evidence attested (CI_REGISTRY_IMAGE) -- never on GHCR, since the
# GitHub publish lane mints its own GitHub-native attestation instead of
# copying this one. So the verifier runs against CI_REGISTRY_IMAGE, not the
# GHCR_IMAGE this job otherwise promotes; the two are assumed to carry the
# exact same digest, which the :sha-<commit> and :preview identity checks
# above already rely on. CI_REGISTRY_USER/CI_REGISTRY_PASSWORD are
# predefined GitLab CI variables -- read access already implied by
# CI_REGISTRY, not a new credential -- so no CI/CD variable is added for
# this gate. (GITLAB_RELEASE_TOKEN is read again below, only to fetch the
# signed release manifest for the #1667 update-path check.)
echo "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" --username "$CI_REGISTRY_USER" --password-stdin

ORBIT_IMAGE="$CI_REGISTRY_IMAGE" \
ORBIT_DIGEST="$PREVIEW_DIGEST" \
ORBIT_COMMIT="$tested_commit" \
ORBIT_REF="$source_branch" \
  bash "${PROMOTE_VERIFY_SCRIPT:-${repo_root}/scripts/ci/verify-validation-evidence.sh}"

# The calculator reads stable Git tags, so tags must be fetched -- not just
# the branches merge-base needs below. `git fetch --no-tags` here would be
# the old workflow's branch-only fetch with exactly the wrong flag for this.
git fetch --tags "$remote" \
  "+refs/heads/main:refs/remotes/${remote}/main" \
  "+refs/heads/preview:refs/remotes/${remote}/preview" \
  "+refs/heads/hotfix/*:refs/remotes/${remote}/hotfix/*"

# The signed manifest's updateFrom (#1667) must still be the newest stable
# tags: a tag added or retracted since it was signed would make the installer
# refuse or allow the wrong updates. A gate fails closed: no manifest, no
# promotion, unless the run explicitly opts out.
if [[ "${ORBIT_PROMOTE_SKIP_UPDATE_PATH:-}" != "1" || -n "${ORBIT_RELEASE_MANIFEST:-}" ]]; then
  manifest_dir=""
  if [[ -z "${ORBIT_RELEASE_MANIFEST:-}" ]]; then
    # The newest record_image manifest on the branch the image was tested on;
    # it must name the digest being promoted, or it belongs to another build.
    manifest_dir="$(mktemp -d)"
    ORBIT_RELEASE_MANIFEST="${manifest_dir}/orbit-release-manifest.json"
    printf 'PRIVATE-TOKEN: %s\n' "$GITLAB_RELEASE_TOKEN" > "${manifest_dir}/header"
    # No --location (#1679 D-SEC1a): curl would send the PRIVATE-TOKEN
    # header on to whatever host a redirect named.
    curl --silent --show-error --fail --max-time 60 \
      --header @"${manifest_dir}/header" --output "$ORBIT_RELEASE_MANIFEST" \
      "${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}/jobs/artifacts/${source_branch//\//%2F}/raw/.orbit-supply-chain/orbit-release-manifest.json?job=record_image" ||
      ORBIT_RELEASE_MANIFEST=""
    rm -f "${manifest_dir}/header"
    [[ -n "$ORBIT_RELEASE_MANIFEST" ]] || {
      rm -rf "$manifest_dir"
      fail "could not download ${source_branch}'s signed release manifest, so the update-path cross-check (#1667) cannot run."
    }
    grep -qF "\"${PREVIEW_DIGEST}\"" "$ORBIT_RELEASE_MANIFEST" || {
      rm -rf "$manifest_dir"
      fail "${source_branch}'s newest release manifest is for another build than ${PREVIEW_DIGEST}; run record_image again on the current ${source_branch}"
    }
  fi
  update_path_ok=1
  run_node scripts/ci/upgrade-versions.mjs --check-update-from "$ORBIT_RELEASE_MANIFEST" || update_path_ok=0
  [[ -z "$manifest_dir" ]] || rm -rf "$manifest_dir"
  ((update_path_ok)) ||
    fail "the release manifest's updateFrom does not match the stable tags; run record_image again on the current ${source_branch}"
fi

expected_version="$(run_node scripts/calculate-version.mjs --channel "${channel}")"
[[ "${version}" == "${expected_version}" ]] ||
  fail "Embedded version ${version} does not match calculated version ${expected_version}."

if git ls-remote --exit-code --tags "$remote" "refs/tags/${version}" > /dev/null 2>&1; then
  fail "tag ${version} already exists on GitLab; refusing to overwrite a shipped release"
fi

ORBIT_PROMOTION_PHASE=promote \
ORBIT_PREVIEW_DIGEST="${PREVIEW_DIGEST}" \
ORBIT_STABLE_VERSION="${version}" \
ORBIT_PREVIEW_STAGE="${release_stage}" \
ORBIT_PREVIEW_REVISION="${revision}" \
ORBIT_PREVIEW_SOURCE_BRANCH="${source_branch}" \
  run_node scripts/stable-promotion-policy.mjs

# Refuse if the version tag already exists in GHCR -- belt and braces beside
# the GitLab tag check above, since GHCR and GitLab are two registries that
# could disagree about what has already shipped. The one exception: the tag
# already holds the exact digest being promoted, so a rerun after a failure
# between the GHCR tags and the GitLab tag can finish the job.
resuming=false
if docker buildx imagetools inspect "${image}:${version}" > /dev/null 2>&1; then
  if [[ "$(resolve_digest "${image}:${version}")" == "${PREVIEW_DIGEST}" ]]; then
    printf 'promote-stable: %s:%s already tagged at this digest; resuming the promotion\n' "$image" "$version"
    resuming=true
  else
    fail "${image}:${version} already exists in GHCR; refusing to overwrite a shipped release"
  fi
fi

# --- Promote exact preview digest to latest (ported from promote-container.yml) --

# Nothing to write to GHCR when resuming: the tags are already in place.
if [[ "${resuming}" == false ]]; then
  # A token that can only publish, piped on stdin so it never appears in argv
  # or a process listing.
  printf '%s' "$GHCR_PUBLISH_TOKEN" | docker login ghcr.io -u tomlawesome --password-stdin

  # `:latest`, not `:stable`: install.sh defaults ORBIT_CHANNEL to latest.
  # --prefer-index=false copies the tested manifest as it is. By default buildx
  # wraps a single-manifest source in a new, unsigned OCI index with a new
  # digest (#1179); the check below would catch that, but only after the tags
  # had moved.
  docker buildx imagetools create \
    --prefer-index=false \
    --tag "${image}:${version}" \
    --tag "${image}:latest" \
    "${image}@${PREVIEW_DIGEST}"
fi

for tag in "${version}" latest; do
  promoted="$(resolve_digest "${image}:${tag}")"
  [[ "${promoted}" == "${PREVIEW_DIGEST}" ]] ||
    fail "${image}:${tag} did not retain the tested digest (got ${promoted:-<nothing>})"
done

# Create the annotated GitLab tag naming the exact digest that was promoted,
# so the release note records what actually shipped. The push mirror carries
# the tag to GitHub; release-on-tag.yml there turns it into a GitHub release.
header_file="$(mktemp)"
trap 'rm -f "$header_file"' EXIT
printf 'PRIVATE-TOKEN: %s\n' "$GITLAB_RELEASE_TOKEN" > "$header_file"
# The last line tells release-on-tag.yml which branch's pipeline holds the
# launcher, manifest and signature to attach (#1640).
message="$(printf 'Orbit %s\n\nContainer digest: %s\nTested on: %s\n' "$version" "$PREVIEW_DIGEST" "$source_branch")"
curl --silent --show-error --fail --location --max-time 60 \
  --header @"$header_file" \
  --data-urlencode "tag_name=${version}" \
  --data-urlencode "ref=${tested_commit}" \
  --data-urlencode "message=${message}" \
  "${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}/repository/tags" > /dev/null

printf 'promote-stable: tagged %s and latest at %s; created GitLab tag %s\n' "$version" "$PREVIEW_DIGEST" "$version"
