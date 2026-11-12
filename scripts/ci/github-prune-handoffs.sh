#!/usr/bin/env bash
#
# Deletes old release-handoff drafts (#1824). Every preview and hotfix push
# leaves a draft release named handoff-<commit> on GitHub
# (github-upload-handoff.sh); publish-from-gitlab.yml runs this afterwards so
# they do not pile up. A handoff older than seven days is refused by
# github-await-handoff.sh anyway, so the 14-day default keeps every one that
# could still be used, with room to spare.
#
# Only drafts whose tag is exactly handoff-<40 hex> and that are older than the
# limit are deleted. A published release is never touched, whatever its name,
# and neither is any other draft. A draft makes no tag, so deleting one leaves
# nothing behind.
#
# Inputs (environment):
#   GH_TOKEN                    a token with `contents: write`; never printed
#   GITHUB_REPOSITORY           owner/name
#   GITHUB_API_URL              optional; default https://api.github.com
#   ORBIT_HANDOFF_MAX_AGE_DAYS  optional; whole days, default 14
set -Eeuo pipefail

fail() { printf 'github-prune-handoffs: %s\n' "$1" >&2; exit 1; }

# shellcheck source=scripts/ci/lib-github-handoff.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib-github-handoff.sh"

: "${GH_TOKEN:?a GitHub token with contents: write is required}"
max_age_days="${ORBIT_HANDOFF_MAX_AGE_DAYS:-14}"
[[ "$max_age_days" =~ ^[0-9]+$ ]] || fail "ORBIT_HANDOFF_MAX_AGE_DAYS is not a whole number: ${max_age_days}"

gh_init "$GH_TOKEN"
cutoff=$(($(date -u +%s) - max_age_days * 24 * 3600))

# Listed in full first, deleted after: deleting while paging would shift the
# pages under the listing.
releases="$(gh_releases)"
old=()
while IFS=$'\t' read -r id tag draft created; do
  [[ -n "$id" && "$draft" == true && "$tag" =~ ^handoff-[0-9a-f]{40}$ ]] || continue
  [[ "$id" =~ ^[0-9]+$ ]] || fail "GitHub gave a release id that is not a number for ${tag}"
  created_epoch="$(date -u -d "$created" +%s 2> /dev/null)" || fail "cannot read the creation time of ${tag}: ${created:-<missing>}"
  if ((created_epoch < cutoff)); then old+=("${id}"$'\t'"${tag}"); fi
done <<< "$releases"

for entry in "${old[@]}"; do
  gh_curl --max-time 60 --request DELETE "${gh_api}/repos/${gh_repo}/releases/${entry%%$'\t'*}" > /dev/null ||
    fail "GitHub refused to delete the draft ${entry#*$'\t'}"
  printf 'Deleted draft %s.\n' "${entry#*$'\t'}"
done
printf 'github-prune-handoffs: deleted %s handoff draft(s) older than %s days.\n' "${#old[@]}" "$max_age_days"
