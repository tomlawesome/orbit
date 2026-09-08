#!/usr/bin/env bash
#
# Prints the policy version: one value that changes whenever any of the rules
# that judge an image changes, so validation evidence can bind *which rules
# judged it* alongside *what was judged* (#661, #573 ruling 24). A digest
# validated under older rules must not take a consumer-visible tag under newer
# ones; every publisher recomputes this from its own checkout and refuses on
# mismatch (scripts/ci/verify-validation-evidence.sh).
#
# The value is a SHA-256 over the sorted per-file SHA-256s of an explicit
# list. Explicit, not a glob: a glob would silently change meaning when an
# unrelated script lands in scripts/ci/, and silently ignore a deleted policy
# file. A listed file that is missing fails loudly instead, because a
# checkout without the policy cannot say what version of it it holds.
#
# Deterministic by construction: same tree, same value, wherever it runs --
# GitLab jobs and GitHub jobs must agree or the verifier refuses everything.
#
# Usage:
#   scripts/ci/policy-version.sh
#
# Output: "sha256:<64 hex>" on stdout, nothing else.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

fail() { printf 'policy-version: %s\n' "$1" >&2; exit 1; }

# Every file whose content decides whether an image passes: the pinned
# scanner and its exception policy, the policy evaluator, the identity
# checks, and the licence policy. Adding a new policy input means adding it
# here, in its own change, so the version moves with it.
policy_files=(
  .github/supply-chain-policy.json
  scripts/ci/licence-policy.mjs
  scripts/ci/scan-image.sh
  scripts/ci/verify-image-identity.sh
  scripts/supply-chain-policy.mjs
)

for file in "${policy_files[@]}"; do
  [[ -f "$file" ]] || fail "policy file missing from this checkout: ${file}"
done

# Hash of the per-file hashes, sorted bytewise so neither the list's order
# here nor the platform's locale can move the value.
version="$(sha256sum "${policy_files[@]}" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
[[ "$version" =~ ^[0-9a-f]{64}$ ]] || fail 'sha256sum produced no digest'
printf 'sha256:%s\n' "$version"
