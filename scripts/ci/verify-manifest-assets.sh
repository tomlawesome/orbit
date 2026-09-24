#!/usr/bin/env bash
#
# Checks that a set of downloaded files match the sha256s
# orbit-release-manifest.json records for them (ADR-0031 #1/#5). Shared by
# publish-from-gitlab.yml and release-on-tag.yml so "does this file match
# what the manifest says" has one implementation rather than two workflow
# scripts computing sha256sum independently and drifting.
#
# This does not check the manifest's own signature -- that is
# scripts/ci/verify-release-manifest.sh, called separately, first. This
# script only checks the manifest's own claims against bytes on disk, the
# same way scripts/get-orbit.sh checks the files it downloads (#6).
#
# Usage:
#   scripts/ci/verify-manifest-assets.sh <manifest-path> <name>=<path> [<name>=<path> ...]
#
# <name> is the key under the manifest's "files" object (e.g.
# "orbit-launcher_linux_amd64.tar.gz", "install.sh"); <path> is where that
# file was downloaded or checked out.
#
# Output: one acceptance line per file on success; a refusal naming the file
# and the mismatch, on stderr, exit 1.
set -Eeuo pipefail

fail() { printf 'verify-manifest-assets: %s\n' "$1" >&2; exit 1; }

manifest_path="${1:-}"
[[ -n "$manifest_path" ]] || fail 'a manifest path is required as the first argument'
[[ -f "$manifest_path" ]] || fail "no manifest at ${manifest_path}"
shift || true
(( $# > 0 )) || fail 'at least one name=path pair is required'

manifest_sha() {
  node -e '
    const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = doc?.files?.[process.argv[2]];
    process.stdout.write(typeof value === "string" ? value : "");
  ' -- "$manifest_path" "$1"
}

for pair in "$@"; do
  name="${pair%%=*}"
  path="${pair#*=}"
  [[ "$pair" == *=* && -n "$name" && -n "$path" ]] || fail "malformed argument, want name=path: ${pair}"
  [[ -f "$path" ]] || fail "${name}: no file at ${path}"

  expected="$(manifest_sha "$name")"
  [[ "$expected" == sha256:* ]] || fail "${name}: manifest has no sha256 recorded for it"

  actual="sha256:$(sha256sum "$path" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] ||
    fail "${name}: ${path} is ${actual}, the manifest says ${expected}"

  printf 'verify-manifest-assets: %s matches the manifest (%s)\n' "$name" "$expected"
done
