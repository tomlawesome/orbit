#!/usr/bin/env bash
#
# Puts a pinned, verified zizmor in a cache dir and prints its absolute path --
# the one place the pin lives, used by scripts/ci/scan-zizmor.sh (#1592).
#
# zizmor is a static analyser for GitHub Actions workflows (template
# injection, unpinned actions, excessive permissions, ...). MIT,
# https://github.com/zizmorcore/zizmor. Pinned to v1.32.0 on the owner's choice
# (#1592): the newest release at least 3 days old on 2026-11-24; v1.33.x were
# 2 days old. Installed as the official prebuilt linux x86_64 release tarball.
#
# Checksums: upstream publishes no checksum file for this release. The
# tarball hash below is the sha256 digest GitHub records for the release asset
# (`gh release view v1.32.0 -R zizmorcore/zizmor --json assets`), which we also
# confirmed against our own download. The extracted binary's hash is recorded
# by us, so a cached copy can be re-verified without the tarball.
#
# Usage:
#   zizmor="$(bash scripts/ci/ensure-zizmor.sh)"
#
# Output: the absolute path of a verified zizmor on stdout; progress on
# stderr. Cache: ${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}.
# Anything that does not match is refused, never run. Linux x86_64 only.
#
# To bump: pick the new tag, take the linux x86_64 tarball digest from the
# release page, download it, confirm it matches, extract it, sha256sum the
# `zizmor` binary, and update the three constants below.
set -Eeuo pipefail

readonly ZIZMOR_VERSION="1.32.0"
readonly ZIZMOR_TARBALL_SHA256="bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b"
readonly ZIZMOR_BINARY_SHA256="04d55fb88e582a8e9a9ce6b4753df723fc44c35e0d1a8e8771db9e017066c6df"
readonly ZIZMOR_URL="https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu.tar.gz"

fail() { printf 'ensure-zizmor: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] ||
  fail "only linux x86_64 is supported (found $(uname -s)-$(uname -m))"

cache_dir="${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}"
dir="${cache_dir}/zizmor-${ZIZMOR_VERSION}"
binary="${dir}/zizmor"

verify() { # file expected-sha256
  printf '%s  %s\n' "$2" "$1" | sha256sum -c - > /dev/null 2>&1
}

if [[ -x "$binary" ]] && verify "$binary" "$ZIZMOR_BINARY_SHA256"; then
  printf '%s\n' "$binary"
  exit 0
fi

mkdir -p "$dir"
work="$(mktemp -d "${dir}/work.XXXXXX")"
trap 'rm -rf "$work"' EXIT

printf 'ensure-zizmor: downloading zizmor v%s\n' "$ZIZMOR_VERSION" >&2
curl --silent --show-error --fail --location --proto '=https' --max-time 300 \
  --output "${work}/zizmor.tar.gz" "$ZIZMOR_URL" ||
  fail "could not download zizmor v${ZIZMOR_VERSION} from ${ZIZMOR_URL}"
verify "${work}/zizmor.tar.gz" "$ZIZMOR_TARBALL_SHA256" ||
  fail "downloaded zizmor tarball does not match the pinned SHA-256 ${ZIZMOR_TARBALL_SHA256}; refusing to use it"
tar -xzf "${work}/zizmor.tar.gz" -C "$work" zizmor ||
  fail "could not extract zizmor from the tarball"
verify "${work}/zizmor" "$ZIZMOR_BINARY_SHA256" ||
  fail "extracted zizmor does not match the pinned SHA-256 ${ZIZMOR_BINARY_SHA256}; refusing to run it"
chmod +x "${work}/zizmor"
mv -f "${work}/zizmor" "$binary"
printf '%s\n' "$binary"
