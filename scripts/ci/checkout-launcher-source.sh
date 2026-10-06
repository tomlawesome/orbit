#!/usr/bin/env bash
#
# Checks out the orbit-launcher source launcher/pin.json names, for the
# launcher_install_compat job's live tests. The tag alone is movable: what
# was reviewed is the pinned commit, so this refuses unless the tag resolves
# to it -- the same refusal scripts/ci/build-launcher.sh makes before
# building the shipped binary.
#
# Usage: scripts/ci/checkout-launcher-source.sh <destination-dir>
#
# Inputs (environment), as build-launcher.sh:
#   ORBIT_LAUNCHER_REMOTE    Repository to clone (default: the GitHub mirror).
#   ORBIT_LAUNCHER_PIN_FILE  Pin file (default: launcher/pin.json).
set -Eeuo pipefail

repo_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

fail() { printf 'checkout-launcher-source: %s\n' "$1" >&2; exit 1; }

dest="${1:-}"
[[ -n "$dest" ]] || fail 'a destination directory is required as the first argument'
[[ ! -e "$dest" ]] || fail "${dest} already exists; refusing to clone over it"

pin_file="${ORBIT_LAUNCHER_PIN_FILE:-${repo_root}/launcher/pin.json}"
[[ -f "$pin_file" ]] || fail "no pin file at ${pin_file}"

# Same reader as build-launcher.sh. `;T;q`, not `| head -n1`: a head exiting
# early would SIGPIPE sed into a 141 under pipefail; T skips `q` until the
# substitution matches, so sed stops at the first match with no pipe at all.
read_pin_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p;T;q" "$pin_file"
}
pin_tag="$(read_pin_field tag)"
pin_commit="$(read_pin_field commit)"

[[ "$pin_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
  fail "${pin_file}'s tag is not a plain vX.Y.Z tag: ${pin_tag:-<missing>}"
[[ "$pin_commit" =~ ^[0-9a-f]{40}$ ]] ||
  fail "${pin_file}'s commit is not a 40-hex sha: ${pin_commit:-<missing>}"

remote="${ORBIT_LAUNCHER_REMOTE:-https://github.com/tomlawesome/orbit-launcher.git}"

git clone --quiet "$remote" "$dest" || fail "could not clone ${remote}"
git -C "$dest" checkout --quiet "$pin_tag" ||
  fail "${remote} has no tag ${pin_tag}"

head_commit="$(git -C "$dest" rev-parse HEAD)"
[[ "$head_commit" == "$pin_commit" ]] ||
  fail "${remote}'s ${pin_tag} resolves to ${head_commit}, not ${pin_file}'s pinned commit ${pin_commit}; refusing to test an unpinned source"
printf 'checkout-launcher-source: checked out %s at pinned commit %s\n' "$pin_tag" "$pin_commit"
