# Orbit previews, release candidates and stable promotion

Orbit treats a container digest—not a mutable tag—as the identity of an
artifact. Preview and release-candidate tags help people find images, but every
deployment, acceptance record, and promotion uses the immutable digest.

## Publication channels

### Engineering previews

During v1 implementation, pushes to the protected integration branch
`release/architecture-consolidation-rc` publish an AMD64 image tagged
`preview-YYYY.MM.DD.<workflow-run-number>`. The branch name is retained
temporarily because its existing `release/**` protection is already in force;
it does not make these images release candidates.

Previews:

- pass the repository's automated publication gates;
- carry the immutable image label
  `io.github.tomlawesome.orbit.release-stage=preview`;
- support deployment by digest for real-world engineering feedback;
- may contain incomplete, experimental, or not-yet-proven v1 behaviour; and
- cannot be promoted by the stable-promotion workflow.

When preview feedback specifically requires ARM64, manually run **Validate
Orbit and publish previews** with **Include ARM64** enabled. Routine previews
remain AMD64 to avoid unnecessary build cost.

Historic `rc-YYYY.MM.DD.<run>` images published before
[ADR-0003](adr/0003-preview-and-release-candidate-channels.md) are engineering
previews despite their old tag prefix. Their tags and digests remain historical
records; do not relabel, replace, or treat them as feature-complete candidates.

### Feature-complete release candidates

Release-candidate publication is deliberately disabled while v1 is incomplete.
Before enabling it, all release blockers must be closed and every required
automated gate—including SBOM, dependency and image scanning, and
provenance—must be implemented and passing. The enabling workflow change is a
separately reviewed release-policy change; naming a branch `release/v*` does
not currently publish a release candidate.

At that point, cut a protected `release/vMAJOR.MINOR` branch. Patch releases may
use `release/vMAJOR.MINOR.PATCH`. The remaining work on the branch is limited to
release validation or narrowly reviewed release fixes.

The enabled release-candidate workflow publishes a semantic tag
`vMAJOR.MINOR.PATCH-rc.<workflow-run-number>` and the immutable image label
`io.github.tomlawesome.orbit.release-stage=release-candidate`. Deploy the digest
from the workflow summary to a representative self-hosted test bed and complete
the v1 release-acceptance checklist. Any content change requires a newly built
and tested release-candidate digest.

### Stable promotion

After acceptance:

1. Merge the tested release branch into protected `main` without squashing,
   rebasing away the image revision, or changing its source tree.
2. From `main`, run **Promote tested Orbit release candidate** with the tested
   digest and its matching `vMAJOR.MINOR.PATCH` stable version.
3. Approve the protected `production` environment.

The workflow rejects previews and malformed or mismatched versions. It verifies
the `release-candidate` stage label, semantic RC label, source ancestry, exact
tree identity, and absence of the requested stable tag. It then points the
version tag and, when requested, `latest` at the exact tested digest without
rebuilding.

## Required repository settings

- Keep `main` protected with required checks, reviewed pull requests, resolved
  conversations, and force-push/deletion prevention.
- Protect `release/**` against force-push and deletion and require the same
  checks for pull requests targeting those branches.
- Create a GitHub Actions environment named `production`.
- Give `production` required reviewers, prevent self-review where practical,
  and allow deployments only from protected `main`.
- Keep the repository-linked GHCR package writable by this repository's
  `GITHUB_TOKEN`. No personal token or long-lived registry secret is required.

Tags can move; digests cannot. Always deploy and record the digest shown in the
publication workflow summary.
