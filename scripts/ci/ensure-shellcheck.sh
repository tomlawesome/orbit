#!/usr/bin/env bash
#
# Prints the path of a pinned, checksum-verified shellcheck (#1592).
#
# ShellCheck is the static analyser for shell scripts, GPL-3.0,
# https://github.com/koalaman/shellcheck. v0.11.0 is the owner's pin
# (#1592 note 69988, 2026-11-24). Installed from the official GitHub release
# tarball for linux x86_64, over HTTPS, pinned by version and SHA-256.
#
# Where the checksums come from: upstream publishes NO checksum or signature
# for its release assets, so we recorded them ourselves on 2026-11-24: the
# SHA-256 of the downloaded shellcheck-v0.11.0.linux.x86_64.tar.xz, and of the
# shellcheck binary extracted from it. The tarball is checked before it is
# unpacked; the binary is checked again on every reuse of the cache. This
# guards against a changed or corrupted asset after the pin, not against an
# upstream that was already compromised when we recorded it.
#
# Usage:
#   shellcheck="$(bash scripts/ci/ensure-shellcheck.sh)"
#
# Output: the absolute path of a verified binary on stdout; progress on
# stderr. Linux x86_64 only. Cache: ${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}.
#
# To bump: set SHELLCHECK_VERSION, download the new tarball, record its
# sha256sum as SHELLCHECK_TARBALL_SHA256, extract it and record the sha256sum
# of the shellcheck binary as SHELLCHECK_BINARY_SHA256, and update the date
# above. A version-only bump fails the checksum check below, by design.
set -Eeuo pipefail

readonly SHELLCHECK_VERSION="0.11.0"
readonly SHELLCHECK_TARBALL_SHA256="8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198"
readonly SHELLCHECK_BINARY_SHA256="4da528ddb3a4d1b7b24a59d4e16eb2f5fd960f4bd9a3708a15baddbdf1d5a55b"
readonly SHELLCHECK_URL="https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz"

fail() { printf 'ensure-shellcheck: %s\n' "$1" >&2; exit 1; }

verify() { # verify <sha256> <file>
  printf '%s  %s\n' "$1" "$2" | sha256sum -c - > /dev/null 2>&1
}

cache_dir="${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}"
binary="${cache_dir}/shellcheck-${SHELLCHECK_VERSION}"

if [[ -x "$binary" ]] && verify "$SHELLCHECK_BINARY_SHA256" "$binary"; then
  printf '%s\n' "$binary"
  exit 0
fi

mkdir -p "$cache_dir"
work="$(mktemp -d "${cache_dir}/shellcheck-work.XXXXXX")"
trap 'rm -rf "$work"' EXIT

printf 'ensure-shellcheck: downloading shellcheck v%s\n' "$SHELLCHECK_VERSION" >&2
curl --silent --show-error --fail --location --proto '=https' --max-time 300 \
  --output "${work}/shellcheck.tar.xz" "$SHELLCHECK_URL" ||
  fail "could not download shellcheck v${SHELLCHECK_VERSION} from ${SHELLCHECK_URL}"
verify "$SHELLCHECK_TARBALL_SHA256" "${work}/shellcheck.tar.xz" ||
  fail "downloaded tarball does not match the pinned SHA-256 ${SHELLCHECK_TARBALL_SHA256}; refusing to unpack it"
tar -xJf "${work}/shellcheck.tar.xz" -C "$work" "shellcheck-v${SHELLCHECK_VERSION}/shellcheck" ||
  fail "could not extract shellcheck from the tarball"
extracted="${work}/shellcheck-v${SHELLCHECK_VERSION}/shellcheck"
verify "$SHELLCHECK_BINARY_SHA256" "$extracted" ||
  fail "extracted shellcheck does not match the pinned SHA-256 ${SHELLCHECK_BINARY_SHA256}; refusing to run it"
chmod +x "$extracted"
mv "$extracted" "${binary}.new"
mv "${binary}.new" "$binary"
printf '%s\n' "$binary"
