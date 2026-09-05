# Orbit preview lane and stable promotion

Orbit treats a container digest -- not a mutable tag -- as the identity of an
artifact. `preview` and `stable` help people find an image, but deployments,
acceptance records and promotion use the immutable digest.

GitLab (`gitlab.tomlawson.io`, `ai/orbit`) is where Orbit is built, tested and
merged. GitHub (`tomlawesome/orbit`) is a one-way push mirror: it carries the
same history and tags, and GHCR (`ghcr.io/tomlawesome/orbit`) stays the public
image source. Nothing about stable promotion happens on GitHub; it only
receives what GitLab already decided (#821).

## Protected branch flow

- Ordinary issue branches start from and target `dev`.
- Merge `dev` into `preview` to start or update an ordinary release train.
- The `preview` push runs the full CI gate and publishes the tested image to
  GHCR as `:preview` and `:sha-<commit>`.
- After digest-based acceptance, merge `preview` into `main`.
- A `hotfix/*` branch starts from `main`, publishes and accepts a patch
  preview, merges to `main`, and is then reconciled into `dev` and `preview`.

Do not squash or rebase away the accepted preview revision. Stable promotion
checks that `main` and `preview` are the exact same commit.

## Automatic preview version

Each `preview` build embeds one calculated semantic version, read by
`scripts/calculate-version.mjs` from the highest existing stable `vMAJOR.MINOR.PATCH`
Git tag: an ordinary `preview` train increments minor and resets patch, and a
`hotfix/*` train increments patch. This is informational only -- it is not
what stable promotion reads. When you run the promotion job below, type the
version the preview image already calculated (visible in its
`org.opencontainers.image.version` label or its `--version` output) unless the
owner has decided otherwise.

## Stable promotion (on GitLab)

Promotion is a manual GitLab CI job, `promote_stable` in `.gitlab-ci.yml`. It
only appears, as a manual step, on a pipeline running on `main`, or on a
pipeline you start yourself against any ref by giving it a `VERSION` variable.
Nothing runs it automatically: a release version is a human decision.

To run it:

1. Deploy the accepted preview digest and complete release acceptance.
2. Merge the `preview` -> `main` merge request once acceptance is done.
3. Open `https://gitlab.tomlawson.io/ai/orbit/-/pipelines/new`, choose the
   `main` branch (or the ref you are promoting), add a pipeline variable named
   `VERSION` set to the version, e.g. `1.4.0` or `v1.4.0`, and start the
   pipeline.
4. Find the `promote_stable` job in the pipeline and click Run.

The job (`scripts/ci/promote-stable.sh`) then, in order:

1. Normalises `VERSION` to `vMAJOR.MINOR.PATCH` and refuses anything else.
2. Refuses if the GitLab tag `vX.Y.Z` already exists -- a version does not
   ship twice.
3. Confirms `main` and `preview` point at the exact same commit.
4. Resolves the GHCR `:preview` digest and confirms it still matches
   `:sha-<commit>` for the commit being promoted -- refusing if `preview` has
   moved on since this commit's pipeline tested it.
5. Refuses if `ghcr.io/tomlawesome/orbit:vX.Y.Z` already exists in GHCR.
6. Tags that exact digest `vX.Y.Z` and `stable` in GHCR, by digest, without
   rebuilding anything.
7. Creates the annotated tag `vX.Y.Z` on the GitLab commit through the API.

GitLab's push mirror carries the new tag to GitHub within minutes.
`.github/workflows/release-on-tag.yml` there watches for `v*` tags and runs
`gh release create --verify-tag --generate-notes`, so the GitHub Releases page
keeps working for the public. GitHub makes no decision of its own: if a
release for that tag already exists, it does nothing.

## Required CI/CD variables

The owner creates both under GitLab Settings > CI/CD > Variables, masked,
protected (the job only ever runs on a protected ref):

- `GHCR_PUBLISH_TOKEN` -- a GitHub token (fine-grained or classic) scoped to
  `write:packages` only. Nothing else: it can push and tag container images
  in GHCR and cannot read or write repository code, issues or releases.
- `GITLAB_RELEASE_TOKEN` -- a GitLab project access token on `ai/orbit`,
  Maintainer role, `api` scope, named `release-tagging`. It is what lets the
  job create the tag through the API; a lower role or a `read_api`-only scope
  cannot.

Neither token is ever a command-line argument or printed: the GHCR token is
piped to `crane auth login` on stdin, and the GitLab token travels to `curl`
as a header file. Rotate either by replacing the CI/CD variable; nothing else
needs to change.

## Supported install targets

The operator tooling supports installing v1.3.0 and later; earlier published
releases are not supported install targets
([ADR-0016](adr/0016-release-identity-and-installer-era-boundary.md)). Pinning
a version tag requires the image's own embedded version to name that release,
so a moved tag cannot pass an image off as a version it is not. Moving tags
such as `preview` make no version claim and are unaffected; `stable` always
points at the newest promoted release.

Tags can move; digests cannot. Compose does not default to any discovery tag.
Always set `ORBIT_IMAGE` to and record the accepted digest.
