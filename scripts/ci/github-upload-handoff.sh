#!/usr/bin/env bash
#
# GitLab's half of the release handoff (#1824): puts the files GitHub needs to
# publish this commit on a draft GitHub release named handoff-<commit>, so
# GitHub's workflows never have to connect to GitLab. The handoff_to_github
# job in .gitlab-ci.yml runs it.
#
# The pattern is offline image transfer: the signed image is saved to files,
# carried, loaded at the far side and verified on arrival. The draft release is
# only the carrier and is not trusted: GitHub checks GitLab's key-based
# attestation against the committed cosign.pub before anything is published
# (github-await-handoff.sh and .github/workflows/publish-from-gitlab.yml).
#
# A draft release is not public and makes no tag. Every regular file at the top
# of ORBIT_HANDOFF_DIR is uploaded to it (subdirectories and symlinks are
# skipped), then, last, handoff-complete.json: the commit, the pipeline, and
# every other asset's name, sha256 and size. GitHub treats a draft without it
# as not there yet, so a handoff that failed half way is never read.
#
# Run again for the same commit (a retried job), it reuses the same draft:
# handoff-complete.json comes off first, then every other asset, then the new
# files go up and handoff-complete.json last again. It never makes a second
# draft, and it refuses to touch a published release with the handoff name.
#
# Inputs (environment):
#   GITHUB_HANDOFF_TOKEN  a fine-grained token for this repository only,
#                         Contents read and write (docs/releasing.md); never
#                         printed and never on a command line
#   GITHUB_REPOSITORY     owner/name of the GitHub repository
#   GITHUB_API_URL        optional; default https://api.github.com
#   GITHUB_UPLOADS_URL    optional; default https://uploads.github.com
#   ORBIT_COMMIT          the commit being handed off (40 hex)
#   ORBIT_PIPELINE_URL    the GitLab pipeline that tested it
#   ORBIT_HANDOFF_DIR     the directory holding the files to hand off
set -Eeuo pipefail

fail() { printf 'github-upload-handoff: %s\n' "$1" >&2; exit 1; }

readonly COMPLETE=handoff-complete.json

[[ -n "${GITHUB_HANDOFF_TOKEN:-}" ]] ||
  fail 'GITHUB_HANDOFF_TOKEN is not set: the owner creates it as a protected, masked GitLab CI variable (docs/releasing.md, "The GitHub handoff token")'
