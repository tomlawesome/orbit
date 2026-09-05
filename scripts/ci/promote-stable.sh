#!/usr/bin/env bash
#
# Promotes a tested `preview` digest to a stable release (#821). GitLab is the
# source of truth, so the release itself is made here rather than on GitHub:
# it validates the requested version, refuses to redo an existing release,
# confirms `main` and `preview` are the exact same commit, confirms the GHCR
# `:preview` tag still names what this commit's pipeline tested and
# published as `:sha-<commit>`, retags that exact digest `vX.Y.Z` and
# `stable` in GHCR (GHCR stays the public image source; the GitLab registry
# keeps only `:sha-*`/`:preview`), and creates the matching annotated tag on
# GitLab. GitLab's push mirror carries the tag to GitHub, where
# .github/workflows/release-on-tag.yml turns it into a GitHub release --
# GitHub does no judging of its own.
#
# Called by the manual `promote_stable` job in .gitlab-ci.yml; see that job
# for when it may run and how `crane` gets installed. Kept as its own script
# rather than inline YAML so it can be unit tested against a stub
# crane/curl/git (scripts/promote-stable.test.mjs).
#
# Usage:
#   scripts/ci/promote-stable.sh
#
# Inputs (environment):
#   VERSION               The version to release: "1.4.0" or "v1.4.0",
#                          normalised to vX.Y.Z below. A GitLab pipeline
#                          variable set by whoever runs the job.
#   CI_COMMIT_SHA          The commit being promoted (GitLab predefined).
#   CI_API_V4_URL          GitLab's predefined API base URL.
#   CI_PROJECT_ID          GitLab's predefined numeric project id.
#   GHCR_PUBLISH_TOKEN     A masked CI/CD variable: a GHCR token scoped only
#                          to write:packages. Never printed or passed as a
#                          command-line argument -- piped to `crane auth
#                          login` on stdin.
#   GITLAB_RELEASE_TOKEN   A masked CI/CD variable: a project access token,
#                          Maintainer role, `api` scope, named
#                          `release-tagging`. Sent to curl as a header file,
#                          never a command-line argument or logged.
#   GHCR_IMAGE             Optional; default ghcr.io/tomlawesome/orbit.
#   GIT_REMOTE             Optional; default origin. The remote to read
#                          main/preview HEADs and existing tags from.
set -Eeuo pipefail

fail() { printf 'promote-stable: %s\n' "$1" >&2; exit 1; }

: "${VERSION:?VERSION is required, e.g. 1.4.0 or v1.4.0}"
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is not set; this script must run inside a GitLab CI job}"
: "${CI_API_V4_URL:?CI_API_V4_URL is not set; this script must run inside a GitLab CI job}"
: "${CI_PROJECT_ID:?CI_PROJECT_ID is not set; this script must run inside a GitLab CI job}"
: "${GHCR_PUBLISH_TOKEN:?GHCR_PUBLISH_TOKEN is not set. Create a GHCR token scoped only to write:packages and set it as a masked CI/CD variable (docs/releasing.md).}"
: "${GITLAB_RELEASE_TOKEN:?GITLAB_RELEASE_TOKEN is not set. Create a project access token (Maintainer, scope: api) named release-tagging and set it as a masked CI/CD variable (docs/releasing.md).}"

image="${GHCR_IMAGE:-ghcr.io/tomlawesome/orbit}"
remote="${GIT_REMOTE:-origin}"

# Normalise "1.4.0" or "v1.4.0" to "vX.Y.Z" -- the same shape
# scripts/calculate-version.mjs's STABLE_VERSION regex accepts.
raw_version="$VERSION"
version="v${raw_version#v}"
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "VERSION must be vMAJOR.MINOR.PATCH (got ${raw_version})"

# Refuse an existing release: the GitLab tag names the release, so a tag that
# already exists means this version already shipped.
if git ls-remote --exit-code --tags "$remote" "refs/tags/${version}" > /dev/null 2>&1; then
  fail "tag ${version} already exists on GitLab; refusing to overwrite a shipped release"
fi

# main and preview must be the exact same commit: stable promotes what
# preview already tested, never a rebuild and never a commit preview has not
# accepted.
main_head="$(git ls-remote "$remote" refs/heads/main | cut -f1)"
preview_head="$(git ls-remote "$remote" refs/heads/preview | cut -f1)"
[[ -n "$main_head" ]] || fail "could not read main's HEAD from ${remote}"
[[ -n "$preview_head" ]] || fail "could not read preview's HEAD from ${remote}"
[[ "$main_head" == "$preview_head" ]] ||
  fail "main (${main_head}) and preview (${preview_head}) are not the same commit"

# The GHCR :preview tag must still be exactly what this commit's pipeline
# tested and published as :sha-<commit> -- never a later push that moved
# :preview out from under this promotion.
preview_digest="$(crane digest "${image}:preview")"
sha_digest="$(crane digest "${image}:sha-${CI_COMMIT_SHA}")"
[[ -n "$preview_digest" ]] || fail "could not resolve ${image}:preview"
[[ "$preview_digest" == "$sha_digest" ]] ||
  fail "${image}:preview (${preview_digest}) does not match ${image}:sha-${CI_COMMIT_SHA} (${sha_digest}); preview has moved since this pipeline tested it"

# Refuse if the version tag already exists in GHCR -- belt and braces beside
# the GitLab tag check above, since GHCR and GitLab are two registries that
# could disagree about what has already shipped.
if crane digest "${image}:${version}" > /dev/null 2>&1; then
  fail "${image}:${version} already exists in GHCR; refusing to overwrite a shipped release"
fi

# Authenticate to GHCR with a token that can only publish, piped on stdin so
# it never appears in argv or a process listing.
printf '%s' "$GHCR_PUBLISH_TOKEN" | crane auth login ghcr.io -u tomlawesome --password-stdin

crane tag "${image}@${preview_digest}" "$version"
crane tag "${image}@${preview_digest}" stable

# Create the annotated GitLab tag naming the exact digest that was promoted,
# so the release note records what actually shipped. The push mirror carries
# the tag to GitHub; release-on-tag.yml there turns it into a GitHub release.
header_file="$(mktemp)"
trap 'rm -f "$header_file"' EXIT
printf 'PRIVATE-TOKEN: %s\n' "$GITLAB_RELEASE_TOKEN" > "$header_file"
message="$(printf 'Orbit %s\n\nContainer digest: %s\n' "$version" "$preview_digest")"
curl --silent --show-error --fail --location --max-time 60 \
  --header @"$header_file" \
  --data-urlencode "tag_name=${version}" \
  --data-urlencode "ref=${CI_COMMIT_SHA}" \
  --data-urlencode "message=${message}" \
  "${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}/repository/tags" > /dev/null

printf 'promote-stable: tagged %s and stable at %s; created GitLab tag %s\n' "$version" "$preview_digest" "$version"
