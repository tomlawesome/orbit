#!/usr/bin/env bash
#
# Installs a pinned ruff and prints its absolute path -- the one place the pin
# lives, used by scripts/ci/scan-ruff.sh (#1592, report-only code scanning).
#
# ruff is Astral's Python linter; we run only its security rules (S, the
# flake8-bandit reimplementation). MIT, https://github.com/astral-sh/ruff.
# 0.17.6 was the owner's choice (#1592 note 69988, 2026-11-24); it was the
# newest release at least 3 days old that day. The release is immutable.
#
# Verification: the official release tarball
# ruff-x86_64-unknown-linux-musl.tar.gz is checked against RUFF_TARBALL_SHA256,
# the value in upstream's own ruff-x86_64-unknown-linux-musl.tar.gz.sha256 file
# (it also equals the digest GitHub shows for the asset). The extracted binary's
# SHA-256 (RUFF_BINARY_SHA256, recorded by us after extracting that verified
# tarball) is what a cached copy is re-verified against on every run.
#
# Usage:
#   ruff="$(bash scripts/ci/ensure-ruff.sh)"
#
# Output: the absolute path of a verified ruff on stdout; progress on stderr.
# Cache: ${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}.
# Linux x86_64 only. Refuses (non-zero) on any download or checksum failure and
# never runs an unverified file.
#
# To bump: pick the new tag, copy the hash from
#   https://github.com/astral-sh/ruff/releases/download/<tag>/ruff-x86_64-unknown-linux-musl.tar.gz.sha256
# into RUFF_TARBALL_SHA256, extract the tarball and sha256sum its ruff into
# RUFF_BINARY_SHA256, and change RUFF_VERSION.
set -Eeuo pipefail

readonly RUFF_VERSION="0.17.6"
readonly RUFF_TARBALL_SHA256="3c8d5a4264558df8b1587ce32409b658069b6a1ef5bfe4d279431eb1db62a183"
readonly RUFF_BINARY_SHA256="427390db027ec004b71f15f62103c610e2219f284238eed0d42085b16a0085ea"
readonly RUFF_URL="https://github.com/astral-sh/ruff/releases/download/${RUFF_VERSION}/ruff-x86_64-unknown-linux-musl.tar.gz"

fail() { printf 'ensure-ruff: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] || fail "Linux x86_64 only"

cache_dir="${ORBIT_TOOL_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orbit-tools}"
dir="${cache_dir}/ruff-${RUFF_VERSION}"
binary="${dir}/ruff"

verify() { # file sha256
  printf '%s  %s\n' "$2" "$1" | sha256sum -c - > /dev/null 2>&1
}

if [[ -x "$binary" ]] && verify "$binary" "$RUFF_BINARY_SHA256"; then
  printf '%s\n' "$binary"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/ensure-ruff.XXXXXX")"
trap 'rm -rf "$work"' EXIT
printf 'ensure-ruff: downloading ruff %s\n' "$RUFF_VERSION" >&2
curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --max-time 300 \
  --output "${work}/ruff.tar.gz" "$RUFF_URL" ||
  fail "could not download ruff ${RUFF_VERSION} from ${RUFF_URL}"
verify "${work}/ruff.tar.gz" "$RUFF_TARBALL_SHA256" ||
  fail "downloaded ruff tarball does not match the pinned SHA-256 ${RUFF_TARBALL_SHA256}; refusing to use it"
tar -xzf "${work}/ruff.tar.gz" -C "$work" "ruff-x86_64-unknown-linux-musl/ruff" ||
  fail "ruff tarball does not contain the expected binary"
verify "${work}/ruff-x86_64-unknown-linux-musl/ruff" "$RUFF_BINARY_SHA256" ||
  fail "extracted ruff does not match the pinned SHA-256 ${RUFF_BINARY_SHA256}; refusing to run it"
chmod +x "${work}/ruff-x86_64-unknown-linux-musl/ruff"
mkdir -p "$dir"
mv "${work}/ruff-x86_64-unknown-linux-musl/ruff" "${binary}.new"
mv "${binary}.new" "$binary"
printf '%s\n' "$binary"
