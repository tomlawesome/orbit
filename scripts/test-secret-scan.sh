#!/usr/bin/env bash
# Red-proof for the `gitleaks` CI job (issue #707): a scan that only ever runs
# against a clean repository never proves the scanner would catch anything.
#
# This plants one SYNTHETIC, invented credential in a throwaway git
# repository under a fresh `mktemp -d`, then asserts `gitleaks detect` --
# full history, the same invocation the CI job uses, not `--no-git` -- exits
# non-zero and that both its console output and its JSON report redact the
# value rather than printing it.
#
# The planted value is invented for this test alone. It lives only inside the
# scratch repository below and is destroyed with it on exit; it is never
# committed to Orbit's own history, a fixture, or a test snapshot. It
# deliberately avoids AWS's documented `AKIA...EXAMPLE` key: gitleaks
# allowlists anything ending `EXAMPLE` (config/gitleaks.toml upstream), so
# that value reads as a finding even against a scanner that has stopped
# working.
#
# The scratch commit is built with `git write-tree` / `git commit-tree`
# rather than `git commit`. This host's own pre-commit secret gate exists to
# stop exactly this class of value reaching a real commit, and it is attached
# to the `commit` porcelain command; building the commit object directly
# means there is never a commit for that hook to inspect, so this test does
# not need to (and must never) bypass it with `--no-verify`.
#
# The planted value itself is derived at runtime from a plain seed phrase
# (hashed with sha256sum) rather than written as a literal high-entropy
# string in this file. A literal here would be exactly the shape gitleaks'
# generic-api-key rule looks for, so it would flag this script itself the
# next time the gitleaks job scans Orbit's own history -- the same reason
# scripts/test-malware-scanner.sh assembles its EICAR string only at runtime
# instead of storing the pattern whole.
#
# Usage: scripts/test-secret-scan.sh
set -Eeuo pipefail

# Keep in sync with the `gitleaks` job in .gitlab-ci.yml.
readonly gitleaks_version="8.30.1"
readonly gitleaks_sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

download_dir=""
scratch_repo=""
cleanup() {
  [[ -z "$scratch_repo" ]] || rm -rf -- "$scratch_repo"
  [[ -z "$download_dir" ]] || rm -rf -- "$download_dir"
}
trap cleanup EXIT

gitleaks_bin="$(command -v gitleaks || true)"
if [[ -z "$gitleaks_bin" ]]; then
  echo "gitleaks not found on PATH; downloading pinned v${gitleaks_version}" >&2
  download_dir="$(mktemp -d)"
  tarball="$download_dir/gitleaks.tar.gz"
  curl -fsSL -o "$tarball" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/gitleaks_${gitleaks_version}_linux_x64.tar.gz"
  echo "${gitleaks_sha256}  ${tarball}" | sha256sum -c -
  tar -xzf "$tarball" -C "$download_dir" gitleaks
  gitleaks_bin="$download_dir/gitleaks"
  chmod +x "$gitleaks_bin"
fi

# Synthetic and invented for this test only -- not a real credential, never
# reused anywhere else, derived at runtime (see the file header), and never
# AWS's allowlisted AKIA...EXAMPLE value.
seed_phrase="orbit issue 707 gitleaks red-proof synthetic seed, not a secret"
secret_value="$(printf '%s' "$seed_phrase" | sha256sum | cut -c1-40)"

scratch_repo="$(mktemp -d)"
(
  cd "$scratch_repo"
  git init -q
  git config user.email "gitleaks-red-proof@example.invalid"
  git config user.name "gitleaks red-proof"
  printf 'aws_secret_access_key = %s\n' "$secret_value" > planted-secret.txt
  git add planted-secret.txt
  tree="$(git write-tree)"
  commit="$(git commit-tree "$tree" -m "synthetic secret for gitleaks red-proof test")"
  git update-ref refs/heads/main "$commit"
)

report_file="$scratch_repo-report.json"
set +e
scan_output="$("$gitleaks_bin" detect --source "$scratch_repo" --redact --no-banner \
  --report-format json --report-path "$report_file" 2>&1)"
scan_status=$?
set -e

[[ "$scan_status" -ne 0 ]] || {
  printf 'gitleaks red-proof: scan exited 0 against a planted secret -- detection did not fire.\n%s\n' \
    "$scan_output" >&2
  exit 1
}

[[ "$scan_output" != *"$secret_value"* ]] || {
  printf 'gitleaks red-proof: the planted secret appeared unredacted in console output.\n' >&2
  exit 1
}

[[ -s "$report_file" ]] || {
  printf 'gitleaks red-proof: no report was written to %s.\n' "$report_file" >&2
  exit 1
}

if grep -q "$secret_value" "$report_file"; then
  printf 'gitleaks red-proof: the planted secret appeared unredacted in the JSON report.\n' >&2
  rm -f "$report_file"
  exit 1
fi

rm -f "$report_file"
printf 'gitleaks red-proof: detection fired on the planted secret and output stayed redacted.\n'
