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
#      nothing changed: exit 0, no branch, no merge request.
#   3. Otherwise replaces web/src/lib/door/ with the new copy (files gone
#      upstream are deleted), rewrites web/src/lib/door.upstream.json
#      ({ project, ref, commit, path, tree }) and commits both.
#   4. Names the branch chore/door-import-<new tree>-on-<recorded tree> (12
#      hex characters of each; `none` when there is no record): what the merge
#      request would carry, and what it is cut from. If that branch already
#      exists on Orbit (asked with `git ls-remote`), this door was already
#      proposed from this base: exit 0, open nothing. So an upstream commit
#      that leaves assets/door/ alone proposes nothing while an earlier import
#      waits, and once an older import merges, a newer door is proposed again
#      from the new base. Otherwise it pushes that branch with GitLab push
#      options that open the merge request into `dev`, titled with the
#      upstream commit, and logs any proposal of the same door from an older
#      base, which is left for the owner to close.
#
# It never lists, closes or comments on merge requests, and never deletes a
# branch: older import merge requests and branches are closed by hand (owner
# decision 12a on #1371). It makes no API call at all.
#
# A failure to read upstream or to push exits 2 and fails the job. Finding the
# door changed is not a failure: it is the merge request.
#
# Credentials, narrowed as far as they go (same split as repin-base-image.sh):
#
#   Reading ai/orbit-site uses this job's own CI_JOB_TOKEN, which GitLab issues
#   per job and expires with it. It works because ai/orbit-site's "CI/CD job
#   token allowlist" (Settings > CI/CD > Job token permissions) lists ai/orbit
#   and the user the schedule runs as can read that project. It is only sent
#   when the upstream URL is https; it is never sent to anywhere else.
#
#   Reading Orbit's branch list and pushing the branch need DOOR_IMPORT_TOKEN:
#   a project access token on ai/orbit ONLY, role Developer, scope
#   `write_repository` alone (no `api`), with an expiry date. See the
#   door_import job in .gitlab-ci.yml. Neither token is ever printed or placed
#   in argv: each is written to a mode-600 file with a builtin and read by git
#   (a credential-store file) from there.
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
#   CI_PROJECT_PATH           GitLab predefined; e.g. ai/orbit.
#   CI_SERVER_URL             GitLab predefined; the push URL is built from it
#                             and CI_PROJECT_PATH.
#   CI_SERVER_HOST            GitLab predefined; the host the push credential
#                             is for. Defaults to CI_SERVER_URL's host.
#   CI_COMMIT_BRANCH          GitLab predefined; must equal the target branch.
#   DOOR_IMPORT_UPSTREAM_URL  Testing seam: where to fetch orbit-site from.
#                             Defaults to
#                             https://gitlab.tomlawson.io/ai/orbit-site.git.
#   DOOR_IMPORT_PUSH_URL      Testing seam: where to push the branch. Defaults
#                             to $CI_SERVER_URL/$CI_PROJECT_PATH.git.
#   DOOR_IMPORT_TARGET_BRANCH The merge request's target, and the only branch
#                             this runs on. Defaults to `dev`.
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
# lives under one mode-700 root that the parent shell creates and its trap
# removes, so cleanup covers every exit: success, `fail`, an unhandled error
# under `set -e`, or a signal. Nothing is tracked per file, because the
# helpers below run in command substitutions (subshells) whose variable
# changes never reach this shell.
scratch_root="$(mktemp -d)"
chmod 700 "$scratch_root"
trap 'rm -rf "$scratch_root"' EXIT INT TERM

# A mode-600 temp file under the scratch root. Callers write the secret into
# it with a builtin (`printf ... > "$file"`), so the value is never the argv of
# any process.
new_secret_file() {
  local f
  f="$(mktemp -p "$scratch_root")"
  chmod 600 "$f"
  printf '%s' "$f"
}

new_scratch_dir() {
  mktemp -d -p "$scratch_root"
}

: "${DOOR_IMPORT_TOKEN:?DOOR_IMPORT_TOKEN is not set. See the door_import job in .gitlab-ci.yml for the exact grant this needs.}"
: "${CI_PROJECT_PATH:?CI_PROJECT_PATH is not set; this must run inside a GitLab CI job}"
: "${CI_SERVER_URL:?CI_SERVER_URL is not set; this must run inside a GitLab CI job}"
server_host="${CI_SERVER_HOST:-${CI_SERVER_URL#*://}}"
server_host="${server_host%%/*}"

# Runs on the target branch only. The token is pushed with and the commit is
# made on top of whatever this checkout holds, so a pipeline on any other ref
# (a run by hand, a schedule pointed at a feature branch) would import on top
# of work that is not what the merge request is going to merge into.
if [[ "${CI_COMMIT_BRANCH:-}" != "$target_branch" ]]; then
  fail "refusing to run on '${CI_COMMIT_BRANCH:-<no branch>}': the door import runs only on ${target_branch} (CI_COMMIT_BRANCH). Point the schedule at ${target_branch}."
