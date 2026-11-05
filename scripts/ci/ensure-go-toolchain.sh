#!/usr/bin/env bash
#
# Installs the Go toolchain a go.mod asks for, after checking it (#1727, S-ci-2).
# upgrade_cell_launcher and launcher_install_compat used to download the Go
# tarball from go.dev and unpack it unchecked, in jobs that hold protected
# tokens. The version is read from the launcher's go.mod at run time, so a
# sha256 pinned in this repo would drift on every launcher bump; the checksum
# is taken instead from go.dev's published release list
# (https://go.dev/dl/?mode=json&include=all, each file carries a `sha256`).
# That catches a corrupted download or a tampered mirror. It does not catch a
# compromised go.dev; that limit is accepted.
#
# Usage:
#   bash scripts/ci/ensure-go-toolchain.sh path/to/go.mod
#
# The version is the `toolchain go<v>` line, else the `go <v>` line; neither
# is an error. The tarball and the release list go to a temporary directory,
# the tarball is unpacked into the prefix only after `sha256sum -c` passes, and
# every failure exits non-zero with a reason on stderr and the prefix untouched.
#
# Environment (all optional; the tests point these at file:// fixtures):
#   ORBIT_GO_DL_BASE      tarball base URL (default https://go.dev/dl)
#   ORBIT_GO_DL_JSON_URL  release list URL (default https://go.dev/dl/?mode=json&include=all)
#   ORBIT_GO_PREFIX       install prefix (default /usr/local); unpacks to <prefix>/go
set -Eeuo pipefail

fail() { printf 'ensure-go-toolchain: %s\n' "$1" >&2; exit 1; }

[[ $# -eq 1 ]] || fail "usage: ensure-go-toolchain.sh <path/to/go.mod>"
go_mod="$1"
[[ -f "$go_mod" ]] || fail "${go_mod} not found"

base="${ORBIT_GO_DL_BASE:-https://go.dev/dl}"
json_url="${ORBIT_GO_DL_JSON_URL:-https://go.dev/dl/?mode=json&include=all}"
prefix="${ORBIT_GO_PREFIX:-/usr/local}"

version="$(sed -n 's/^toolchain go//p' "$go_mod" | head -1 | tr -d '[:space:]')"
[[ -n "$version" ]] || version="$(sed -n 's/^go //p' "$go_mod" | head -1 | tr -d '[:space:]')"
[[ -n "$version" ]] || fail "${go_mod} names no go version"
# The version goes into a URL and a file name: allow only what a Go version holds.
[[ "$version" =~ ^[0-9][0-9A-Za-z.+-]*$ ]] || fail "unexpected go version '${version}' in ${go_mod}"

filename="go${version}.linux-amd64.tar.gz"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

printf 'ensure-go-toolchain: downloading %s\n' "$filename" >&2
curl --silent --show-error --fail --location --max-time 300 \
  --output "${work}/${filename}" "${base}/${filename}" ||
  fail "could not download ${base}/${filename}"
curl --silent --show-error --fail --location --max-time 120 \
  --output "${work}/releases.json" "$json_url" ||
  fail "could not download the release list ${json_url}"

# The values travel as argv, never inside the JS source.
expected="$(node -e '
  const [list, name] = process.argv.slice(1);
  const releases = JSON.parse(require("fs").readFileSync(list, "utf8"));
  for (const r of releases)
    for (const f of r.files || [])
      if (f.filename === name) { process.stdout.write(String(f.sha256 ?? "")); process.exit(0); }
' "${work}/releases.json" "$filename")" ||
  fail "could not read the release list ${json_url}"
[[ -n "$expected" ]] || fail "the release list has no entry for ${filename}"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "the release list's sha256 for ${filename} is not 64 hex characters"

if ! printf '%s  %s\n' "$expected" "${work}/${filename}" | sha256sum -c - > /dev/null 2>&1; then
  actual="$(sha256sum -- "${work}/${filename}" | cut -d' ' -f1)"
  fail "${filename} does not match go.dev's published sha256: expected ${expected}, got ${actual}; refusing to unpack it"
fi

mkdir -p "$prefix"
tar -C "$prefix" -xzf "${work}/${filename}"
printf 'ensure-go-toolchain: installed go%s into %s\n' "$version" "$prefix" >&2