commit="${ORBIT_COMMIT:-}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "ORBIT_COMMIT is not an exact commit SHA: ${commit:-<unset>}"
pipeline_url="${ORBIT_PIPELINE_URL:-}"
[[ "$pipeline_url" =~ ^https://[A-Za-z0-9._:/-]+$ ]] || fail "ORBIT_PIPELINE_URL is not an https URL: ${pipeline_url:-<unset>}"
dir="${ORBIT_HANDOFF_DIR:-}"
[[ -n "$dir" && -d "$dir" ]] || fail "ORBIT_HANDOFF_DIR is not a directory: ${dir:-<unset>}"

# shellcheck source=scripts/ci/lib-github-handoff.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib-github-handoff.sh"
uploads="${GITHUB_UPLOADS_URL:-https://uploads.github.com}"
uploads="${uploads%/}"
tag="handoff-${commit}"

# The assets: regular files only, at the top level, in a stable order.
files=()
while IFS= read -r -d '' path; do
  name="${path##*/}"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "refusing an asset name GitHub would rewrite: ${name}"
  [[ "$name" != "$COMPLETE" ]] || fail "${COMPLETE} is written by this script, not handed in: remove it from ${dir}"
  # GitHub refuses a release asset of 2 GiB or more; say so before any request.
  (($(stat -c %s "$path") < 2147483648)) || fail "${name} is 2 GiB or more, over GitHub's limit for one release asset"
  files+=("$name")
done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)
((${#files[@]} > 0)) || fail "no files to hand off in ${dir}"

gh_init "$GITHUB_HANDOFF_TOKEN"

# handoff-complete.json, written before any request so a file that cannot be
# read stops the run before anything on GitHub changes.
complete="${gh_tmp}/${COMPLETE}"
{
  for name in "${files[@]}"; do
    printf '%s\t%s\t%s\n' "$name" "$(sha256sum < "${dir}/${name}" | cut -d' ' -f1)" "$(stat -c %s "${dir}/${name}")"
  done
} | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
    const assets = raw.split("\n").filter(Boolean).map((line) => {
      const [name, sha256, size] = line.split("\t");
      return { name, sha256, size: Number(size) };
    });
    const doc = { commit: process.argv[1], pipelineUrl: process.argv[2], assets };
    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
  });
' -- "$commit" "$pipeline_url" > "$complete"

# The draft for this commit: found by listing (GET /releases/tags/<tag> never
# shows a draft), across every page.
releases="$(gh_releases)"
mine="$(awk -F '\t' -v tag="$tag" '$2 == tag' <<< "$releases")"
if grep -q $'\tfalse\t' <<< "$mine"; then
  fail "a published release is named ${tag}; a handoff is only ever a draft, so this needs the owner to look at it, not an overwrite"
fi
drafts="$(grep -c . <<< "$mine" || :)"
((drafts <= 1)) || fail "${drafts} drafts are named ${tag}; delete all but one on GitHub and run this again"

if ((drafts == 0)); then
  body="$(node -e '
    process.stdout.write(JSON.stringify({
      tag_name: process.argv[1],
      name: process.argv[1],
      draft: true,
      body: "Release handoff from GitLab (" + process.argv[2] + "). Not a release: never publish this draft. " +
        "GitHub reads it to publish the tested image and deletes it after 14 days.",
    }));
  ' -- "$tag" "$pipeline_url")"
  created="$(gh_curl --max-time 60 --request POST \
    --header 'Accept: application/vnd.github+json' \
    --header 'Content-Type: application/json' \
    --data "$body" "${gh_api}/repos/${gh_repo}/releases")" ||
    fail "GitHub refused to create the draft ${tag}"
  release_id="$(json 'input.id' <<< "$created")"
  [[ "$(json 'input.draft === true' <<< "$created")" == true ]] || fail "GitHub did not create ${tag} as a draft"
  printf 'Created draft %s.\n' "$tag"
else
  release_id="$(cut -f1 <<< "$mine")"
  printf 'Reusing draft %s; replacing its assets.\n' "$tag"
  # The completeness marker goes first, so a reader never sees it beside
  # half-replaced files.
  assets="$(gh_assets "$release_id")"
  ordered="$(awk -F '\t' -v c="$COMPLETE" '$2 == c' <<< "$assets"; awk -F '\t' -v c="$COMPLETE" '$2 != c' <<< "$assets")"
  while IFS=$'\t' read -r asset_id asset_name _; do
    [[ -n "$asset_id" ]] || continue
    gh_curl --max-time 60 --request DELETE "${gh_api}/repos/${gh_repo}/releases/assets/${asset_id}" > /dev/null ||
      fail "GitHub refused to delete ${asset_name} from ${tag}"
  done <<< "$ordered"
fi
[[ "$release_id" =~ ^[0-9]+$ ]] || fail "GitHub gave no release id for ${tag}"

upload() { # $1 path, $2 asset name
  gh_curl --max-time 1800 --request POST \
    --header 'Accept: application/vnd.github+json' \
    --header 'Content-Type: application/octet-stream' \
    --header 'Expect:' \
    --upload-file "$1" \
    "${uploads}/repos/${gh_repo}/releases/${release_id}/assets?name=$2" > /dev/null ||
    fail "upload of $2 to ${tag} failed; ${COMPLETE} was not uploaded, so GitHub will not read this handoff"
  printf 'Uploaded %s.\n' "$2"
}

for name in "${files[@]}"; do upload "${dir}/${name}" "$name"; done
upload "$complete" "$COMPLETE"
printf 'github-upload-handoff: %s handed off as draft %s (%s files).\n' "$commit" "$tag" "${#files[@]}"
