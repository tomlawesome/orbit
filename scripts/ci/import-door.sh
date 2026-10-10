#!/usr/bin/env bash
# Pulls orbit-site's shared door folder into Orbit and proposes the update as a
# merge request, rather than the door being hand-ported and drifting (#1371;
# ai/orbit-site ADR-0001).
#
# The pattern is a vendored upstream copy with a pinned record and automated
# update merge requests: the same shape as scripts/ci/repin-base-image.sh and
# orbit-site's nightly docs import. Same owner rulings too: nothing is pushed
# to `dev`, `preview` or `main`, and nothing is merged here -- a bot-opened
# merge request is how a change is proposed, and the required checks on it
# carry the safety.
#
# What it does:
#
#   1. Fetches the current commit of ai/orbit-site's `main` (one commit deep)
#      and reads assets/door/ out of it as raw blobs, so no line-ending or
#      attribute filter can alter a byte.
#   2. Hashes that folder (scripts/ci/door-tree-hash.sh, the same function
#      scripts/ci/check-door-unchanged.sh uses). If the hash equals the one in
#      web/src/lib/door.upstream.json, and the copy on disk still matches it,
#      nothing changed: exit 0, no branch, no merge request. A commit
#      upstream that leaves assets/door/ alone therefore changes nothing here.
#   3. Otherwise replaces web/src/lib/door/ with the new copy (files gone
#      upstream are deleted), rewrites web/src/lib/door.upstream.json
#      ({ project, ref, commit, path, tree }), commits both, pushes branch
#      chore/door-import-<short sha> and opens a merge request into `dev`
#      naming the upstream commit.
#   4. Only after the new merge request exists, closes every older open
#      door-import merge request and deletes its branch, so there is never a
#      moment with none open and never more than one at rest.
#
# A failure to read upstream, push or call the API exits 2 and fails the job.
# Finding the door changed is not a failure: it is the merge request.
#
# Credentials, narrowed as far as they go (same split as repin-base-image.sh):
#
#   Reading ai/orbit-site uses this job's own CI_JOB_TOKEN, which GitLab issues
#   per job and expires with it. It works because ai/orbit-site's "CI/CD job
#   token allowlist" (Settings > CI/CD > Job token permissions) lists ai/orbit
#   and the user the schedule runs as can read that project. It is only sent
#   when the upstream URL is https; it is never sent to anywhere else.
#
#   Pushing the branch and opening and closing merge requests cannot use
#   CI_JOB_TOKEN (read-only Merge Requests API access), so that half needs
#   DOOR_IMPORT_TOKEN: a project access token on ai/orbit ONLY (`api` scope,
#   Developer role), masked and protected. See the door_import job in
#   .gitlab-ci.yml. Neither token is ever printed or placed in argv: each is
#   written to a mode-600 file with a builtin and read by curl (`--header
#   @file`) or git (a credential-store file) from there.
#
# Usage:
#   scripts/ci/import-door.sh
#
# It rewrites files in, and creates a branch in, the checkout this script lives
# in; it is meant to run in a CI job's own checkout, not a working copy.
#
# Inputs (environment):
#   DOOR_IMPORT_TOKEN         Required. The project access token above.
#   CI_JOB_TOKEN              GitLab predefined; reads ai/orbit-site.
#   CI_API_V4_URL             GitLab predefined; the API base URL.
#   CI_PROJECT_ID             GitLab predefined; this project's numeric id.
#   CI_PROJECT_PATH           GitLab predefined; e.g. ai/orbit.
#   CI_SERVER_URL             GitLab predefined; the push URL is built from it
#                             and CI_PROJECT_PATH.
#   CI_SERVER_HOST            GitLab predefined; the host the push credential
#                             is for. Defaults to CI_SERVER_URL's host.
#   CI_PIPELINE_URL           GitLab predefined; recorded in the merge request.
#   DOOR_IMPORT_UPSTREAM_URL  Testing seam: where to fetch orbit-site from.
#                             Defaults to
#                             https://gitlab.tomlawson.io/ai/orbit-site.git.
#   DOOR_IMPORT_PUSH_URL      Testing seam: where to push the branch. Defaults
#                             to $CI_SERVER_URL/$CI_PROJECT_PATH.git.
#   DOOR_IMPORT_TARGET_BRANCH The merge request's target. Defaults to `dev`.
set -Eeuo pipefail
# Forced off regardless of how this script is invoked (a stray `bash -x`, an
# inherited `SHELLOPTS`): xtrace prints each command after expansion and would
# echo a token the moment it is read into a variable or a file.
set +x

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ci/door-tree-hash.sh
source "$repo_dir/scripts/ci/door-tree-hash.sh"

