# Orbit preview lane and stable promotion

Orbit treats a container digest -- not a mutable tag -- as the identity of an
artifact. `preview` and `latest` help people find an image, but deployments,
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
  GHCR as `:preview` and `:sha-<commit>`. On GitHub's mirror, the
  `publish-from-gitlab` workflow copies the digest GitLab already built and
  tested; it never rebuilds. It does this by polling the GitLab pipeline for
  the pushed commit (`scripts/ci/gitlab-await-tested-image.sh`) and copying
  the digest only once that pipeline succeeds. If a GitLab job flakes and is
  retried, the same pipeline turning `success` within the wait window
  (`ORBIT_WAIT_MINUTES`, default 120 minutes) is picked up automatically on
  the next poll -- no one needs to re-run anything. Only once that window
  passes with the pipeline still failed does the GitHub run need re-running by
  hand, with `gh run rerun <run-id> --failed`.
- After digest-based acceptance, merge `preview` into `main`.
- A `hotfix/*` branch starts from `main`, publishes and accepts a patch
  preview, merges to `main`, and is then reconciled into `dev` and `preview`.

Do not squash or rebase away the accepted preview revision. Stable promotion
checks that `main` and `preview` are the exact same commit.

## Automatic preview version

Each `preview` build embeds one calculated semantic version, read by
`scripts/calculate-version.mjs` from the highest existing stable `vMAJOR.MINOR.PATCH`
Git tag: an ordinary `preview` train increments minor and resets patch, and a
`hotfix/*` train increments patch. The version is never typed in by an
operator, at preview time or at promotion time: stable promotion reads it
back out of the accepted image itself and re-runs the same calculation to
confirm the two agree.

## Validation evidence and the publication split

