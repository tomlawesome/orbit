#!/usr/bin/env bash
#
# The shared verifier (#661): every job that gives a validated digest a
# consumer-visible name runs this first, and refuses -- with a distinct
# message and exit code per ground -- when the digest's validation evidence
# does not check out. The evidence is the cosign key-based attestation minted
# by scripts/ci/attest-tested-image.sh at the moment the digest first
# existed; this script verifies it with the committed public key and then
# judges what it says.
#
# One verifier, many callers -- the GitLab channel-tag job
# (scripts/ci/publish-channel.sh), both GitHub publishing jobs
# (.github/workflows/publish-from-gitlab.yml), and stable promotion
# (scripts/ci/promote-stable.sh, #877) -- so the refusal logic cannot fork
# into drifting copies. Do not inline a second version of these checks
# anywhere; call this.
#
# The four grounds, their exit codes, and what each message names:
#
#   mismatch  (exit 10)  The evidence is verifiable but describes something
#                        other than what is being published: another digest,
#                        another commit, another ref, or a policy version
#                        that is no longer the current one (a digest
#                        validated under older rules must not ship under
#                        newer ones -- #573 ruling 24).
#   missing   (exit 11)  No attestation of the expected type verifies with
#                        the committed public key over this digest -- or the
#                        digest itself does not resolve. Unsigned JSON,
#                        attestations under another key, and a digest nobody
#                        attested all land here.
#   ambiguous (exit 12)  Verified attestations disagree about what was
#                        validated. Two records that are identical except
#                        recordedAt are one item of evidence (a retried
#                        attesting job), newest governing expiry; any
#                        disagreement on (imageDigest, commit, ref,
#                        pipelineId, policyVersion) is a conflict this
#                        script refuses to pick a winner from.
#   expired   (exit 13)  The newest evidence is older than seven days (the
#                        window #661 grants a validated digest before it
#                        must revalidate), or is stamped in the future
#                        beyond plausible clock skew (five minutes, matching
#                        gitlab-await-tested-image.sh).
#
# Anything else non-zero (exit 1/2) is misconfiguration -- missing inputs,
# missing public key -- named plainly, never silently treated as a pass:
# this gate fails closed.
#
# Inputs (environment):
#   ORBIT_IMAGE            Image repository without tag or digest, e.g.
#                          registry.tomlawson.io/ai/orbit.
#   ORBIT_DIGEST           The digest about to be given a name,
#                          "sha256:<64 hex>".
#   ORBIT_COMMIT           The commit the publisher is acting for (40 hex).
#   ORBIT_REF              Optional; when set, evidence for another ref is a
#                          mismatch.
#   ORBIT_POLICY_VERSION   Optional; the policy version this checkout
#                          carries. Computed by scripts/ci/policy-version.sh
#                          when unset -- callers normally leave it unset so
#                          the recomputation is from their own checkout.
#   COSIGN_PUBLIC_KEY      Optional; path to the committed public key,
#                          default cosign.pub in the repository root.
#   ORBIT_MAX_EVIDENCE_AGE_DAYS  Optional; default 7.
#   ORBIT_COSIGN           Optional; the cosign command to run, overridable
#                          only so tests can stub it. Real use resolves the
#                          pinned binary via scripts/ci/ensure-cosign.sh.
#
# Registry credentials are ambient: cosign reads the same Docker config the
# caller's `docker login` wrote. This script needs read access only.
#
# Outputs on success: a one-line acceptance naming commit, pipeline and
# policy version; recorded_at, pipeline_url and policy_version appended to
# $GITHUB_OUTPUT when set.
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${repo_root}"

# Must match scripts/ci/attest-tested-image.sh; a test asserts they agree.
readonly PREDICATE_TYPE="https://tomlawson.io/attestations/orbit-validation/v1"

fail() { printf 'verify-validation-evidence: %s\n' "$1" >&2; exit 2; }
refuse() { # $1 ground, $2 exit code, $3 message
  printf 'verify-validation-evidence: refused (%s): %s\n' "$1" "$3" >&2
  exit "$2"
}

: "${ORBIT_IMAGE:?ORBIT_IMAGE is required: the image repository the digest lives in}"
: "${ORBIT_DIGEST:?ORBIT_DIGEST is required: the digest about to be published}"
: "${ORBIT_COMMIT:?ORBIT_COMMIT is required: the commit being published}"