upstream_project="ai/orbit-site"
upstream_ref="main"
upstream_path="assets/door"
copy_rel="web/src/lib/door"
record_rel="web/src/lib/door.upstream.json"
copy_dir="$repo_dir/$copy_rel"
record_file="$repo_dir/$record_rel"

upstream_url="${DOOR_IMPORT_UPSTREAM_URL:-https://gitlab.tomlawson.io/${upstream_project}.git}"
target_branch="${DOOR_IMPORT_TARGET_BRANCH:-dev}"
branch_prefix="chore/door-import-"

if [[ $# -gt 0 ]]; then
  printf 'import-door: unknown argument %s\n' "$1" >&2
  exit 64
fi

log() { printf 'import-door: %s\n' "$1"; }
fail() { printf 'import-door: %s\n' "$1" >&2; exit 2; }

# Every file this script writes a token into, and every scratch directory,
# goes through here, so there is one cleanup path and it covers every exit:
# success, `fail`, an unhandled error under `set -e`, or a signal.
_secret_files=()
_scratch_dirs=()
_cleanup() {
  [[ ${#_secret_files[@]} -eq 0 ]] || rm -f "${_secret_files[@]}"
  [[ ${#_scratch_dirs[@]} -eq 0 ]] || rm -rf "${_scratch_dirs[@]}"
}
trap _cleanup EXIT INT TERM

# A mode-600 temp file, tracked for cleanup. Callers write the secret into it
# with a builtin (`printf ... > "$file"`), so the value is never the argv of
# any process.
new_secret_file() {
  local f
  f="$(mktemp)"
  chmod 600 "$f"
  _secret_files+=("$f")
  printf '%s' "$f"
}

new_scratch_dir() {
  local d
  d="$(mktemp -d)"
  _scratch_dirs+=("$d")
  printf '%s' "$d"
}

json_field() {
  node -e 'let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => { const value = new Function("input", process.argv[2])(input); process.stdout.write(String(value ?? "")); });' -- "$1" "$2"
}

: "${DOOR_IMPORT_TOKEN:?DOOR_IMPORT_TOKEN is not set. See the door_import job in .gitlab-ci.yml for the exact grant this needs.}"
: "${CI_API_V4_URL:?CI_API_V4_URL is not set; this must run inside a GitLab CI job}"
: "${CI_PROJECT_ID:?CI_PROJECT_ID is not set; this must run inside a GitLab CI job}"
: "${CI_PROJECT_PATH:?CI_PROJECT_PATH is not set; this must run inside a GitLab CI job}"
: "${CI_SERVER_URL:?CI_SERVER_URL is not set; this must run inside a GitLab CI job}"
server_host="${CI_SERVER_HOST:-${CI_SERVER_URL#*://}}"
server_host="${server_host%%/*}"

# --- Read upstream -----------------------------------------------------------
#
# A scratch repository with its own HOME and no global or system gitconfig, so
# the only credential that can reach the fetch is the one named here. The
# folder is read as raw blobs (`ls-tree` then `cat-file`), never through a
# checkout, because a checkout applies the repository's attribute and
# line-ending filters and the copy must be byte for byte.

work_dir="$(new_scratch_dir)"
fetch_home="$work_dir/home"
mkdir -p "$fetch_home" "$work_dir/upstream" "$work_dir/new-door"
isolated_git() {
  GIT_TERMINAL_PROMPT=0 HOME="$fetch_home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@"
}

fetch_url="$upstream_url"
fetch_config=(-c credential.helper=)
if [[ "$upstream_url" == https://* && -n "${CI_JOB_TOKEN:-}" ]]; then
  # The user name goes in the URL (it is not a secret) so git asks the store
  # for exactly this entry; the token stays in the file.
  fetch_url="https://gitlab-ci-token@${upstream_url#https://}"
  upstream_host="${upstream_url#https://}"
  upstream_host="${upstream_host%%/*}"
  fetch_credentials="$(new_secret_file)"
  printf 'https://gitlab-ci-token:%s@%s\n' "$CI_JOB_TOKEN" "$upstream_host" > "$fetch_credentials"
  fetch_config+=(-c "credential.helper=store --file=${fetch_credentials}")
fi

isolated_git -C "$work_dir/upstream" init -q
if ! isolated_git -C "$work_dir/upstream" "${fetch_config[@]}" fetch -q --no-tags --depth 1 "$fetch_url" "refs/heads/${upstream_ref}"; then
  fail "could not fetch ${upstream_ref} from ${upstream_project}. Check that ai/orbit is on that project's CI/CD job token allowlist, and that this pipeline's user can read it."
fi
upstream_commit="$(isolated_git -C "$work_dir/upstream" rev-parse FETCH_HEAD)"
[[ "$upstream_commit" =~ ^[0-9a-f]{40}$ ]] || fail "upstream commit is not a full sha: '${upstream_commit}'"
short_sha="${upstream_commit:0:7}"
log "${upstream_project} ${upstream_ref} is at ${upstream_commit}"

file_count=0
while IFS= read -r -d '' entry; do
  meta="${entry%%$'\t'*}"
  path="${entry#*$'\t'}"
  read -r mode type object <<< "$meta"
  if [[ "$type" != "blob" || ( "$mode" != "100644" && "$mode" != "100755" ) ]]; then
    fail "${upstream_path}/${path#"${upstream_path}/"} is a ${type} (mode ${mode}); the door folder may hold plain files only."
  fi
  rel="${path#"${upstream_path}/"}"
  mkdir -p "$work_dir/new-door/$(dirname "$rel")"
  isolated_git -C "$work_dir/upstream" cat-file blob "$object" > "$work_dir/new-door/$rel"
  file_count=$((file_count + 1))
done < <(isolated_git -C "$work_dir/upstream" ls-tree -r -z --full-tree "$upstream_commit" -- "${upstream_path}/")
[[ "$file_count" -gt 0 ]] || fail "${upstream_path}/ is empty or missing in ${upstream_project} ${upstream_ref} at ${upstream_commit}."

new_tree="$(door_tree_hash "$work_dir/new-door")"
log "${file_count} files, tree ${new_tree}"

# --- Has anything changed? ---------------------------------------------------
#
# Compared on the tree only, never on the commit: an upstream commit that
# leaves assets/door/ as it was must not open a merge request. The copy on
# disk is checked too, so a hand-edited copy is put right instead of waved
# through on the strength of an old record.

recorded_tree=""
if [[ -f "$record_file" ]]; then
  recorded_tree="$(node -e '
    try {
      const record = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(typeof record.tree === "string" ? record.tree : "");
    } catch {}
  ' "$record_file")"
fi
current_tree=""
if [[ -d "$copy_dir" ]]; then
  current_tree="$(door_tree_hash "$copy_dir" 2> /dev/null || true)"
fi
if [[ "$recorded_tree" == "$new_tree" && "$current_tree" == "$new_tree" ]]; then
  log "the door is unchanged upstream (tree ${new_tree}); no branch, no merge request."
  exit 0
fi

# --- Commit, push, and open the merge request --------------------------------

branch_name="${branch_prefix}${short_sha}"
log "the door changed; proposing ${branch_name}"

git -C "$repo_dir" config user.email "door-import@ci.local"
git -C "$repo_dir" config user.name "door-import"
git -C "$repo_dir" checkout -q -B "$branch_name"

rm -rf "$copy_dir"
mkdir -p "$(dirname "$copy_dir")"
cp -R "$work_dir/new-door" "$copy_dir"
node -e '
  const [file, project, ref, commit, path, tree] = process.argv.slice(1);
  require("node:fs").writeFileSync(file, JSON.stringify({ project, ref, commit, path, tree }, null, 2) + "\n");
' "$record_file" "$upstream_project" "$upstream_ref" "$upstream_commit" "$upstream_path" "$new_tree"

git -C "$repo_dir" add -A -- "$copy_rel" "$record_rel"
if git -C "$repo_dir" diff --cached --quiet; then
  log "nothing differs in git after the copy (a path is ignored?); no branch, no merge request."
  exit 0
fi
git -C "$repo_dir" commit -q -m "Import the door from ${upstream_project} ${short_sha}

Copies ${upstream_path}/ from ${upstream_project} ${upstream_ref} at
${upstream_commit} byte for byte into ${copy_rel}/ and records it in
${record_rel}. The copy is never edited here; scripts/ci/check-door-unchanged.sh
fails if it is.

Opened automatically by the door_import schedule (#1371). Nothing here
merges itself."

# The token never goes in the push URL, where it would sit in this process's
# argv for the life of the push; git reads it from a mode-600 credential-store
# file instead, from a scratch repository with no config of its own and a HOME
# nothing else has written to, exactly as repin-base-image.sh does (#1081).
credential_file="$(new_secret_file)"
printf 'https://oauth2:%s@%s\n' "$DOOR_IMPORT_TOKEN" "$server_host" > "$credential_file"
push_url="${DOOR_IMPORT_PUSH_URL:-${CI_SERVER_URL%/}/${CI_PROJECT_PATH}.git}"

push_repo="$(new_scratch_dir)"
push_home="$(new_scratch_dir)"
git init -q "$push_repo"
# The CI checkout is a shallow clone, and a push out of one is a "shallow
# update" the receiving side refuses by default (repin pipeline 1553).
git -C "$push_repo" config receive.shallowUpdate true
# Pushed from the checkout into the scratch repository rather than fetched out
# of it, so git's ownership check never runs against the checkout (repin
# pipeline 1547).
git -C "$repo_dir" push -q "$push_repo" "refs/heads/${branch_name}:refs/heads/${branch_name}"
GIT_TERMINAL_PROMPT=0 HOME="$push_home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
git -C "$push_repo" \
  -c credential.helper= \
  -c "credential.helper=store --file=${credential_file}" \
  push -q --force "$push_url" "refs/heads/${branch_name}:refs/heads/${branch_name}" \
  || fail "the push of ${branch_name} was refused or failed (exit $?). Check DOOR_IMPORT_TOKEN's scope and role on ai/orbit."
log "pushed ${branch_name}"

header_file="$(new_secret_file)"
body_file="$(new_secret_file)"
printf 'PRIVATE-TOKEN: %s\n' "$DOOR_IMPORT_TOKEN" > "$header_file"
api_call() { curl --silent --show-error --fail --location --max-time 60 --header @"$header_file" "$@"; }
api="${CI_API_V4_URL%/}/projects/${CI_PROJECT_ID}"

# Every open door-import merge request as "iid<TAB>source branch" lines. Read
# before the new one is created, so the new one can never be in the list.
open_imports="$(
  api_call -G --data-urlencode "state=opened" --data-urlencode "per_page=100" "${api}/merge_requests" |
    json_field '' "
      return JSON.parse(input)
        .filter((mr) => typeof mr.source_branch === 'string' && mr.source_branch.startsWith('${branch_prefix}'))
        .map((mr) => mr.iid + '\\t' + mr.source_branch)
        .join('\\n');
    "
)" || fail "could not list open merge requests"

existing_iid=""
while IFS=$'\t' read -r iid source_branch; do
  [[ "$source_branch" == "$branch_name" ]] && existing_iid="$iid"
done <<< "$open_imports"

if [[ -n "$existing_iid" ]]; then
  log "merge request !${existing_iid} is already open from ${branch_name}; the push above updated it."
  new_iid="$existing_iid"
else
  {
    printf 'Reported by the `door_import` GitLab job.\n'
    printf 'Run: %s\n\n' "${CI_PIPELINE_URL:-<unknown>}"
    printf 'Imports orbit-site'"'"'s shared door folder, `%s/`, from `%s` at\n' "$upstream_path" "$upstream_ref"
    printf '`%s` into `%s/`, byte for byte, and records it in\n' "$upstream_commit" "$copy_rel"
    printf '`%s` (tree `%s`). Files gone upstream are deleted.\n\n' "$record_rel" "$new_tree"
    printf 'The copy is never edited here: `scripts/ci/check-door-unchanged.sh` fails if it is. Changes\n'
    printf 'to the door are made in ai/orbit-site (ADR-0001 there) and arrive through this import.\n\n'
    printf 'Nothing here merges itself. The normal required checks still gate this merge request.\n\n'
    printf 'Cut: risk -- a vendored copy of another project'"'"'s code is a dependency change and belongs on its own.\n'
  } > "$body_file"
  new_iid="$(
    api_call -X POST \
      --data-urlencode "source_branch=${branch_name}" \
      --data-urlencode "target_branch=${target_branch}" \
      --data-urlencode "title=Import the door from ${upstream_project} ${short_sha}" \
      --data-urlencode "description@${body_file}" \
      --data-urlencode "labels=dependencies" \
      --data-urlencode "remove_source_branch=true" \
      "${api}/merge_requests" |
      json_field '' 'return JSON.parse(input).iid ?? "";'
  )"
  [[ -n "$new_iid" ]] || fail "merge request creation did not return an iid"
  log "opened merge request !${new_iid}"
fi

# --- Supersede the older door-import merge requests --------------------------
#
# After the new one exists, never before. A failure to tidy one old merge
# request is logged and does not fail the run: the new proposal is already
# open, and the next run tries again.
while IFS=$'\t' read -r iid source_branch; do
  [[ -n "$iid" && "$source_branch" != "$branch_name" ]] || continue
  encoded_branch="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$source_branch")"
  api_call -X POST --data-urlencode "body=Superseded by !${new_iid} (${branch_name})." "${api}/merge_requests/${iid}/notes" > /dev/null ||
    log "could not comment on !${iid}; continuing"
  if api_call -X PUT --data-urlencode "state_event=close" "${api}/merge_requests/${iid}" > /dev/null; then
    log "closed superseded merge request !${iid}"
  else
    log "could not close !${iid}; continuing"
    continue
  fi
  api_call -X DELETE "${api}/repository/branches/${encoded_branch}" > /dev/null ||
    log "could not delete branch ${source_branch}; continuing"
done <<< "$open_imports"
