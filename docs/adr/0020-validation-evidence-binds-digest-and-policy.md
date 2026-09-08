# ADR-0020: Validation evidence is a cosign attestation binding digest and policy version; publication only consumes it

**Status:** Accepted (ratified by the owner, 2026-09-08). §4–§5 and the
owner setup were corrected the same day: the ratified text fenced the key
with protected environments and environment-scoped variables, which are
Premium features this GitLab CE instance (19.3.1, verified 2026-09-08) does
not have — the fence as ratified would have parsed and enforced nothing.
The correction (the dedicated signing runner below) awaits owner
ratification.
**Date:** 2026-09-08
**Relates to:** issue #661 (whose thread carries the full specification this
records the durable part of), the #573 ruling it implements, #877 (stable
promotion adopting the same verifier), #801 (the GitLab move that made the
question concrete)

## Context

The #573 ruling: validation and publication are separate jobs. Validation
binds its evidence to the image's immutable content identity (the digest) and
to the policy version that judged it; publication consumes that evidence,
re-runs the cheap checks, and refuses on mismatch, absence, ambiguity, or
evidence older than seven days. After the GitLab move (#801), the proven
four-point fail-closed exemplar (`promote-container.yml`) was gone and
`publish_gitlab` both judged the image and shipped it, with only unsigned
JSON (`gitlab-tested-image.json`) as evidence — integrity resting on GitLab
API auth, exactly the "relies on nobody editing the job" property #573
rejected.

## Decision

1. **The evidence is a cosign key-based attestation**, predicate type
   `https://tomlawson.io/attestations/orbit-validation/v1`, minted by
   `scripts/ci/attest-tested-image.sh` the moment the pushed digest exists,
   pushed to `registry.tomlawson.io` beside the image. Predicate:
   `{commit, ref, pipelineId, pipelineUrl, imageDigest, policyVersion,
   recordedAt}`. Signed with a long-lived owner-held key pair; the public key
   is committed as `cosign.pub` at the repository root. `gitlab-tested-image.json`
   remains as transport and discovery, never trust.
   Rejected: keyless Sigstore (the public trust root will not accept a
   self-hosted CE OIDC issuer), private Fulcio/Rekor (disproportionate),
   unsigned JSON as trust (see above), GitLab Runner artifact metadata
   (ephemeral per-build key, verifier learns nothing).

2. **The policy version** is `scripts/ci/policy-version.sh`: SHA-256 over the
   sorted per-file SHA-256s of the explicit policy file list. Minted into the
   predicate at validation; every verifier recomputes it from its own
   checkout and refuses on drift, so a digest validated under older rules
   cannot ship under newer ones.

3. **One shared verifier**, `scripts/ci/verify-validation-evidence.sh`, runs
   at every hop that gives a validated digest a consumer-visible name, and
   refuses with a distinct message and exit code per ground: mismatch (10),
   missing (11), ambiguous (12), expired/future (13). Identical claims
   differing only in `recordedAt` are one item of evidence (a retried
   attesting job), newest governing the seven-day expiry; any disagreement on
   `(imageDigest, commit, ref, pipelineId, policyVersion)` is ambiguity
   nobody downstream may resolve. No caller re-implements any of this — that
   drift is what #877 exists to prevent.

4. **The split on GitLab:** `record_image` (was `publish_gitlab`) pushes
   only the immutable anchor `sha-<commit>` and records it; `sign_evidence`
   attests it; the new `publish_channel` verifies, re-runs the cheap identity and policy checks
   against the pulled digest (#573 ruling 24, belt and braces — the scan and
   acceptance suite deliberately excluded; their freshness is what the expiry
   bounds), then creates the channel tag registry-side
   (`docker buildx imagetools create` — no bytes move). Retrying
   `publish_channel` alone re-publishes without re-validating.
   "Digest-only, no tag" from the ruling is realised as "no *channel* tag":
   GitLab's registry garbage collection deletes untagged manifests, so a
   literally untagged validated image could be destroyed inside its own
   evidence window by routine disk maintenance (#832 makes that likely). The
   anchor tag is only ever consumed through digest comparison.

5. **The key is unreachable from publication — fenced by a dedicated
   runner, not by GitLab configuration.** The key pair and its password
   exist only as files on the CI host, mounted read-only into jobs of a
   second project runner tagged `orbit-signing`: protected (it refuses jobs
   from unprotected refs — a CE-enforced boundary), locked to this project,
   and used by exactly one job, `sign_evidence`, whose surface is the pinned
   cosign binary and this repository's scripts — not the image build or the
   test suites. Publishers hold only `cosign.pub`.
   Why not CI/CD variables, as first ratified: this instance is GitLab CE,
   which has no protected environments and no environment-scoped variables
   (both Premium; `projects/49/protected_environments` returns 404). An
   `environment:` block is valid YAML on CE and scopes nothing, so the fence
   would have been silently absent while appearing present; and a
   project-level variable is readable by every job in every protected-branch
   pipeline, handing the key to the whole acceptance suite's dependency
   tree — a wider exposure than the theatre criterion 6 forbids. Keeping the
   key out of GitLab's variable store entirely is the strongest fence CE
   offers without new infrastructure.
   What review must still stop: a protected-branch `.gitlab-ci.yml` edit
   moving the `orbit-signing` tag to another job. That is the same
   review-plus-settings boundary the first text accepted for environment
   edits; the shape tests
   (`scripts/validation-evidence-split.test.mjs`) make such an edit loud.
   Rejected for this correction: a separate signing project triggered
   cross-project (a real CE project boundary, but it needs its own repository
   of verification logic, cross-project tokens and a registry-write
   credential held outside this project — disproportionate for this
   instance, the same judgement made on private Fulcio/Rekor above); plain
   project-level variables (the silent exposure just described); public
   Sigstore keyless (already rejected above, and a self-hosted CE issuer
   cannot join the public trust root). Revisit if the instance ever gains
   environment-scoped variables or another project must share this trust
   model.

6. **cosign is pinned** (version + SHA-256) in one place,
   `scripts/ci/ensure-cosign.sh`, used by attestor and verifiers alike.

## Consequences

- A validated digest can be re-published for seven days without
  re-validation; after that it must revalidate. That cost is intended.
- The GitHub lane (`publish-from-gitlab.yml` split into copy/attest with
  disjoint permissions, both running the shared verifier) and stable
  promotion (#877) adopt the same verifier in their own changes; the full
  target shape is specified on #661.
- Owner setup is required before the split can run: key pair, the key files
  on the runner host, and the protected `orbit-signing` runner
  (docs/releasing.md). Until then `sign_evidence` finds no runner or fails
  closed naming the missing file, and nothing publishes. The committed
  `cosign.pub` is unaffected by the CE correction.
- Key rotation: new pair, replace the files on the runner host, commit new
  `cosign.pub`; old attestations become unverifiable, so anything
  unpublished revalidates.
