# Orbit supply-chain evidence

Orbit treats supply-chain evidence as a publication gate, not as an
informational report produced after an image is released. The binding policy is
`.github/supply-chain-policy.json`; `scripts/supply-chain-policy.mjs` validates
that policy and converts scanner output into bounded review evidence.

## Trusted workflow

Every pull request and trusted preview run performs these steps:

1. A read-only job scans the checked-out repository for dependency
   vulnerabilities and secret patterns. Checkout credentials are not
   persisted. The raw secret-scan report is never uploaded and is deleted
   after a sanitized finding record is generated.
2. Fast and PostgreSQL integration checks must pass along with the source
   policy before container validation can advance.
3. CI builds one AMD64 production image, records its configuration identity,
   then scans that local identity for vulnerabilities and generates an SPDX
   2.3 SBOM.
4. The repository policy verifies that the vulnerability report and SBOM name
   the same image that enters Compose, recovery, privacy, browser and
   accessibility tests.
5. Pull requests stop with read-only evidence. A trusted `develop` or
   versioned-release push may log in to GHCR only after every preceding gate
   passes.
6. CI pushes that exact tested image without rebuilding, resolves the registry
   digest, pulls it back and verifies its configuration identity.
7. GitHub mints short-lived OIDC provenance and SBOM attestations for the
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

The policy also inventories mutable build and runtime image references. Those
references have explicit owners, rationales, tracking issue
[#80](https://github.com/tomlawesome/orbit/issues/80) and an expiry. They are
not treated as immutable merely because a version appears in the tag.

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

The vulnerability database is intentionally refreshed by the pinned scanner
at run time because vulnerability knowledge changes. Scanner version metadata
and database timestamps are retained with each run so a later review can
identify the evidence set that made the decision.
