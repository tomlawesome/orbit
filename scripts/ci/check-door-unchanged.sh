#!/usr/bin/env bash
# Fails when the copy of orbit-site's door folder has been edited by hand
# (#1371, item 6): the copy in web/src/lib/door/ is only ever changed by
# scripts/ci/import-door.sh, which records the sha256 tree hash of what it
# wrote in web/src/lib/door.upstream.json. This recomputes that hash from the
# files on disk and compares. A changed, added, renamed or deleted file in the
# copy all fail it; the fix is to make the change in ai/orbit-site (ADR-0001
# there) and let the import carry it here, not to edit the copy.
#
# Offline and cheap: it reads two paths in this checkout and runs sha256sum
# over them. No token, no network, no git.
#
# While neither the copy nor the record exists, nothing has been imported yet:
# that passes, and says so. One without the other is a failure.
#
# Usage:
#   scripts/ci/check-door-unchanged.sh
set -Eeuo pipefail
set +x

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ci/door-tree-hash.sh
source "$repo_dir/scripts/ci/door-tree-hash.sh"

copy_dir="$repo_dir/web/src/lib/door"
record_file="$repo_dir/web/src/lib/door.upstream.json"

log() { printf 'check-door-unchanged: %s\n' "$1"; }
fail() { printf 'check-door-unchanged: %s\n' "$1" >&2; exit 1; }

if [[ ! -e "$copy_dir" && ! -e "$record_file" ]]; then
  log "the door has not been imported yet (no web/src/lib/door/ and no door.upstream.json); nothing to check."
  exit 0
fi
[[ -d "$copy_dir" ]] || fail "web/src/lib/door.upstream.json exists but the door copy web/src/lib/door/ does not."
[[ -f "$record_file" ]] || fail "the door copy web/src/lib/door/ exists but web/src/lib/door.upstream.json does not, so it cannot be checked."

recorded="$(node -e '
  const record = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof record.tree === "string" ? record.tree : "");
' "$record_file")" || fail "web/src/lib/door.upstream.json is not valid JSON."
[[ "$recorded" =~ ^[0-9a-f]{64}$ ]] || fail "web/src/lib/door.upstream.json has no sha256 \"tree\"."

actual="$(door_tree_hash "$copy_dir")" || fail "could not hash the door copy web/src/lib/door/."

if [[ "$actual" != "$recorded" ]]; then
  fail "the door copy web/src/lib/door/ was edited: its tree hash is ${actual}, door.upstream.json records ${recorded}. The copy is only ever changed by scripts/ci/import-door.sh; make the change in ai/orbit-site's assets/door/ instead (#1371)."
fi
log "the door copy matches door.upstream.json (${recorded})."
