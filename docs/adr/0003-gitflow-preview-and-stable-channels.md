# ADR-0003: Protected preview lane and stable promotion

**Status:** Accepted
**Date:** 2026-08-08

## Context

Orbit needs strong release evidence without rebuilding and exercising a full
container pipeline for every feature pull request. Mutable image tags are useful
discovery pointers but cannot establish source identity or release readiness.
Manually choosing the semantic version also risks mismatches between source,
the tested image and the eventual release record.

## Decision

- `develop` is the protected integration branch. Ordinary issue branches start
  from and target `develop`; they run static and unit checks without building
  or publishing an image.
- `preview` is the protected release lane. A reviewed merge of `develop` into
  `preview` runs the complete PostgreSQL, exact-image, browser, recovery and
  supply-chain path once and publishes the tested digest behind the mutable
  `preview` tag.
- A stable pull request merges `preview` into protected `main`. It verifies that
  the current preview digest, embedded version and source revision exactly match
  the pull-request head, including digest-bound provenance and SBOM evidence. It
  does not rebuild the image.
- Stable promotion accepts the tested digest under the protected `production`
  environment. It requires the preview revision to be present in `main`, the
  `main` tree to match it exactly, and the source revision to remain on its
  protected source branch.
- Stable promotion points only `latest` at the accepted digest, then creates the
  matching immutable Git tag and GitHub Release. The release records the digest.
  It does not publish semantic-version container tags.
- Preview publication points only `preview` at the tested digest. `dev` is
  reserved but is not initially published. No commit, branch, run, release or
  semantic-version container tags are published.
- Orbit calculates one semantic version per release train from the highest
  stable Git tag. An ordinary preview train increments minor once; a bounded
  `hotfix/*` preview increments patch once. `package.json` bootstraps repositories
  that predate their first stable Git tag. Major releases require a separate
  protected human decision.
- Every rebuild within the same unpromoted train has the same version. The
  version and revision are embedded into the image and cannot be replaced by
  runtime environment variables.
- A rare `hotfix/*` branch may publish the `preview` pointer and merge directly
  to `main`; it must subsequently be reconciled into `develop` and `preview`.
- Historic `preview-*`, `rc-*` and semantic-version image tags remain untouched
  as audit evidence. They are never eligible for new promotion.

## Consequences

- Feature development normally waits only for fast and risk-selected checks.
- The expensive authoritative path runs once after a protected preview merge,
  before stable source is proposed.
- Operators test and record immutable digests; `preview` and `latest` remain
  convenience pointers only.
- A candidate version is visible in `--version`, startup logs and OCI metadata
  without consuming multiple semantic versions during preview iteration.
- Stable releases preserve the exact bytes exercised during acceptance.

## Alternatives considered

- **Build a container for every feature pull request:** rejected because it
  duplicates the authoritative preview build and dominates development time.
- **Publish unique tags for every preview:** rejected because digests already
  provide immutable identity and the extra tags create registry clutter.
- **Type the version during promotion:** rejected because the accepted artifact
  already contains the deterministic version and should be authoritative.
- **Rebuild on `main`:** rejected because the resulting bytes would not be the
  image accepted on the preview lane.
