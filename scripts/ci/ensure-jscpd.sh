#!/usr/bin/env bash
#
# Puts a pinned, verified jscpd in a cache dir and prints its absolute path --
# the one place the pin lives, used by scripts/ci/scan-jscpd.sh (#1596).
#
# jscpd finds duplicated code (copy/paste detector). MIT,
# https://github.com/kucherenko/jscpd. Owner decision 104a (2026-11-25): an
# exact 5.x version, the line published with npm provenance, CI only. 5.x is
# a Rust rewrite released as prebuilt binaries, so this takes the official
# linux x86_64 musl (statically linked) release tarball, as #1592's tools do,
# rather than the npm package, which only wraps the same binary.
# Pinned to v5.4.3 (published 2026-11-08), the newest release at least 3 days
# old on 2026-11-25.
#
# Checksums: the tarball hash is the line for jscpd-linux-x64-musl.tar.gz in
# the release's checksums.txt, which also matches the digest GitHub records
# for the asset and our own download. The extracted binary's hash is recorded
# by us, so a cached copy can be re-verified without the tarball.
#
# Usage:
#   jscpd="$(bash scripts/ci/ensure-jscpd.sh)"
#
# Output: the absolute path of a verified jscpd on stdout; progress on
# stderr. Cache: ${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}.
# ORBIT_JSCPD_URL replaces the download URL (tests use file://); the pins
# below are not overridable, so anything else is refused, never run.
# Linux x86_64 only.
#
# To bump: pick a release at least 3 days old, take the musl tarball's line
# from its checksums.txt, download it, confirm it matches, extract it,
# sha256sum the `jscpd` binary, and update the three constants below.
set -Eeuo pipefail

readonly JSCPD_VERSION="5.4.3"
readonly JSCPD_SHA256="291452d6005e3fa17b531552bf76f87ff85bc4ae31533e0c17a7997f84079868"
readonly JSCPD_BINARY_SHA256="0fb4428c75c17954479aec51dc6509cc26be665131e6fcf96429bd6b3bb0d5a4"
readonly JSCPD_DEFAULT_URL="https://github.com/kucherenko/jscpd/releases/download/v${JSCPD_VERSION}/jscpd-linux-x64-musl.tar.gz"

fail() { printf 'ensure-jscpd: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] ||
  fail "only linux x86_64 is supported (found $(uname -s)-$(uname -m))"

url="${ORBIT_JSCPD_URL:-$JSCPD_DEFAULT_URL}"
cache_dir="${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}"
dir="${cache_dir}/jscpd-${JSCPD_VERSION}"
binary="${dir}/jscpd"

verify() { # file expected-sha256
  printf '%s  %s\n' "$2" "$1" | sha256sum -c - > /dev/null 2>&1
}

if [[ -x "$binary" ]] && verify "$binary" "$JSCPD_BINARY_SHA256"; then
  printf '%s\n' "$binary"
  exit 0
fi

mkdir -p "$dir"
work="$(mktemp -d "${dir}/work.XXXXXX")"
trap 'rm -rf "$work"' EXIT

printf 'ensure-jscpd: downloading jscpd v%s\n' "$JSCPD_VERSION" >&2
# https only, apart from file:// for a local override; the hash decides either way.
curl --silent --show-error --fail --location --proto '=https,file' --max-time 300 \
  --output "${work}/download.tar.gz" "$url" ||
  fail "could not download jscpd v${JSCPD_VERSION} from ${url}"
verify "${work}/download.tar.gz" "$JSCPD_SHA256" ||
  fail "downloaded jscpd tarball does not match the pinned SHA-256 ${JSCPD_SHA256}; refusing to use it"
tar -xzf "${work}/download.tar.gz" -C "$work" jscpd ||
  fail "could not extract jscpd from the tarball"
verify "${work}/jscpd" "$JSCPD_BINARY_SHA256" ||
  fail "extracted jscpd does not match the pinned SHA-256 ${JSCPD_BINARY_SHA256}; refusing to run it"
chmod +x "${work}/jscpd"
mv -f "${work}/jscpd" "$binary"
printf '%s\n' "$binary"
