# Orbit release candidates and stable promotion

Orbit treats a container digest—not a mutable tag—as the identity of a tested
artifact. Stable images are promoted from that digest without rebuilding.

## Delivery flow

1. Create `release/<name>` from protected `main`.
2. Merge focused feature branches into the release branch through reviewed
   pull requests. Pull requests run static, unit, Compose, ClamAV, Playwright,
   accessibility, and signed-out privacy checks but cannot publish packages.
3. A push to `release/**` repeats those gates and then publishes one AMD64
   candidate tagged `rc-YYYY.MM.DD.<workflow-run-number>`.
4. When ARM64 is required, manually run **Validate Orbit and publish
   candidates** from the release branch with **Include ARM64** enabled. This
   creates a new multi-architecture candidate after the same gates.
5. Deploy the workflow summary's exact `sha256:...` digest to the test
   environment and complete manual acceptance.
6. Merge the tested release branch into protected `main` without squashing or
   rebasing away the candidate source commit.
7. From `main`, run **Promote tested Orbit candidate**, supplying the tested
   digest and a new `vMAJOR.MINOR.PATCH` version.
8. After the protected `production` environment is approved, Actions verifies
   that the image revision is contained in `main`, refuses to replace an
   existing version tag, and points the version and optional `latest` tags at
   the exact tested digest. It does not run a container build.

## Required repository settings

- Keep `main` protected with the existing required checks, reviewed pull
  requests, resolved conversations, and force-push/deletion prevention.
- Protect `release/**` against force-push and deletion. Require the same checks
  for pull requests targeting a release branch.
- Create a GitHub Actions environment named `production`.
- Give `production` required reviewers, prevent self-review where practical,
  and allow deployments only from protected `main`.
- Keep the repository-linked GHCR package writable by this repository's
  `GITHUB_TOKEN`. No personal token or long-lived registry secret is required.

Release-candidate tags are unique and convenient for people, but GHCR tags can
be moved. Always deploy, record, approve, and promote the digest shown in the
candidate workflow summary.
