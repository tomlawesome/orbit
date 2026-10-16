#!/usr/bin/env bash
# The one definition of "the tree hash" of the door folder (#1371), sourced by
# both scripts/ci/import-door.sh (which records it) and
# scripts/ci/check-door-unchanged.sh (which recomputes it), so the two can
# never disagree about how it is made.
#
# door_tree_hash DIR prints a sha256 over the sorted relative paths and the
# contents of every file under DIR. Concretely it hashes this listing, one
# line per file in byte order of the path:
#
#   <relative path> NUL <sha256 of the file's bytes> NEWLINE
#
# so a changed byte, a renamed file, an added file and a deleted file each
# change the result, and nothing outside DIR, no timestamp and no file mode
# does. Empty directories do not count (git cannot hold them). Anything that
# is neither a regular file nor a directory, such as a symlink, is refused:
# the copy is meant to be plain files, and a link could point outside it.
#
# Needs bash, find, sort, sha256sum and cut; no network and no node.

door_tree_hash() {
  local dir="$1" odd file
  [[ -d "$dir" ]] || {
    printf 'door_tree_hash: %s is not a directory\n' "$dir" >&2
    return 1
  }
  odd="$(cd "$dir" && find . ! -type d ! -type f -print -quit)"
  if [[ -n "$odd" ]]; then
    printf 'door_tree_hash: %s holds something that is not a plain file: %s\n' "$dir" "$odd" >&2
    return 1
  fi
  (
    cd "$dir" || return 1
    find . -type f -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' file; do
      printf '%s\0' "${file#./}"
      sha256sum < "$file" | cut -d' ' -f1
    done | sha256sum | cut -d' ' -f1
  )
}
