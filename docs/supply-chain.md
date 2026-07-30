# Orbit supply-chain evidence

Orbit treats supply-chain evidence as a publication gate, not as an
informational report produced after an image is released. The binding policy is
`.github/supply-chain-policy.json`; `scripts/supply-chain-policy.mjs` validates
that policy and converts scanner output into bounded review evidence.

## Trusted workflow

Every pull request and trusted preview run performs these steps:

1. A separate read-only dependency-review job compares pull-request dependency
   changes with the base revision. Newly introduced high or critical
   vulnerabilities in runtime, development or unknown scopes block the pull
   request. Newly introduced dependencies must use an approved SPDX licence.
2. A read-only job scans the checked-out repository for dependency
   vulnerabilities and secret patterns. Checkout credentials are not
   persisted. The raw secret-scan report is never uploaded and is deleted
   after a sanitized finding record is generated.
3. Fast and PostgreSQL integration checks must pass along with the source
   policy before container validation can advance.
4. CI builds one AMD64 production image, records its configuration identity,
   then scans that local identity for vulnerabilities and generates an SPDX
   2.3 SBOM.
5. The repository policy verifies that the vulnerability report and SBOM name
   the same image that enters Compose, recovery, privacy, browser and
   accessibility tests.
6. Pull requests stop with read-only evidence. A trusted `develop` or
   versioned-release push may log in to GHCR only after every preceding gate
   passes.
7. CI pushes that exact tested image without rebuilding, resolves the registry
   digest, pulls it back and verifies its configuration identity.
8. GitHub mints short-lived OIDC provenance and SBOM attestations for the
   resolved digest. CI immediately verifies both attestations before recording
   a deployable preview.

The source, exact-image and attestation-verification artifacts are retained for
14 days. They contain public package and image metadata, bounded finding
identifiers and policy decisions. They must not contain secret matches,
private runtime configuration or environment values.

## Policy and exceptions

High and critical dependency or image vulnerabilities block publication.
Every repository secret finding blocks regardless of its scanner severity.
Lower-severity vulnerabilities remain visible in the retained evidence.

Dependency changes are governed separately from the full source and image
scans. `.github/dependency-review-config.yml` allows only the listed
SPDX-compatible permissive or file-level reciprocal licences and blocks newly
introduced high or critical vulnerabilities in every dependency scope.
Dependencies that declare a licence outside the allow-list block
automatically. Missing or ambiguous licence metadata is surfaced by the action
and remains a manual review and release blocker until it is resolved. There
are no advisory or package licence exemptions in the policy. Any future
exemption must be narrow, justified, owned, time-bounded and linked to a
tracking issue.

A vulnerability exception is valid only when it identifies the finding,
package and scope, names an owner, gives a rationale, links a tracking issue
and has not expired. Secret findings have no exception path. The policy
validator fails closed on stale or malformed exceptions. Exceptions do not
change scanner output; they make a narrow, reviewable publication decision for
a known vulnerability.

Validate the current policy locally with:

```text
node scripts/supply-chain-policy.mjs validate
```

The policy inventories every upstream build and runtime container using its
human-readable version tag, the tag's observed multi-platform index digest and
the exact Linux/AMD64 manifest used by Orbit. Repository configuration uses the
tag plus that AMD64 digest, so an upstream tag move cannot change a build,
integration test or deployment. Each entry records source and registry
provenance, licence evidence, file locations, an update owner, resolution date
and review deadline.

The application image is different: it does not have a repository-owned stable
digest until a release is accepted. Compose therefore requires `ORBIT_IMAGE`
explicitly. Pull deployments accept a full `registry/repository@sha256:...`
identity; local build scripts supply a revision-specific local tag for the
image they build from the checked-out source. There is no implicit `latest`
deployment default. A `latest` tag may still be published during an explicitly
approved stable promotion, but it is a convenience pointer rather than
deployment or acceptance evidence.

## Updating pinned images

Use a focused pull request for image updates:

1. Read the upstream release notes and image-source change history. Confirm
   maintenance status, provenance and licence evidence before accepting a new
   tag or a moved tag.
2. Query the authoritative registry for the tag's current index and
   Linux/AMD64 manifest. Record both digests and the resolution date in
   `.github/supply-chain-policy.json`.
3. Replace every location listed by the policy with the same reviewed
   tag-plus-manifest identity. Do not update an untracked reference or add a
   temporary mutable fallback.
4. Run `node scripts/supply-chain-policy.mjs validate`, the focused policy
   tests, static/unit checks and Compose configuration validation.
5. Let protected CI pull the pinned identities and repeat PostgreSQL,
   malware-detection, parser-isolation, backup/restore, privacy, browser,
   accessibility, exact-image vulnerability and SBOM gates.
6. Merge only when the protected pull-request checks pass. The trusted branch
   run must then publish and attest the exact application image it tested.

If an upstream registry no longer serves a recorded manifest, the update is a
release blocker; do not silently fall back to the tag.

## Tool provenance and ownership

Trivy runs from a reviewed, AMD64 manifest digest recorded in the policy. Orbit
does not execute the Trivy setup or wrapper actions. This is deliberate because
the Trivy ecosystem had a
[published March 2026 supply-chain incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23).
The selected release is post-incident, but the executable identity remains
digest-pinned.

GitHub's `actions/attest` action is pinned to the reviewed commit recorded in
the policy. It attaches provenance and the SPDX SBOM to the already pushed
digest; it does not build or transform the image. Orbit maintainers own both
tool updates and the policy review date. Licences, upstream release pages,
versions and immutable identities are recorded beside that ownership.

GitHub's `actions/dependency-review-action` is also pinned to the reviewed
commit recorded in the policy. It runs only on the `pull_request` event with
read-only contents access, does not persist checkout credentials and does not
receive permission to comment, publish packages or mint OIDC tokens.

The vulnerability database is intentionally refreshed by the pinned scanner
at run time because vulnerability knowledge changes. Scanner version metadata
and database timestamps are retained with each run so a later review can
identify the evidence set that made the decision.
