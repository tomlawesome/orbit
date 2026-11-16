#!/usr/bin/env bash
#
# Classifies a `vX.Y.Z` release tag as "stable" or "prerelease" (#1121).
# release-on-tag.yml releases only a "stable" tag and refuses anything else
# before publishing (#1848 D-F4): the signed manifest only ever names
# `vX.Y.Z`, so a pre-release shape (`vX.Y.Z-rc.N`, ...) could never get its
# files, and must never become GitHub's Latest release either.
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
