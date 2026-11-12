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
# and deleting the release leaves it behind). A leftover draft of that name
# goes too; it has no tag. Nothing else is touched, whatever its age.
#
# Inputs (environment):
#   GITHUB_HANDOFF_TOKEN        the handoff token (Contents read and write on
#                               the handoff repository only); never printed
#   GITHUB_HANDOFF_REPO         owner/name of the handoff repository;
#                               GITHUB_REPOSITORY is never read
#   GITHUB_API_URL              optional; default https://api.github.com
#   ORBIT_HANDOFF_MAX_AGE_DAYS  optional; whole days, default 14
set -Eeuo pipefail

fail() { printf 'github-prune-handoffs: %s\n' "$1" >&2; exit 1; }

# shellcheck source=scripts/ci/lib-github-handoff.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib-github-handoff.sh"

: "${GITHUB_HANDOFF_TOKEN:?the handoff token is required (docs/releasing.md)}"
max_age_days="${ORBIT_HANDOFF_MAX_AGE_DAYS:-14}"
[[ "$max_age_days" =~ ^[0-9]+$ ]] || fail "ORBIT_HANDOFF_MAX_AGE_DAYS is not a whole number: ${max_age_days}"

gh_init "$GITHUB_HANDOFF_TOKEN"
cutoff=$(($(date -u +%s) - max_age_days * 24 * 3600))

# Listed in full first, deleted after: deleting while paging would shift the
# pages under the listing.
releases="$(gh_releases)"
old=()
while IFS=$'\t' read -r id tag draft created; do
  [[ -n "$id" && "$tag" =~ ^handoff-[0-9a-f]{40}$ ]] || continue
  [[ "$id" =~ ^[0-9]+$ ]] || fail "GitHub gave a release id that is not a number for ${tag}"
  created_epoch="$(date -u -d "$created" +%s 2> /dev/null)" || fail "cannot read the creation time of ${tag}: ${created:-<missing>}"
  if ((created_epoch < cutoff)); then old+=("${id}"$'\t'"${tag}"$'\t'"${draft}"); fi
done <<< "$releases"

for entry in "${old[@]}"; do
  IFS=$'\t' read -r id tag draft <<< "$entry"
  gh_curl --max-time 60 --request DELETE "${gh_api}/repos/${gh_repo}/releases/${id}" > /dev/null ||
    fail "GitHub refused to delete the release ${tag}"
  if [[ "$draft" != true ]]; then
    gh_curl --max-time 60 --request DELETE "${gh_api}/repos/${gh_repo}/git/refs/tags/${tag}" > /dev/null ||
      fail "deleted the release ${tag} but GitHub refused to delete its tag"
  fi
  printf 'Deleted %s.\n' "$tag"
done
printf 'github-prune-handoffs: deleted %s handoff release(s) older than %s days from %s.\n' "${#old[@]}" "$max_age_days" "$gh_repo"
