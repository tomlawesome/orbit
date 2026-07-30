# ADR-0003: Gitflow preview and stable channels

**Status:** Accepted
**Date:** 2026-07-30

## Context

Orbit needs continuous deployable evidence without using a separate artifact
stage between preview and stable. Tags are mutable and cannot safely establish
either source identity or release readiness. The former v1 integration branch
also prevented the repository from using its intended `develop`, versioned
release, stable, and hotfix branch flow.

## Decision

- `main` represents stable source, and `develop` is the protected integration
  branch.
- Issue branches start from and normally target `develop`.
- A protected `release/vMAJOR.MINOR.PATCH` branch starts from `develop`.
  Release work is limited to validation and narrowly reviewed fixes. It is
  merged through protected pull requests into both `main` and `develop`.
- A `hotfix/*` branch starts from `main` and is merged through protected pull
  requests into both `main` and `develop`.
- Pushes to `develop` and versioned `release/*` branches publish uniquely tagged
  previews. Published images carry
  `io.github.tomlawesome.orbit.release-stage=preview` and a source-branch label.
- Stable promotion accepts only the tested digest published from the release
  branch matching the requested semantic version. The source revision must be
  present in both `main` and `develop`, and the `main` tree must exactly match
  the preview revision.
- Promotion requires the protected production environment, refuses version-tag
  replacement, and retags the exact accepted digest without rebuilding.
- The legacy `release/architecture-consolidation-rc` branch no longer publishes
  previews and receives no feature work.
- Historic preview tags, including the former `rc-YYYY.MM.DD.<run>` form, remain
  untouched as audit evidence. They are never eligible for stable promotion.

## Consequences

- Real-world testing continues from immutable preview digests throughout
  development and release validation.
- There is no intermediate artifact stage: readiness is established by exact
  digest acceptance plus protected branch evidence.
- Stable promotion fails closed for development previews, legacy previews, and
  release previews whose exact source has not reached both protected branches.
- Operators still deploy and record immutable digests; human-readable tags are
  only discovery aids.
- The stable image has exactly the bytes exercised during release acceptance.

## Alternatives considered

- **Stop publishing until v1 is complete:** rejected because deployable
  snapshots provide valuable real-world and operational feedback.
- **Add a separate pre-stable artifact stage:** rejected because branch
  identity, immutable digest acceptance, and protected promotion already
  provide the required evidence with less policy surface.
- **Trust the tag prefix during promotion:** rejected because registry tags are
  mutable and do not form immutable policy evidence.
- **Continue feature work on the legacy integration branch:** rejected because
  it obscures the permanent Gitflow branch contract and delays consolidation.
