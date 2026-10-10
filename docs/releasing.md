# Orbit preview lane and stable promotion

Orbit identifies a build by its **digest**: a fingerprint that names exactly
one container image and nothing else. A tag such as `preview` or `latest` is a
name that can be moved to point at a different image tomorrow, so it helps
people find an image but is never what gets deployed, accepted or promoted.
Those steps always use the digest.

Three more words this document uses:

- An **attestation** is a signed statement about an image: "this digest
  passed these checks under this policy". It is a proof file, kept beside
  the image, that anyone can check.
- **cosign** is the tool that makes and checks those signatures.
- **Keyless signing** is a cosign mode where, instead of a key file, the
  signature is tied to the job that signed it (here, a workflow in the
  `tomlawesome/orbit` GitHub repository) through a short-lived certificate.

GitLab (`gitlab.tomlawson.io`, `ai/orbit`) is where Orbit is built, tested and
merged. GitHub (`tomlawesome/orbit`) is a one-way push mirror: it carries the
same history and tags, and GHCR (`ghcr.io/tomlawesome/orbit`) is the public
image source. Nothing about stable promotion happens on GitHub; it only
receives what GitLab already decided (#821). The path of an image: `record_image`
pushes the tested image to `registry.tomlawson.io` and records its digest,
`sign_evidence` attests it from the dedicated signing runner, `publish_channel`
adds the channel tag (#661, ADR-0020), and `.github/workflows/publish-from-gitlab.yml`
copies that digest to GHCR when the mirror delivers the `preview` push. Nothing
built on GitHub reaches a registry. The mirror itself (GitLab Settings >
Repository > Mirroring) is owner-managed, and a red GitHub run never blocks a
GitLab merge.

## What you do, in short

To ship a stable release:

1. Merge `dev` into `preview`. CI tests the build, signs the evidence and
   publishes the image to GHCR as `:preview`.
2. Deploy that preview by its digest and do release acceptance: the
   charter's list ([v1 charter](v1-charter.md#release-acceptance), item 4),
   checked off on the release's acceptance issue.
3. Merge `preview` into `main`.
4. On GitLab, start a pipeline on `main` with `PREVIEW_DIGEST` set to the
   accepted digest, and run the manual `promote_stable` job. It tags the image
   `vX.Y.Z` and `latest` and creates the `vX.Y.Z` tag.
5. Straight away, run the **Countersign a stable release** workflow on GitHub
   with that tag. This adds the owner's second signature.

The rest of this document says what each step checks and why.

## Protected branch flow

- Ordinary issue branches start from and target `dev`.
- Merge `dev` into `preview` to start or update an ordinary release train.
- The `preview` push runs the full CI gate and publishes the tested image to
  GHCR as `:preview` and `:sha-<commit>`. On GitHub's mirror, the
  `publish-from-gitlab` workflow copies the digest GitLab already built and
  tested; it never rebuilds. It polls the GitLab pipeline for the pushed
  commit (`scripts/ci/gitlab-await-tested-image.sh`) and copies the digest
  only once that pipeline succeeds. If a GitLab job fails by chance and is
  retried, the next poll picks the pipeline up as soon as it turns `success`
  within the wait window (`ORBIT_WAIT_MINUTES`, default 120 minutes); nobody
  needs to re-run anything. Only if the window passes with the pipeline still
  failed do you re-run the GitHub run by hand, with
  `gh run rerun <run-id> --failed`.
- After digest-based acceptance, merge `preview` into `main`.
- A `hotfix/*` branch starts from `main`, publishes and accepts a patch
  preview, merges to `main`, and is then merged back into `dev` and
  `preview`.

Do not squash or rebase away the accepted preview revision. Stable promotion
checks that `main` and `preview` are the exact same commit.

## Automatic preview version

Each `preview` build carries one calculated version number.
`scripts/calculate-version.mjs` reads the highest existing stable
`vMAJOR.MINOR.PATCH` Git tag; an ordinary `preview` train increments minor and
resets patch, and a `hotfix/*` train increments patch. Nobody types the
version in, at preview time or at promotion time. Stable promotion reads it
back out of the accepted image and runs the same calculation again to confirm
the two agree.

## Validation evidence and the publication split

No single job both judges an image and ships it
([ADR-0020](adr/0020-validation-evidence-binds-digest-and-policy.md), #661).
On a `preview`/`hotfix-*` push, three jobs run in turn:

- `record_image` pushes the tested image as `sha-<commit>` only, and records
  its digest and the version of the policy that judged it.
- `sign_evidence` makes the cosign attestation that binds those two together.
  It is the one job that runs on the dedicated `orbit-signing` runner, whose
  host holds the key pair and mounts it read-only into its jobs.
- `publish_channel` checks that attestation with the committed `cosign.pub`,
  re-runs the cheap identity and policy checks against the digest, and only
  then creates the channel tag.

The signing key never enters GitLab at all. It lives on the runner host, and
only the job tagged `orbit-signing` can reach it. The reason: this GitLab is
the Community Edition, which has no protected environments and no
environment-scoped variables, so a CI/CD variable would be readable by every
job in a protected-branch pipeline. The runner is registered as protected (it
refuses jobs from unprotected refs) and locked to this project.

**Re-publishing:** if publication fails, or a tag needs recreating, retry
`publish_channel` alone. It re-checks and re-tags without re-running
validation. Evidence is valid for seven days from `recordedAt`; after that the
verifier refuses with an "expired" message and the commit must go through
validation again (re-run the pipeline). That cost is intended.

**Owner setup (agents cannot create these — do not create any `COSIGN_*`
CI/CD variables; if any exist from the earlier draft of this section, delete
them):**

1. Run `cosign generate-key-pair` locally, with a password. Commit the public
   half as `cosign.pub` at the repository root; the private key and password
   never enter chat or the repository. (Already done: the committed
   `cosign.pub` stays valid under this design.)
2. On the `gitlab-runners` host, as root, give signing its own Docker: a
   separate user, `gitlab-signer`, running its own rootless Docker that no
   other runner and no job can reach (#1373). Every other runner on the host
   uses `gitlab-runner`'s Docker, and two of them hand that Docker to their
   jobs, so key material that user can read is in reach of any job:

   ```sh
   useradd -m -s /usr/sbin/nologin gitlab-signer   # Debian gives it a subuid range
   grep gitlab-signer /etc/subuid /etc/subgid      # both must print a range
   loginctl enable-linger gitlab-signer
   ```

   Put the key material where the signing runner will mount it, owned by
   `gitlab-signer`:

   ```sh
   install -d -m 0700 -o gitlab-signer -g gitlab-signer /etc/orbit-signing
   install -m 0600 -o gitlab-signer -g gitlab-signer /path/to/cosign.key /etc/orbit-signing/cosign.key
   ( umask 077 && IFS= read -r -s -p 'key password: ' p && \
     printf '%s' "$p" > /etc/orbit-signing/password ); echo
   chown gitlab-signer:gitlab-signer /etc/orbit-signing/password
   ```

   The `read -s` keeps the password off the command line and out of shell
   history. The signing Docker is **rootless**, run by `gitlab-signer`: root
   inside the job container is that user on the host, so root-owned 0600
   files would be unreadable there (they read as `nobody`), and
   `gitlab-runner`'s Docker cannot read these at all. Nothing else on the
   host needs to read them, and no other runner mounts the directory.

   Then start that user's Docker. Rootless Docker takes a snapshot of `/etc`
   when its daemon starts, so a directory created under `/etc` afterwards is
   invisible to it (the job sees an empty mount and fails with "no password
   file"): create the directory first, or restart the daemon after.

   ```sh
   U=$(id -u gitlab-signer)
   sudo -u gitlab-signer XDG_RUNTIME_DIR=/run/user/$U \
     DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus \
     dockerd-rootless-setuptool.sh install
   ```

   Later reboots need nothing: the directory exists before Docker starts.
   (The snapshot was found on the first `preview` run, pipeline 791,
   2026-09-09.)
3. Register a second project runner on that host (the first is `orbit-build`),
   docker executor, tag `orbit-signing`, **protected** (Settings > CI/CD >
   Runners: "Protected" ticked, so it refuses jobs from unprotected refs),
   **locked to this project**, "run untagged jobs" off. In its
   `config.toml` entry add the mount, and `gitlab-signer`'s rootless socket,
   never `gitlab-runner`'s (without a `host` the executor looks for
   `/var/run/docker.sock`, which does not exist):

   ```toml
   [runners.docker]
     host = "unix:///run/user/<gitlab-signer's uid>/docker.sock"
     volumes = ["/etc/orbit-signing:/etc/orbit-signing:ro", "/cache"]
   ```

4. Confirm `preview` and `hotfix/*` are protected branches. Otherwise the
   protected runner will not pick up the `sign_evidence` job, and the
   pipeline sits with the job stuck rather than naming the cause.

Until this setup exists, `sign_evidence` either finds no runner (no
`orbit-signing` runner registered) or stops, naming the missing file in
`/etc/orbit-signing`, and nothing publishes.

`sign_evidence` installs and downloads nothing while the key is mounted
(#1368). Its tools, cosign included, come baked into `$ORBIT_SIGNING_IMAGE`,
which ai/orbit-base-image's `publish_signing` builds and scans; pin the
digest from that job's `published-signing-digest.txt`. If the image's cosign
is not exactly the version `scripts/ci/ensure-cosign.sh` pins, the job stops
naming both versions rather than fetching one, so a cosign bump here means
rebuilding that image and re-pinning. Until the first publish the pin is an
all-zero placeholder and the job fails to pull its image.

**Key rotation:** generate a new pair, replace the two files on the runner
host, commit the new `cosign.pub`. Attestations made under the old key stop
verifying, so any digest not yet published must go through validation again
after a rotation.

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


The job (`scripts/ci/promote-stable.sh`) then does the following, in order.
Steps 1-8 and 10 are what the retired `promote-container.yml` GitHub workflow
did; step 9's `vX.Y.Z` tag is what that workflow stopped doing between v1.0.0
and v1.1.0 (see "Version tags in GHCR start at v0.3.0" below):

1. Checks `PREVIEW_DIGEST` is `sha256:<64 hex>`.
2. Confirms `main` and `preview` point at the exact same commit.
3. Resolves GHCR's `:preview` tag and `:sha-<main HEAD>` tag and confirms both
   still equal `PREVIEW_DIGEST`. It refuses if `preview` has moved on, or the
   digest never reached main's own commit.
4. Checks that everything the image says about its own version agrees. It
   reads the image's `org.opencontainers.image.version` and `.revision`
   labels, its `io.github.tomlawesome.orbit.release-stage` and
   `.source-branch` labels, its embedded `/opt/orbit/VERSION`,
   `/opt/orbit/REVISION` and `/opt/orbit/CHANNEL` files, and its `--version`
   output, and refuses if any of them disagree.
5. Recalculates the expected version with `scripts/calculate-version.mjs` for
   the image's channel (`hotfix` if its source branch is `hotfix/*`,
   otherwise `preview`) and refuses if it disagrees with the image's own
   version label.
6. Refuses if the GitLab tag `vX.Y.Z` already exists: a version does not
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

### Countersign the release (#1075)

Straight after `promote_stable` finishes, add the second signature:

1. Open the **Countersign a stable release** workflow in the GitHub Actions
   tab: https://github.com/tomlawesome/orbit/actions/workflows/countersign.yml
2. Click **Run workflow** and enter the release tag, for example `v1.4.0`.


It resolves the release's digest in GHCR and the tag's commit. Then it checks
GitLab's key-based evidence for them with the same shared verifier every
publishing hop uses, and refuses if that fails. Only then does it sign the
digest keyless and check the new signature.

Why it exists: `sign_evidence` signs automatically with a key on the
`orbit-signing` runner host. Whoever controlled that host could also push to
the registry, and sign whatever they pushed. The countersignature can only be
started from the owner's GitHub login, so a bad release needs two separate
break-ins on two hosts. Previews don't get one: a preview is for testing, not
for trusting.

Two limits:

- **Within seven days.** The verifier refuses evidence older than seven days,
  so countersign right after promoting.
- **Needs `main`.** GitHub only offers the workflow once the file is on
  `main`, so it's available from the first stable release that contains it.

### Check both signatures on a release

A stable release is only trustworthy if **both** signatures verify. Treat
either one missing as a reason not to use it. Each `cosign verify` below
proves that the named image was signed by the expected party and has not
changed since. With
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/):

```sh
# 1. The owner's keyless countersignature, made on GitHub.
cosign verify ghcr.io/tomlawesome/orbit@sha256:... \
  --certificate-identity-regexp '^https://github.com/tomlawesome/orbit/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# 2. GitLab's key-based validation evidence, with the committed cosign.pub.
#    It lives beside the image in the GitLab registry, not in GHCR, so this
#    one needs read access to registry.tomlawson.io/ai/orbit.
cosign verify-attestation --key cosign.pub \
  --type https://tomlawson.io/attestations/orbit-validation/v1 \
  --insecure-ignore-tlog=true \
  registry.tomlawson.io/ai/orbit@sha256:...
```

A user's own machine runs the first of these checks automatically: see "The
launcher and signed release manifest" below.

## The launcher and signed release manifest (ADR-0031)

A user's first command,
`curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh | bash`,
installs a signed launcher, not just a signed image. This is what makes that
possible.

**The manifest.** Every `preview`/`hotfix/*` pipeline's `record_image` job
writes `orbit-release-manifest.json`. It lists the version, channel, Orbit
commit, the image's repository and digest, the launcher pin
(`launcher/pin.json`'s tag and commit), and the sha256 of every file shipped
alongside it: the two launcher archives, `install.sh` and `get-orbit.sh`. It
is one statement, "this launcher and these scripts go with this image",
covering all of them at once. One signature per file would prove each file is
ours without proving they belong together.

`sign_evidence` signs the manifest the same way it attests the image: a
cosign key-based signature of the file, with the same committed key and no
transparency log, written to `orbit-release-manifest.json.sig`. Every
consumer checks it two ways, with cosign and with
`openssl dgst -sha256 -verify`, through the one shared script,
`scripts/ci/verify-release-manifest.sh`.

**Where it travels.** Only `release-on-tag.yml` publishes these files. It
downloads the manifest, its `.sig` and the two launcher archives from the
GitLab pipeline that tested the commit a stable tag points at, checks them,
checks each file's sha256 against the manifest, and attaches them to the
release. It never rebuilds anything. It uploads `install.sh` and
`get-orbit.sh` from its own checkout, which is safe only because that is a
checkout of the exact tested commit: the same commit SHA can only ever mean
the same file bytes, and the workflow's file check proves that rather than
assuming it.

`publish-from-gitlab.yml`, which runs automatically on every push to
`preview` or a `hotfix/*` branch, only copies the tested image digest to
GHCR. It does not hold `contents: write` and never touches the launcher,
manifest or a release (owner decision, 2026-09-24, #1107 option 21a): an
automatic workflow must not be able to change the releases page. There is no
automatically published preview launcher; a preview install needs a
verified manifest handed to `install.sh` directly, via
`ORBIT_RELEASE_MANIFEST`.

**Second signature.** Straight after countersigning a stable release's image
(above), the **Countersign a stable release** workflow also countersigns the
manifest. It downloads the manifest and `.sig` already on the release, checks
them, refuses if the manifest names a different image digest than the one it
just countersigned, then signs the manifest keyless
(`cosign sign-blob --bundle`) and uploads
`orbit-release-manifest.json.sigstore.json` to the release. Preview releases
never get this bundle: a preview is for testing, not for trusting.

**What a user's machine checks.** `scripts/get-orbit.sh` downloads the
manifest and `.sig` for the requested stable channel (`latest`, the default,
or a `vX.Y.Z` pin), checks the signature with `openssl` against a key built
into the script, downloads the launcher archive and `install.sh`, checks
their sha256s against the manifest, and only then runs the launcher.
`ORBIT_CHANNEL=preview` refuses at once, before any download, with a message
pointing at `ORBIT_RELEASE_MANIFEST` for a preview install instead. If
`cosign` is installed, `get-orbit.sh` also checks the keyless
countersignature bundle, and refuses without one: the self-fetch path is
stable-only, so the bundle is always expected. `install.sh` run on its own
does the same manifest fetch, check and stable-only restriction for whichever
channel it is given, so a direct run is signature-checked too, although
the launcher is the only supported install entry (ADR-0031, amendment
2026-10-04). Passing `ORBIT_RELEASE_MANIFEST` directly still works
for any channel, including `preview`; only the self-fetch is restricted.

**Key fingerprint.** The key built into `get-orbit.sh` and `install.sh` is
`cosign.pub`, byte for byte; a test fails if either drifts. To check the
fingerprint yourself:

```sh
openssl pkey -pubin -in cosign.pub -outform DER | openssl dgst -sha256
```

```
SHA2-256(stdin)= ed183527165c366de2a4005d8b20c3df687ea2e35d488de7961806867c9d1a11
```

**Rotation.** Follows "Key rotation" above, plus one thing specific to the
launcher path: the scripts on `main` only accept manifests signed after the
rotation, since they carry only the current key. `latest` always carries a
manifest signed under the current key. A user who pins an older
`ORBIT_VERSION` must also fetch `get-orbit.sh` from that version's own tag
(`…/orbit/vX.Y.Z/scripts/get-orbit.sh`), which still carries the key that
release was actually signed with.

**A limit worth stating plainly:** on the `latest` channel there is no
freshness check. Whoever controls what `get-orbit.sh` downloads from could
serve an *older*, correctly signed release instead of the newest one. A
signature proves a release is real, not that it is the newest. Pinning to a
specific release closes this, but the variable depends on which script is
doing the fetching: `get-orbit.sh` reads `ORBIT_VERSION=vX.Y.Z`; `install.sh`
has no such variable and is instead pinned by setting
`ORBIT_CHANNEL=vX.Y.Z` directly (the default is `latest`). Either way, the
script refuses a manifest whose own `version` field does not match the pin,
so an older release can only be installed by asking for it by name, never
served silently in place of a newer one. See `docs/installer-guarantees.md`
for the full list of what is and is not checked.

### Version tags in GHCR start at v0.3.0

`ghcr.io/tomlawesome/orbit` has no `v1.1.0` or `v1.2.0` tag, and never had one
(#1019). The GitHub promotion workflow originally tagged the promoted digest
`vX.Y.Z` and `latest`, which is why `v1.0.0` still resolves. Commit 6952f35
(2026-08-08, "feat(release): automate preview versions and lanes") rewrote the
promote step to `--tag "${image}:latest"` alone and dropped the version tag; it
was not noticed because the release notes still recorded the digest. v1.1.0
(2026-08-08) and v1.2.0 (2026-08-10) were both promoted after that change, so
each moved `latest` and nothing else. ADR-0016 had already found the same gap
from the other side in August: `v1.0.0` was "the only version tag an operator
could pin".

Nothing was removed and nothing needs repairing in the pipeline: the GitLab
`promote_stable` job tags both names (step 9 above), and
`scripts/promote-stable.test.mjs` asserts both, so v0.3.0 onward is tagged
correctly.

The two missing releases are deliberately left missing. ADR-0016 makes v0.3.0
the supported-install floor, so a `v1.1.0` or `v1.2.0` tag would be a pinnable
name for an image `install.sh` refuses to install. Their digests stay on the
record here and in their GitHub release notes:

| Release | Digest | In GHCR today |
| --- | --- | --- |
| v1.1.0 (retracted alpha, #1213) | `sha256:92fb79336d997139002f94c52fd4767787767cc293147c12bbcfc25362a9237d` | untagged, still pullable by digest |
| v1.2.0 (retracted alpha, #1213) | `sha256:35ad7cea14f835b8e5b350faa0fcf711cbf95c517a2bad26f5fe72795a8aeb12` | carried by `latest` |

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

The signing key material is stricter still. It is not a CI/CD variable at
all, but files on the `orbit-signing` runner's host that only the signing
job's runner mounts; see "Validation evidence and the publication split"
above.

## Supported install targets

The operator tooling supports installing v0.3.0 and later; earlier published
releases, and the retracted v1.0.0 to v1.2.0 tags, are not supported install
targets
([ADR-0016](adr/0016-release-identity-and-installer-era-boundary.md)), and
GHCR carries no version tag for them either. Pinning a version tag requires
the image's own embedded version to name that release, so a moved tag cannot
pass an image off as a version it is not. Moving tags such as `preview` make
no version claim and are unaffected; `latest` always points at the newest
promoted release.

Tags can move; digests cannot. Compose does not default to any discovery tag.
Always set `ORBIT_IMAGE` to the accepted digest, and record that digest.
