#!/usr/bin/env bash
#
# Deletes old release handoffs (#1824). Every preview and hotfix push leaves a
# release named handoff-<commit> in the separate handoff repository
# (GITHUB_HANDOFF_REPO; github-upload-handoff.sh); GitLab's handoff_to_github
# job runs this after the upload so they do not pile up. No GitHub workflow
# runs it. A handoff older than seven days is refused by
# github-await-handoff.sh anyway, so the 14-day default keeps every one that
# could still be used, with room to spare.
#
# Only releases whose tag is exactly handoff-<40 hex> and that are older than
# the limit are deleted, with their tags (a published release makes its tag,
# and deleting the release leaves it behind). A draft is never deleted,
# whatever its dates: another pipeline may be uploading to it, and its
# created_at is the tagged commit's date, so it cannot be aged. Nothing else
# is touched, whatever its age, and the current commit's handoff
# (CI_COMMIT_SHA) never is.
#
# Age: by published_at. A release's created_at is the date of the commit it
# tags, so a fresh handoff of an old commit would look old by it.
#
# The tag goes before the release, so a failed tag delete stops the run with
# the release still listed, and the next run tries both again. GitHub answers
# 422 both for a tag that is already gone (a release delete that failed after
# its tag delete) and for other refusals, so a 422 counts as gone only if a
# GET of the tag ref then answers 404; anything else fails the run and keeps
# the release.
#
# Inputs (environment):
#   GITHUB_HANDOFF_TOKEN        the handoff token (Contents read and write on
#                               the handoff repository only); never printed
#   GITHUB_HANDOFF_REPO         owner/name of the handoff repository;
#                               GITHUB_REPOSITORY is never read
#   GITHUB_API_URL              optional; default https://api.github.com
#   ORBIT_HANDOFF_MAX_AGE_DAYS  optional; whole days, default 14
#   CI_COMMIT_SHA               the commit just handed off (40 lower-case
#                               hex), whose release and tag are never deleted;
#                               required, so a run cannot forget to spare it
set -Eeuo pipefail

fail() { printf 'github-prune-handoffs: %s\n' "$1" >&2; exit 1; }

# shellcheck source=scripts/ci/lib-github-handoff.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib-github-handoff.sh"

: "${GITHUB_HANDOFF_TOKEN:?the handoff token is required (docs/releasing.md)}"
max_age_days="${ORBIT_HANDOFF_MAX_AGE_DAYS:-14}"
[[ "$max_age_days" =~ ^[0-9]+$ ]] || fail "ORBIT_HANDOFF_MAX_AGE_DAYS is not a whole number: ${max_age_days}"
current="${CI_COMMIT_SHA:-}"
[[ "$current" =~ ^[0-9a-f]{40}$ ]] || fail "CI_COMMIT_SHA is not an exact commit SHA (40 lower-case hex): ${current:-<unset>}"

gh_init "$GITHUB_HANDOFF_TOKEN"
cutoff=$(($(date -u +%s) - max_age_days * 24 * 3600))

# Listed in full first, deleted after: deleting while paging would shift the
# pages under the listing.
releases="$(gh_releases)"
old=()
while IFS=$'\t' read -r id tag draft _ published; do
  [[ -n "$id" && "$tag" =~ ^handoff-[0-9a-f]{40}$ ]] || continue
  [[ "$tag" != "handoff-${current}" && "$draft" != true ]] || continue
  [[ "$id" =~ ^[0-9]+$ ]] || fail "GitHub gave a release id that is not a number for ${tag}"
  if [[ -z "$published" ]] || ! epoch="$(date -u -d "$published" +%s 2> /dev/null)"; then
    fail "cannot read when ${tag} was published: ${published:-<missing>}"
  fi
  if ((epoch < cutoff)); then old+=("${id}"$'\t'"${tag}"); fi
done <<< "$releases"

for entry in "${old[@]}"; do
  IFS=$'\t' read -r id tag <<< "$entry"
  ref_url="${gh_api}/repos/${gh_repo}/git/refs/tags/${tag}"
  status="$(gh_curl --max-time 60 --request DELETE --output /dev/null --write-out '%{http_code}' \
    "$ref_url" 2> /dev/null || :)"
  if [[ "$status" == 422 ]]; then
    # Gone only if GitHub says so: a GET of the ref must answer 404.
    status="$(gh_curl --max-time 60 --header 'Accept: application/vnd.github+json' \
      --output /dev/null --write-out '%{http_code}' "$ref_url" 2> /dev/null || :)"
    [[ "$status" == 404 ]] ||
      fail "GitHub refused to delete the tag ${tag} (422) and it is not confirmed gone (GET answered ${status:-nothing}); the release is left for the next run"
  elif [[ "$status" != 204 ]]; then
    fail "GitHub refused to delete the tag ${tag} (HTTP ${status:-none}); the release is left for the next run"
  fi
  gh_curl --max-time 60 --request DELETE "${gh_api}/repos/${gh_repo}/releases/${id}" > /dev/null ||
    fail "GitHub refused to delete the release ${tag}"
  printf 'Deleted %s.\n' "$tag"
done
printf 'github-prune-handoffs: deleted %s handoff release(s) older than %s days from %s.\n' "${#old[@]}" "$max_age_days" "$gh_repo"
