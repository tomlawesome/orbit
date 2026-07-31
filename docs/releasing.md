# Orbit Gitflow previews and stable promotion

Orbit treats a container digest—not a mutable tag—as the identity of an
artifact. Preview tags help people find images, but every deployment,
acceptance record, and promotion uses the immutable digest.

## Protected branch flow

- `main` contains stable source only.
- `develop` is the integration branch. Issue branches start from and normally
  target `develop`.
- `release/vMAJOR.MINOR.PATCH` starts from `develop`. Only release validation
  and narrowly reviewed fixes belong on it. Merge the accepted release branch
  into both `main` and `develop` through protected pull requests.
- `hotfix/*` starts from `main`. Merge every accepted hotfix into both `main`
  and `develop` through protected pull requests.
- The legacy `release/architecture-consolidation-rc` branch receives no new
  feature work and is excluded from preview publication.

Do not squash or rebase away a release preview's source revision when merging
the release branch. Stable promotion verifies that exact revision and tree.

## Preview publication

Pushes to protected `develop` and version-specific `release/*` branches publish
an AMD64 preview tagged
`preview-<branch>-<workflow-run-id>-<workflow-attempt>`. The run identity makes
every published tag unique even when a workflow is retried.

Previews:

- pass the repository's automated publication gates;
- are built once with their final metadata, loaded into Compose, and pushed
  only after that exact image passes system validation;
- carry retained source dependency/secret evidence plus an exact-image
  vulnerability report and SPDX SBOM under the repository's explicit
  [supply-chain policy](supply-chain.md);
- receive verified GitHub OIDC provenance and SBOM attestations bound to the
  resolved registry digest after publication, without rebuilding;
- carry the immutable image label
  `io.github.tomlawesome.orbit.release-stage=preview` plus the exact source
  branch and revision;
- support deployment by digest for real-world engineering feedback;
- may contain incomplete, experimental, or not-yet-proven behaviour; and
- are eligible for stable promotion only when published from the exact
  versioned release branch and accepted under the controls below.

Pull requests run the same production-image and Compose checks with a read-only
token and cannot publish. The protected-branch push repeats validation because
that merged revision is the publication identity, but it does not rebuild
between system testing and publication. The workflow records both the tested
image configuration ID and the resulting registry digest. A preview is not
recorded as deployable if either digest-bound attestation cannot be verified.

Preview publication is currently AMD64 only. ARM64 remains disabled until CI
can build and exercise that platform and assemble a multi-platform manifest
from exact tested identities; it is not sufficient to append an untested
architecture after the AMD64 gates pass.

Historic `rc-YYYY.MM.DD.<run>` images published before
[ADR-0003](adr/0003-gitflow-preview-and-stable-channels.md) remain immutable
historical preview evidence. Do not relabel, replace, or promote them.

## Release acceptance and stable promotion

After all release blockers and automated gates—including SBOM, dependency and
image scanning, and provenance—pass:

1. Cut `release/vMAJOR.MINOR.PATCH` from protected `develop`.
2. Deploy the release branch's preview by digest to a representative
   self-hosted test bed and complete the release-acceptance checklist. Any
   content change requires a newly published and accepted preview digest.
3. Merge the tested release revision into protected `main` without squashing,
   rebasing it away, or changing its source tree.
4. Merge the same release branch back into protected `develop`.
5. From `main`, run **Promote tested Orbit preview** with the accepted digest
   and matching `vMAJOR.MINOR.PATCH` stable version.
6. Approve the protected `production` environment.

The workflow rejects development, legacy, and mismatched release previews. It
verifies the `preview` stage, matching version-specific source branch, source
revision in both protected branches, exact `main` tree identity, and absence of
the requested stable tag. It then points the version tag and, when requested,
`latest` at the exact tested digest without rebuilding.

## Required repository settings

- Keep `main` protected with required checks, reviewed pull requests, resolved
  conversations, and force-push/deletion prevention.
- Give `develop` the same protection and make it the default base for ordinary
  issue pull requests.
- Protect `release/**` against force-push and deletion and require the same
  checks for pull requests targeting those branches.
- Protect `hotfix/**` against force-push and deletion and require pull requests
  into both stable and integration branches.
- Create a GitHub Actions environment named `production`.
- Give `production` required reviewers, prevent self-review where practical,
  and allow deployments only from protected `main`.
- Keep the repository-linked GHCR package writable by this repository's
  `GITHUB_TOKEN`. No personal token or long-lived registry secret is required.

Tags can move; digests cannot. Compose does not default to `latest`; always set
`ORBIT_IMAGE` to and record the digest shown in the publication workflow
summary. A promoted `latest` tag remains only a convenience pointer.