No job both judges an image and ships it
([ADR-0020](adr/0020-validation-evidence-binds-digest-and-policy.md), #661).
On a `preview`/`hotfix-*` push, `record_image` pushes the tested image as
`sha-<commit>` only and records the digest and the policy version that judged
it; `sign_evidence` — the one job on the dedicated `orbit-signing` runner,
whose host holds the key pair and mounts it read-only into its jobs — mints
the cosign attestation binding those together; `publish_channel` verifies
that evidence with the committed `cosign.pub`, re-runs the cheap identity and
policy checks against the digest, and only then creates the channel tag.

The runner is the key fence. This GitLab is CE, which has no protected
environments and no environment-scoped variables, so a CI/CD variable would
be readable by every job in a protected-branch pipeline. The key therefore
never enters GitLab at all: it lives on the runner host, and only the job
tagged `orbit-signing` can reach it. The runner is registered protected
(it refuses jobs from unprotected refs) and locked to this project.

**Re-publishing:** if publication fails (or a tag needs recreating), retry
`publish_channel` alone — it re-verifies and re-tags without re-running
validation. Evidence is valid for seven days from `recordedAt`; after that
the verifier refuses with an "expired" message and the commit must go through
validation again (re-run the pipeline). That cost is intended.

**Owner setup (agents cannot create these — do not create any `COSIGN_*`
CI/CD variables; if any exist from the earlier draft of this section, delete
them):**

1. `cosign generate-key-pair` locally, with a password. Commit the public
   half as `cosign.pub` at the repository root; the private key and password
   never enter chat or the repository. (Already done: the committed
   `cosign.pub` stays valid under this design.)
2. On the `gitlab-runners` host, as root, place the key material where the
   signing runner will mount it:

   ```sh
   install -d -m 0755 /etc/orbit-signing
   install -m 0600 /path/to/cosign.key /etc/orbit-signing/cosign.key
   ( umask 077 && IFS= read -r -s -p 'key password: ' p && \
     printf '%s' "$p" > /etc/orbit-signing/password ); echo
   ```

   The `read -s` keeps the password off the command line and out of shell
   history. The directory is mounted read-only into the signing job's
   container, which runs as root inside that container, so root-owned 0600
   files are readable there; nothing else on the host needs to read them,
   and no other runner mounts the directory.
3. Register a second project runner on that host (the first is `orbit-build`),
   docker executor, tag `orbit-signing`, **protected** (Settings > CI/CD >
   Runners: "Protected" ticked, so it refuses jobs from unprotected refs),
   **locked to this project**, "run untagged jobs" off. In its
   `config.toml` entry add the mount:

   ```toml
   [runners.docker]
     volumes = ["/etc/orbit-signing:/etc/orbit-signing:ro", "/cache"]
   ```

4. Confirm `preview` and `hotfix/*` are protected branches: the protected
   runner will not pick up the `sign_evidence` job otherwise, and the
   pipeline will sit with the job stuck rather than name the cause.

Until this setup exists, `sign_evidence` either finds no runner (no
`orbit-signing` runner registered) or fails closed naming the missing file
in `/etc/orbit-signing`, and nothing publishes.

**Key rotation:** generate a new pair, replace the two files on the runner
host, commit the new `cosign.pub`. Attestations made under the old key stop
verifying, so any digest not yet published must be revalidated after a
rotation.

## Stable promotion (on GitLab)

Promotion is a manual GitLab CI job, `promote_stable` in `.gitlab-ci.yml`. It
only appears, as a manual step, on a pipeline running on `main`, or on a
pipeline you start yourself against any ref by giving it a `PREVIEW_DIGEST`
variable. Nothing runs it automatically: accepting a release is a human
decision.

The only input is `PREVIEW_DIGEST`, the accepted preview image's digest
(`sha256:<64 hex>`). Find it either:

- in the `record_image` job's log for the pipeline that tested the commit
  being promoted (it prints the digest it pushed, and records the same value
  in the `gitlab-tested-image.json` artifact); or
- by resolving GHCR's `:preview` tag directly:
  `docker buildx imagetools inspect ghcr.io/tomlawesome/orbit:preview`.

To run it:

1. Deploy the accepted preview digest and complete release acceptance.
2. Merge the `preview` -> `main` merge request once acceptance is done.
3. Open `https://gitlab.tomlawson.io/ai/orbit/-/pipelines/new`, choose the
   `main` branch (or the ref you are promoting), add a pipeline variable named
   `PREVIEW_DIGEST` set to the digest, e.g. `sha256:abcd...`, and start the
   pipeline.
4. Find the `promote_stable` job in the pipeline and click Run.

The job (`scripts/ci/promote-stable.sh`) then, in order, exactly as the
retired `promote-container.yml` GitHub workflow did:

1. Validates `PREVIEW_DIGEST` is `sha256:<64 hex>`.
2. Confirms `main` and `preview` point at the exact same commit.
3. Resolves GHCR's `:preview` tag and `:sha-<main HEAD>` tag and confirms both
   still equal `PREVIEW_DIGEST` -- refusing if `preview` has moved on, or the
   digest never reached main's own commit.
4. Reads the image's `org.opencontainers.image.version`/`.revision` and
   `io.github.tomlawesome.orbit.release-stage`/`.source-branch` labels and its
   embedded `/opt/orbit/VERSION`, `/opt/orbit/REVISION`, `/opt/orbit/CHANNEL`
   files and `--version` output, and refuses if any of them disagree.
5. Recalculates the expected version with `scripts/calculate-version.mjs` for
   the image's channel (`hotfix` if its source branch is `hotfix/*`,
   otherwise `preview`) and refuses if it disagrees with the image's own
   version label.
6. Refuses if the GitLab tag `vX.Y.Z` already exists -- a version does not
   ship twice.
7. Runs `scripts/stable-promotion-policy.mjs`, which refuses unless the
   image's revision is an ancestor of both `main` and its source branch and
   the tree at that revision exactly matches `main`'s tree.
8. Refuses if `ghcr.io/tomlawesome/orbit:vX.Y.Z` already resolves in GHCR.
9. Tags that exact digest `vX.Y.Z` and `latest` in GHCR, by digest, without
   rebuilding anything (`latest`, not `stable`: `install.sh` defaults
   `ORBIT_CHANNEL` to `latest`).
10. Creates the annotated tag `vX.Y.Z` on the GitLab commit through the API.

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
piped to `docker login` on stdin, and the GitLab token travels to `curl` as a
header file. Rotate either by replacing the CI/CD variable; nothing else
needs to change.

The signing key material is stricter still — it is not a CI/CD variable at
all, but files on the `orbit-signing` runner's host that only the signing
job's runner mounts; see "Validation evidence and the publication split"
above.

## Supported install targets

The operator tooling supports installing v1.3.0 and later; earlier published
releases are not supported install targets
([ADR-0016](adr/0016-release-identity-and-installer-era-boundary.md)). Pinning
a version tag requires the image's own embedded version to name that release,
so a moved tag cannot pass an image off as a version it is not. Moving tags
such as `preview` make no version claim and are unaffected; `latest` always
points at the newest promoted release.

Tags can move; digests cannot. Compose does not default to any discovery tag.
Always set `ORBIT_IMAGE` to and record the accepted digest.
