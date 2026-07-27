# ADR-0003: Separate previews from release candidates

**Status:** Accepted
**Date:** 2026-07-27

## Context

Orbit published incomplete integration snapshots with an `rc-*` prefix. Those
images were useful for deployment feedback, but the name implied a
feature-complete release that was ready for final acceptance. Tags alone are
mutable and cannot safely establish an artifact's release stage.

## Decision

- The protected v1 integration branch publishes immutable engineering previews
  tagged `preview-YYYY.MM.DD.<run>`.
- A release candidate is published only from a protected semantic release
  branch after the intended release is feature-complete. Its tag is
  `vMAJOR.MINOR.PATCH-rc.<run>`.
- Semantic release-candidate publication remains disabled until the required v1
  gates, including supply-chain evidence, are implemented and passing.
- Published images carry an immutable
  `io.github.tomlawesome.orbit.release-stage` label set to either `preview` or
  `release-candidate`.
- Stable promotion accepts only a digest labelled `release-candidate`, requires
  a semantic RC image version matching the requested stable version, and
  retains the existing source-ancestry, tree-identity, protected-environment,
  non-overwrite, and no-rebuild controls.
- Historic `rc-YYYY.MM.DD.<run>` images are retained as preview evidence. They
  are not retroactively treated as feature-complete release candidates.
- The legacy integration-branch name remains temporarily because its
  `release/**` protection is already established. Renaming it is separate from
  the artifact-channel decision and must not weaken branch protection.

## Consequences

- Real-world testing can continue throughout implementation without overstating
  release readiness.
- “Release candidate” becomes a meaningful, auditable assertion about v1
  completeness rather than a synonym for any gated build.
- Stable promotion fails closed for previews, including historic images that
  lack the stage label.
- Operators still deploy and record immutable digests; human-readable tags are
  only discovery aids.
- The final v1 release branch and candidate are created later, once the v1
  milestone satisfies its release gate.

## Alternatives considered

- **Stop publishing until v1 is complete:** rejected because deployable
  snapshots provide valuable real-world and operational feedback.
- **Keep `rc-*` and explain that it is provisional:** rejected because it
  preserves misleading terminology and weakens the release gate.
- **Trust the tag prefix during promotion:** rejected because registry tags are
  mutable and do not form immutable policy evidence.
- **Rename the integration branch immediately:** deferred because the current
  branch already benefits from protected `release/**` policy and a rename is
  not required to correct artifact semantics.
