#!/usr/bin/env bash
#
# Promotes a tested `preview` digest to a stable release (#821). GitLab is the
# source of truth, so the release itself is made here rather than on GitHub.
# This ports .github/workflows/promote-container.yml's "Resolve and verify
# tested preview" step and scripts/stable-promotion-policy.mjs's promote
# phase verbatim in spirit -- same inputs, same checks, same failure modes --
# onto GitLab: an operator supplies the accepted PREVIEW_DIGEST (not a typed
# version; the version comes from the image itself, exactly as it always
# has), and everything else is derived and verified from that.
#
# GHCR stays the public image source; the GitLab registry keeps only
# `:sha-*`/`:preview`. So this script retags ghcr.io/tomlawesome/orbit by
# digest with plain `docker`/`docker buildx imagetools` (no crane: GHCR is
# the only registry involved, and `docker` already does everything needed),
# then creates the matching annotated tag on GitLab. GitLab's push mirror
# carries the tag to GitHub, where .github/workflows/release-on-tag.yml turns
# it into a GitHub release -- GitHub does no judging of its own.
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
#   PREVIEW_DIGEST         The accepted preview digest, "sha256:<64 hex>". A
#                          GitLab pipeline variable set by whoever runs the
#                          job -- the same input promote-container.yml's
#                          workflow_dispatch took.
#   CI_API_V4_URL          GitLab's predefined API base URL.
#   CI_PROJECT_ID          GitLab's predefined numeric project id.
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
#   PROMOTE_NODE           Optional; default node. The command this script
#                          uses to run scripts/calculate-version.mjs and
#                          scripts/stable-promotion-policy.mjs, overridable
#                          only so a test can point it at a wrapper; real use
#                          always takes the default.
set -Eeuo pipefail

# scripts/calculate-version.mjs and scripts/stable-promotion-policy.mjs are
# invoked below by their path relative to the repository root, so the repo
# root is where this runs from regardless of the caller's own cwd -- the same
# resolution scripts/ci/publish-image.sh uses.
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'promote-stable: %s\n' "$1" >&2; exit 1; }

: "${PREVIEW_DIGEST:?PREVIEW_DIGEST is required: the accepted preview digest, sha256:<64 hex>}"
: "${CI_API_V4_URL:?CI_API_V4_URL is not set; this script must run inside a GitLab CI job}"
: "${CI_PROJECT_ID:?CI_PROJECT_ID is not set; this script must run inside a GitLab CI job}"
: "${GHCR_PUBLISH_TOKEN:?GHCR_PUBLISH_TOKEN is not set. Create a GHCR token scoped only to write:packages and set it as a masked CI/CD variable (docs/releasing.md).}"
: "${GITLAB_RELEASE_TOKEN:?GITLAB_RELEASE_TOKEN is not set. Create a project access token (Maintainer, scope: api) named release-tagging and set it as a masked CI/CD variable (docs/releasing.md).}"

[[ "$PREVIEW_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "PREVIEW_DIGEST must be sha256 followed by 64 lowercase hexadecimal characters (got ${PREVIEW_DIGEST})"

image="${GHCR_IMAGE:-ghcr.io/tomlawesome/orbit}"
remote="${GIT_REMOTE:-origin}"

run_node() { "${PROMOTE_NODE:-node}" "$@"; }

# The first Digest: line, read to EOF rather than exiting early: the same
# pipefail/SIGPIPE race scripts/ci/publish-image.sh's identical awk guards
# against (a `docker buildx imagetools inspect ... | awk '...; exit'` that
# exits before the Manifests: block finishes writing can turn the writer's
# SIGPIPE into this pipeline's own failure under `set -o pipefail`).
resolve_digest() {
  docker buildx imagetools inspect "$1" 2> /dev/null |
    awk '$1 == "Digest:" && $2 ~ /^sha256:[0-9a-f]{64}$/ && !found { digest = $2; found = 1 }
         END { if (found) print digest }'
}

# main and preview must be the exact same commit: stable promotes what
# preview already tested, never a rebuild and never a commit preview has not
# accepted.
main_head="$(git ls-remote "$remote" refs/heads/main | cut -f1)"
preview_head="$(git ls-remote "$remote" refs/heads/preview | cut -f1)"
[[ -n "$main_head" ]] || fail "could not read main's HEAD from ${remote}"
[[ -n "$preview_head" ]] || fail "could not read preview's HEAD from ${remote}"
[[ "$main_head" == "$preview_head" ]] ||
  fail "main (${main_head}) and preview (${preview_head}) are not the same commit"

# The accepted digest must still be exactly what :preview names, and what the
# pipeline for main's own HEAD published as :sha-<commit> -- never a later
# push that moved :preview out from under this promotion, and never a digest
# that never reached main's own commit.
preview_ref="${image}:preview"
sha_ref="${image}:sha-${main_head}"
preview_resolved="$(resolve_digest "$preview_ref")"
sha_resolved="$(resolve_digest "$sha_ref")"
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

# The calculator reads stable Git tags, so tags must be fetched -- not just
# the branches merge-base needs below. `git fetch --no-tags` here would be
# the old workflow's branch-only fetch with exactly the wrong flag for this.
git fetch --tags "$remote" \
  "+refs/heads/main:refs/remotes/${remote}/main" \
  "+refs/heads/preview:refs/remotes/${remote}/preview" \
  "+refs/heads/hotfix/*:refs/remotes/${remote}/hotfix/*"

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
# could disagree about what has already shipped.
if docker buildx imagetools inspect "${image}:${version}" > /dev/null 2>&1; then
  fail "${image}:${version} already exists in GHCR; refusing to overwrite a shipped release"
fi

# --- Promote exact preview digest to latest (ported from promote-container.yml) --

# A token that can only publish, piped on stdin so it never appears in argv
# or a process listing.
printf '%s' "$GHCR_PUBLISH_TOKEN" | docker login ghcr.io -u tomlawesome --password-stdin

# `:latest`, not `:stable`: install.sh defaults ORBIT_CHANNEL to latest.
docker buildx imagetools create \
  --tag "${image}:${version}" \
  --tag "${image}:latest" \
  "${image}@${PREVIEW_DIGEST}"

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
message="$(printf 'Orbit %s\n\nContainer digest: %s\n' "$version" "$PREVIEW_DIGEST")"
curl --silent --show-error --fail --location --max-time 60 \
  --header @"$header_file" \
  --data-urlencode "tag_name=${version}" \
  --data-urlencode "ref=${main_head}" \
  --data-urlencode "message=${message}" \
  "${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}/repository/tags" > /dev/null

printf 'promote-stable: tagged %s and latest at %s; created GitLab tag %s\n' "$version" "$PREVIEW_DIGEST" "$version"
