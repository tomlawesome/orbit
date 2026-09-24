#!/usr/bin/env bash
#
# The one place the branch -> channel-name mapping lives: "preview" for the
# preview branch, "hotfix-<name>" for hotfix/<name> (sanitised the same way
# publish-channel.sh always has), refusing anything else. Shared by
# scripts/ci/publish-channel.sh (the consumer-visible channel tag) and
# scripts/ci/write-release-manifest.sh (the manifest's "channel" field, ADR-0031
# #1) so the mapping cannot fork into two copies that drift, and so
# record_image's job script in .gitlab-ci.yml carries no channel logic of its
# own -- it only calls write-release-manifest.sh, which calls this.
#
# Usage:
#   scripts/ci/channel-name.sh <branch>
#
# Prints the channel name on stdout. Refuses, on stderr, exit 1, a branch
# that is neither preview nor hotfix/*; the caller is responsible for wording
# that refusal for its own context (publish-channel.sh: "not a publishing
# branch"; write-release-manifest.sh: the manifest has nothing to record).
set -Eeuo pipefail

fail() { printf 'channel-name: %s\n' "$1" >&2; exit 1; }

branch="${1:-}"
[[ -n "$branch" ]] || fail 'a branch is required as the first argument'

case "$branch" in
  preview) printf 'preview\n' ;;
  hotfix/*) printf 'hotfix-%s\n' "$(printf '%s' "${branch#hotfix/}" | tr -c 'A-Za-z0-9._-' '-')" ;;
  *) fail "${branch} is neither preview nor hotfix/*" ;;
esac