[[ "$ORBIT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "ORBIT_DIGEST is not an immutable manifest digest: ${ORBIT_DIGEST}"
[[ "$ORBIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
  fail "ORBIT_COMMIT is not an exact commit SHA: ${ORBIT_COMMIT}"
[[ "$ORBIT_IMAGE" =~ ^[A-Za-z0-9._-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)+$ ]] ||
  fail "ORBIT_IMAGE is not a plain image repository reference: ${ORBIT_IMAGE}"
[[ -z "${ORBIT_REF:-}" || "$ORBIT_REF" =~ ^[A-Za-z0-9._/-]+$ ]] ||
  fail "ORBIT_REF is not a plain ref name: ${ORBIT_REF}"

max_age_days="${ORBIT_MAX_EVIDENCE_AGE_DAYS:-7}"
[[ "$max_age_days" =~ ^[0-9]+$ ]] || fail "ORBIT_MAX_EVIDENCE_AGE_DAYS is not a whole number: ${max_age_days}"

public_key="${COSIGN_PUBLIC_KEY:-${repo_root}/cosign.pub}"
[[ -f "$public_key" ]] ||
  fail "the validation public key is not at ${public_key}; the owner commits cosign.pub at the repository root (docs/releasing.md), and without it nothing can be verified"

policy_version="${ORBIT_POLICY_VERSION:-$(bash scripts/ci/policy-version.sh)}"
[[ "$policy_version" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "policy version is not a sha256 value: ${policy_version}"

cosign_cmd="${ORBIT_COSIGN:-}"
if [[ -z "$cosign_cmd" ]]; then
  cosign_cmd="$(bash scripts/ci/ensure-cosign.sh)"
fi

subject="${ORBIT_IMAGE}@${ORBIT_DIGEST}"
verified="$(mktemp)"
cosign_err="$(mktemp)"
trap 'rm -f "$verified" "$cosign_err"' EXIT

# --insecure-ignore-tlog because the attestations are minted without a
# transparency log: key-based trust, no Rekor to consult (cosign v3 renamed
# --private-infrastructure to this and warns on the old name). Trust here rests
# on the committed public key, not on transparency. An unresolvable digest, a
# missing .att manifest and a signature under another key all fail here, and
# all of them mean the same thing to a publisher: there is no evidence for
# this exact digest.
if ! "$cosign_cmd" verify-attestation \
  --key "$public_key" \
  --type "$PREDICATE_TYPE" \
  --insecure-ignore-tlog=true \
  "$subject" > "$verified" 2> "$cosign_err"; then
  sed 's/^/verify-validation-evidence: cosign: /' "$cosign_err" >&2
  refuse missing 11 "no verifiable validation attestation of type ${PREDICATE_TYPE} for ${subject}; validation has not attested this digest under the committed key"
fi

# cosign has proven the signatures; node judges what the verified statements
# say. It exits with the refusal codes above, which set -e propagates.
ORBIT_PREDICATE_TYPE="$PREDICATE_TYPE" \
ORBIT_POLICY_VERSION_RESOLVED="$policy_version" \
ORBIT_MAX_AGE_DAYS="$max_age_days" \
node -e '
  const fs = require("node:fs");

  const [verifiedPath] = process.argv.slice(1);
  const expected = {
    digest: process.env.ORBIT_DIGEST,
    commit: process.env.ORBIT_COMMIT,
    ref: process.env.ORBIT_REF || null,
    policyVersion: process.env.ORBIT_POLICY_VERSION_RESOLVED,
    predicateType: process.env.ORBIT_PREDICATE_TYPE,
    maxAgeDays: Number(process.env.ORBIT_MAX_AGE_DAYS),
  };

  function refuse(ground, code, message) {
    process.stderr.write(`verify-validation-evidence: refused (${ground}): ${message}\n`);
    process.exit(code);
  }

  // Every line cosign printed is a DSSE envelope whose signature it already
  // verified; a line that does not decode to the expected in-toto shape is
  // not usable evidence, which is the "missing" ground, named precisely.
  const statements = [];
  const lines = fs.readFileSync(verifiedPath, "utf8").split("\n").filter((line) => line.trim());
  for (const line of lines) {
    let statement;
    try {
      const envelope = JSON.parse(line);
      statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    } catch {
      refuse("missing", 11, "a verified attestation payload is not decodable in-toto JSON; unusable as evidence");
    }
    if (statement.predicateType !== expected.predicateType) continue;
    statements.push(statement);
  }
  if (statements.length === 0) {
    refuse("missing", 11,
      `cosign verified ${lines.length} attestation(s) for the digest, but none carries predicate type ${expected.predicateType}`);
  }

  const items = [];
  for (const statement of statements) {
    const subjects = Array.isArray(statement.subject) ? statement.subject : [];
    const subjectDigests = subjects.map((s) => `sha256:${s?.digest?.sha256}`);
    const p = statement.predicate ?? {};
    for (const [field, pattern] of [
      ["commit", /^[0-9a-f]{40}$/u],
      ["ref", /^[A-Za-z0-9._/-]+$/u],
      ["imageDigest", /^sha256:[0-9a-f]{64}$/u],
      ["policyVersion", /^sha256:[0-9a-f]{64}$/u],
      ["recordedAt", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u],
    ]) {
      if (typeof p[field] !== "string" || !pattern.test(p[field])) {
        refuse("missing", 11, `a verified attestation predicate has no well-formed ${field}; unusable as evidence`);
      }
    }
    if (!Number.isInteger(p.pipelineId)) {
      refuse("missing", 11, "a verified attestation predicate has no well-formed pipelineId; unusable as evidence");
    }
    items.push({ subjectDigests, predicate: p });
  }

  // Identical claims differing only in recordedAt are one item of evidence
  // (a retried attesting job); the newest stamp governs expiry. Any
  // disagreement on the claim itself is a conflict nobody here may resolve.
  const claims = new Map();
  for (const { predicate } of items) {
    const key = JSON.stringify([
      predicate.imageDigest, predicate.commit, predicate.ref, predicate.pipelineId, predicate.policyVersion,
    ]);
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(predicate);
  }
  if (claims.size > 1) {
    refuse("ambiguous", 12,
      `${items.length} verified attestations make ${claims.size} conflicting claims about what was validated (imageDigest, commit, ref, pipelineId or policyVersion differ); refusing to choose between them`);
  }

  const records = [...claims.values()][0];
  const claim = records[0];

  for (const { subjectDigests } of items) {
    if (!subjectDigests.includes(expected.digest)) {
      refuse("mismatch", 10,
        `a verified attestation is attached to subject ${subjectDigests.join(", ") || "<none>"}, not the digest being published (${expected.digest})`);
    }
  }
  if (claim.imageDigest !== expected.digest) {
    refuse("mismatch", 10,
      `evidence names digest ${claim.imageDigest}, not the digest being published (${expected.digest})`);
  }
  if (claim.commit !== expected.commit) {
    refuse("mismatch", 10,
      `evidence is for commit ${claim.commit}, not the commit being published (${expected.commit})`);
  }
  if (expected.ref !== null && claim.ref !== expected.ref) {
    refuse("mismatch", 10,
      `evidence is for ref ${claim.ref}, not the ref being published (${expected.ref})`);
  }
  if (claim.policyVersion !== expected.policyVersion) {
    refuse("mismatch", 10,
      `the policy changed since validation: evidence was judged under policy ${claim.policyVersion}, this checkout carries ${expected.policyVersion}; re-validate the digest`);
  }

  const newest = records.map((r) => r.recordedAt).sort().at(-1);
  const newestMs = Date.parse(newest);
  const ageMs = Date.now() - newestMs;
  if (ageMs > expected.maxAgeDays * 24 * 3600 * 1000) {
    refuse("expired", 13,
      `evidence recorded at ${newest} is older than ${expected.maxAgeDays} days; re-validate the digest before publishing`);
  }
  if (ageMs < -300 * 1000) {
    refuse("expired", 13,
      `evidence recorded at ${newest} is in the future; refusing evidence from a skewed clock`);
  }

  const summary = records.find((r) => r.recordedAt === newest);
  process.stdout.write(
    `verify-validation-evidence: accepted ${expected.digest}: validated at commit ${summary.commit}`
    + ` on ${summary.ref} by pipeline ${summary.pipelineId} under policy ${summary.policyVersion},`
    + ` recorded ${newest}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `recorded_at=${newest}\npipeline_url=${summary.pipelineUrl ?? ""}\npolicy_version=${summary.policyVersion}\n`);
  }
' -- "$verified"
