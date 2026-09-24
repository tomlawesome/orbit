#!/usr/bin/env bash
#
# Puts a pinned crane on PATH and prints its path (#1114). Replaces
# imjasonh/setup-crane, which with no `with: version` installs whatever
# crane is newest on every run, with no checksum or signature check, inside
# jobs that hold GHCR push and GitLab read tokens; the action also did an
# implicit `crane auth login ghcr.io` with the job token, which the explicit
# login steps in publish-from-gitlab.yml and countersign.yml already cover.
#
# crane is google/go-containerregistry's registry CLI, used here to copy and
# verify digests between registries (Apache-2.0,
# https://github.com/google/go-containerregistry). Installed as a release
# tarball pinned by version and SHA-256 checksum, like the cosign pin in
# scripts/ci/ensure-cosign.sh; the checksum below is the tarball's own entry
# from that release's checksums.txt (v0.22.1 verified current 2026-09-24, and
# current on google/go-containerregistry's GitHub releases as of that date).
# The checksum covers the tarball, not the extracted binary -- there is no
# published checksum for the binary alone -- so the cache keeps the verified
# tarball and re-verifies it before trusting an already-extracted binary.
#
# Usage:
#   crane_dir="$(bash scripts/ci/ensure-crane.sh)"
#   export PATH="${crane_dir}:${PATH}"
#
# Output: the absolute path of the directory containing a verified crane
# binary on stdout; progress on stderr. An already-installed crane of
# exactly the pinned version is used as is; anything else is downloaded,
# checksum-verified, extracted and cached under ORBIT_CRANE_DIR (default:
# .orbit-crane/ in the repository root).
set -Eeuo pipefail

readonly CRANE_VERSION="0.22.1"
readonly CRANE_SHA256="0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0"
readonly CRANE_URL="https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

fail() { printf 'ensure-crane: %s\n' "$1" >&2; exit 1; }

# A crane already on PATH is only trusted at exactly the pinned version:
# "some crane" is not a pin.
if command -v crane > /dev/null 2>&1; then
  # `crane version` prints the bare version string alone, so no pipeline is
  # needed here -- unlike ensure-cosign.sh's --json form, there is no early-
  # exit consumer downstream of a pipe to race a SIGPIPE against (#809).
  installed="$(crane version 2> /dev/null || :)"
  if [[ "$installed" == "$CRANE_VERSION" ]]; then
    dirname -- "$(command -v crane)"
    exit 0
  fi
  printf 'ensure-crane: PATH has crane %s, not the pinned %s; installing the pin.\n' \
    "${installed:-<unknown>}" "$CRANE_VERSION" >&2
fi

cache_dir="${ORBIT_CRANE_DIR:-${repo_root}/.orbit-crane}"
tarball="${cache_dir}/go-containerregistry_${CRANE_VERSION}_Linux_x86_64.tar.gz"
binary="${cache_dir}/crane-${CRANE_VERSION}"

verify_tarball() {
  printf '%s  %s\n' "$CRANE_SHA256" "$tarball" | sha256sum -c - > /dev/null 2>&1
}

use_cached() {
  [[ -x "$binary" ]] && [[ -f "$tarball" ]] && verify_tarball
}

if use_cached; then
  ln -sf "$(basename -- "$binary")" "${cache_dir}/crane"
  printf '%s\n' "$cache_dir"
  exit 0
fi

mkdir -p "$cache_dir"
printf 'ensure-crane: downloading crane v%s\n' "$CRANE_VERSION" >&2
curl --silent --show-error --fail --location --max-time 300 \
  --output "${tarball}.download" "$CRANE_URL" ||
  fail "could not download crane v${CRANE_VERSION} from ${CRANE_URL}"
mv "${tarball}.download" "$tarball"
verify_tarball ||
  fail "downloaded crane does not match the pinned SHA-256 ${CRANE_SHA256}; refusing to run it"

# Extract only the crane binary; the tarball also ships gcrane and a LICENSE.
tar -xzf "$tarball" -C "$cache_dir" crane
mv "${cache_dir}/crane" "$binary"
chmod +x "$binary"
ln -sf "$(basename -- "$binary")" "${cache_dir}/crane"

printf '%s\n' "$cache_dir"
