# Orbit preview lane and stable promotion

Orbit treats a container digest—not a mutable tag—as the identity of an
artifact. `preview` and `latest` help people find an image, but deployments,
acceptance records and promotion use the immutable digest.

## Protected branch flow

- Ordinary issue branches start from and target `dev`.
- Merge `dev` into protected `preview` to start or update an ordinary
  release train.
- The protected `preview` push runs the authoritative CI and publication path.
- After digest-based acceptance, merge `preview` into protected `main`.
- A `hotfix/*` branch starts from `main`, publishes and accepts a patch preview,
  merges to `main`, and is then reconciled into `dev` and `preview`.

Do not squash or rebase away the accepted preview revision. Stable promotion
verifies that revision and its exact tree.

## Automatic version calculation

Orbit uses one semantic version per release train. The calculator reads the
highest stable `vMAJOR.MINOR.PATCH` Git tag:

- an ordinary `preview` train increments minor and resets patch;
- a `hotfix/*` train increments patch; and
- a major increment requires a separate protected human release decision.

Until the first stable Git tag exists, the package version is the migration
baseline. Commits, retries and repeated preview builds do not consume versions;
they all calculate the same candidate until stable promotion creates the tag.
No operator types a version into the promotion workflow.

## Preview publication

A push to protected `preview` (or a bounded `hotfix/*` branch) builds one AMD64
image with its calculated version and exact source revision embedded in
read-only image files and OCI labels. The same loaded image passes system and
supply-chain validation before it is pushed as `preview`.

Publication records the resolved digest and attaches verified GitHub OIDC
provenance and SPDX SBOM attestations to that digest. Deploy the digest—not the
tag—for manual acceptance. The image reports its identity without configured
secrets:

```text
docker run --rm ghcr.io/tomlawesome/orbit@sha256:<digest> --version
Orbit vMAJOR.MINOR.PATCH
```

The only new registry tag is `preview`. `dev` remains reserved and unpublished.
There are no per-run, commit, branch or semantic-version container tags.

## Stable merge and promotion

1. Deploy the protected preview by digest and complete release acceptance.
2. Open the protected pull request from `preview` to `main` (or from the tested
   `hotfix/*` source). CI verifies the `preview` tag resolves to the pull-request
   head, validates the embedded version/revision and verifies provenance and
   SBOM attestations without building a container.
3. Merge without changing the accepted source tree.
4. From `main`, run **Promote tested Orbit preview** with the accepted digest.
5. Approve the protected `production` environment.

The workflow reads the version from the image, verifies it against the embedded
identity, checks the exact protected source and `main` tree, and refuses an
existing stable Git tag. It points `latest` at the accepted digest without a
rebuild, creates the matching Git tag and GitHub Release, and records the digest
in the release notes.

## Required repository settings

- Protect `dev`, `preview` and `main` against direct changes, force-pushes
  and deletion. Require reviewed pull requests and resolved conversations.
- Keep the fast checks required for ordinary changes and the preview identity
  verification required for pull requests to `main`.
- Protect `hotfix/**` while active and require review before stable merge.
- Create a GitHub Actions environment named `production`, require reviewers,
  prevent self-review where practical, and allow deployments only from `main`.
- Keep the repository-linked GHCR package writable only by this repository's
  least-privilege `GITHUB_TOKEN`.

Historic `preview-*` and `rc-*` tags remain immutable audit evidence. Do not
relabel, replace, or promote them.

Tags can move; digests cannot. Compose does not default to either discovery
tag. Always set `ORBIT_IMAGE` to and record the accepted digest.
