#!/usr/bin/env bash
#
# Bumps launcher/pin.json (ADR-0031 #2): the tag and commit build_launcher
# builds from (.gitlab-ci.yml), launcher_install_compat tests against, and
# scripts/ci/write-release-manifest.sh writes into the signed release
# manifest. A pin bump is by hand only -- ADR-0031 rules out Renovate here:
# it cannot fill the commit field, and a Renovate MR that fails CI until
# someone finishes it by hand is noise, not automation.
#
# Usage:
#   scripts/bump-launcher-pin.sh <tag>
#
# Resolves <tag> against the launcher's GitHub mirror -- the same source
# build_launcher clones (ADR-0031 #3) -- with `git ls-remote`, peels an
# annotated tag to the commit it actually points at, and writes
# launcher/pin.json. Refuses a tag that is not shaped like vX.Y.Z ("Tag
# alone is movable; commit alone is unreadable" -- ADR-0031 #2, and this
# script exists precisely so the two are never typed independently) and
# refuses a tag the remote does not have.
#
# Inputs (environment):
#   ORBIT_LAUNCHER_REMOTE   The repository to resolve the tag against.
#                           Defaults to
#                           https://github.com/tomlawesome/orbit-launcher.git,
#                           the same mirror build_launcher clones. Overridable
#                           so tests can point this at a local bare repository
#                           instead of the network.
#
# Output: overwrites launcher/pin.json and prints the resolved tag and commit.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'bump-launcher-pin: %s\n' "$1" >&2; exit 1; }

tag="${1:-}"
[[ -n "$tag" ]] || fail 'a tag is required as the first argument, e.g. v0.1.0'
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
  fail "not a plain vX.Y.Z tag: ${tag}"

remote="${ORBIT_LAUNCHER_REMOTE:-https://github.com/tomlawesome/orbit-launcher.git}"

refs="$(git ls-remote "$remote" "refs/tags/${tag}" "refs/tags/${tag}^{}" 2>&1)" ||
  fail "could not read tags from ${remote}: ${refs}"

# An annotated tag lists both refs/tags/<tag> (the tag object) and
# refs/tags/<tag>^{} (the commit it actually points at, "peeled"); a
# lightweight tag lists only the first, which already is the commit. Prefer
# the peeled ref when present so an annotated tag resolves to the commit it
# names, never the tag object's own sha.
commit="$(printf '%s\n' "$refs" | awk -v t="refs/tags/${tag}^{}" '$2 == t { print $1 }')"
if [[ -z "$commit" ]]; then
  commit="$(printf '%s\n' "$refs" | awk -v t="refs/tags/${tag}" '$2 == t { print $1 }')"
fi
[[ -n "$commit" ]] || fail "${remote} has no tag ${tag}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "resolved commit is not a 40-hex sha: ${commit}"

pin_path="${repo_root}/launcher/pin.json"
mkdir -p "$(dirname "$pin_path")"
cat > "$pin_path" <<JSON
{
  "tag": "${tag}",
  "commit": "${commit}"
}
JSON

printf 'bump-launcher-pin: launcher/pin.json now pins %s (%s)\n' "$tag" "$commit"
