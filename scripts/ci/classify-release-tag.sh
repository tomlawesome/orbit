#!/usr/bin/env bash
#
# Classifies a `vX.Y.Z` release tag as "stable" or "prerelease" (#1121).
# release-on-tag.yml uses this to decide whether `gh release create` gets
# `--prerelease --latest=false`: a plain `vX.Y.Z` tag behaves as it always
# has, but a semver pre-release shape (`vX.Y.Z-e2e.N`, `vX.Y.Z-rc.N`, ...)
# must never become GitHub's Latest release, since scripts/get-orbit.sh's
# default `ORBIT_CHANNEL=latest` fetches whatever holds that title.
#
# Bash only, no node/jq: the GitHub-hosted `ubuntu-latest` runner this job
# uses has both, but this script also runs in a plain shell as part of the
# release step's own inline `run:` logic.
#
# Usage:
#   scripts/ci/classify-release-tag.sh <tag>
#
# Prints "stable" or "prerelease" on stdout. Refuses, on stderr, exit 1, a
# tag that is not a valid `vX.Y.Z` or `vX.Y.Z-<prerelease>` (semver-shaped,
# dot-separated alphanumeric/hyphen identifiers after the `-`).
set -Eeuo pipefail

fail() { printf 'classify-release-tag: %s\n' "$1" >&2; exit 1; }

tag="${1:-}"
[[ -n "$tag" ]] || fail 'a tag is required as the first argument'

if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'stable\n'
elif [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*$ ]]; then
  printf 'prerelease\n'
else
  fail "${tag} does not look like vX.Y.Z or vX.Y.Z-<prerelease>"
fi