fi

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
# fsckObjects refuses a malformed upstream tree (a `..` or `.git` entry, a bad
# object) at fetch time instead of trusting it.
fetch_config=(-c credential.helper= -c transfer.fsckObjects=true)
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
  [[ "$path" == "${upstream_path}/"* ]] || fail "upstream path '${path}' is outside ${upstream_path}/"
  rel="${path#"${upstream_path}/"}"
  # A path component that is empty, `.` or `..` would write outside the scratch
  # copy (into this checkout's .git/hooks, say, which runs at the commit below
  # with the token in the environment); `.git` would plant a nested repository.
  # git itself will not create such a tree, but upstream is not trusted to have
  # used git to build it.
  case "/${rel,,}/" in
    */../* | */./* | *//* | */.git/*)
      fail "refusing upstream path '${path}': a component of it is empty, '.', '..' or '.git'."
      ;;
  esac
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
# Keyed on content and base, not on the upstream commit: the same door from
# the same base is one proposal however many upstream commits carry it, and a
# base that has moved (an older import merged) gets a fresh, mergeable one.
base_tree="none"
[[ "$recorded_tree" =~ ^[0-9a-f]{12,}$ ]] && base_tree="${recorded_tree:0:12}"
branch_name="${branch_prefix}${new_tree:0:12}-on-${base_tree}"
if [[ "$recorded_tree" == "$new_tree" && "$current_tree" == "$new_tree" ]]; then
  log "the door is unchanged upstream (tree ${new_tree}); no branch, no merge request."
  exit 0
fi

# --- Has this door been proposed from this base already? --------------------
#
# The token never goes in a URL, where it would sit in this process's argv for
# the life of the git command; git reads it from a mode-600 credential-store
# file instead, from a scratch repository with no config of its own and a HOME
# nothing else has written to, exactly as repin-base-image.sh does (#1081).
credential_file="$(new_secret_file)"
printf 'https://oauth2:%s@%s\n' "$DOOR_IMPORT_TOKEN" "$server_host" > "$credential_file"
push_url="${DOOR_IMPORT_PUSH_URL:-${CI_SERVER_URL%/}/${CI_PROJECT_PATH}.git}"
push_home="$(new_scratch_dir)"
push_git() {
  GIT_TERMINAL_PROMPT=0 HOME="$push_home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -c credential.helper= -c "credential.helper=store --file=${credential_file}" "$@"
}

existing_branch="$(push_git ls-remote --heads "$push_url" "refs/heads/${branch_name}")" ||
  fail "could not list the branches of ${CI_PROJECT_PATH}. Check DOOR_IMPORT_TOKEN's scope (write_repository) and role (Developer)."
if [[ -n "$existing_branch" ]]; then
  log "${branch_name} already exists on ${CI_PROJECT_PATH}: this door was proposed from this base already; opening nothing."
  exit 0
fi
older_proposals="$(push_git ls-remote --heads "$push_url" "refs/heads/${branch_prefix}${new_tree:0:12}-on-*")" ||
  fail "could not list the branches of ${CI_PROJECT_PATH}. Check DOOR_IMPORT_TOKEN's scope (write_repository) and role (Developer)."
while read -r _ ref; do
  [[ -n "$ref" ]] || continue
  log "${ref#refs/heads/} is an earlier proposal of this door from an older base; close it by hand (decision 12a)."
done <<< "$older_proposals"

# --- Commit, push, and open the merge request --------------------------------

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
# `git add` skips, without a word, anything .gitignore matches. A copy that is
# not all committed would leave door.upstream.json's tree hash out of step with
# what the merge request carries, and `fast` would fail on it for ever.
left_out="$(
  comm -z -23 \
    <(cd "$repo_dir" && find "$copy_rel" "$record_rel" -type f -print0 | LC_ALL=C sort -z) \
    <(git -C "$repo_dir" ls-files -z -- "$copy_rel" "$record_rel" | LC_ALL=C sort -z) |
    tr '\0' '\n'
)"
if [[ -n "$left_out" ]]; then
  fail "these imported files are ignored by git (see .gitignore) and would be left out of the commit: $(printf '%s' "$left_out" | tr '\n' ' ')"
fi
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
merges itself.

Cut: risk -- a vendored copy of another project's code is a dependency change and belongs on its own."

push_repo="$(new_scratch_dir)"
git init -q "$push_repo"
# The CI checkout is a shallow clone, and a push out of one is a "shallow
# update" the receiving side refuses by default (repin pipeline 1553).
git -C "$push_repo" config receive.shallowUpdate true
# Pushed from the checkout into the scratch repository rather than fetched out
# of it, so git's ownership check never runs against the checkout (repin
# pipeline 1547).
git -C "$repo_dir" push -q "$push_repo" "refs/heads/${branch_name}:refs/heads/${branch_name}"
# The push options ask GitLab to open the merge request itself, so this needs
# no API call and no `api` scope. No --force: the branch was just seen not to
# exist, and an existing one is never overwritten.
push_git -C "$push_repo" push -q \
  -o merge_request.create \
  -o "merge_request.target=${target_branch}" \
  -o "merge_request.title=Import the door from ${upstream_project} ${short_sha}" \
  -o "merge_request.label=dependencies" \
  -o merge_request.remove_source_branch \
  "$push_url" "refs/heads/${branch_name}:refs/heads/${branch_name}" ||
  fail "the push of ${branch_name} was refused or failed. Check DOOR_IMPORT_TOKEN's scope (write_repository) and role (Developer) on ${CI_PROJECT_PATH}."
log "pushed ${branch_name}; GitLab opens the merge request into ${target_branch} from the push options."
