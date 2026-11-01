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
3. Update [the roadmap](roadmap.md) for the release: set each row's status
   and evidence to what the accepted code does, mark kept promises
   `delivered`, and add a row for any promise found anywhere new. A promise
   that will not be kept is marked `dropped` and removed from where it was
   made.
4. Merge `preview` into `main`.
5. On GitLab, run the manual `promote_stable` job in the pipeline the merge
   started on `main`. It promotes the image built for `main`'s commit, tags
   it `vX.Y.Z` and `latest`, and creates the `vX.Y.Z` tag.
6. Straight away, run the **Countersign a stable release** workflow on GitHub
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
- No back-merge of `preview` into `dev` after an ordinary promotion: the
  `dev` -> `preview` merge commit carries no file changes, the next promotion
  merges cleanly without it, and each back-merge costs a full pipeline. Merge
  `preview` back into `dev` only when something landed on `preview` directly,
  as a hotfix does (owner, 2026-10-17).

Do not squash or rebase away the accepted preview revision. Stable promotion
checks that `main` and `preview` are the exact same commit.

## Automatic preview version

Each `preview` build carries one calculated version number.
`scripts/calculate-version.mjs` reads the highest existing stable
`vMAJOR.MINOR.PATCH` Git tag and increments the patch, for an ordinary
`preview` train and a `hotfix/*` train alike (v0.3.0, then v0.3.1). Nobody
types the version in, at preview time or at promotion time. Stable promotion
reads it back out of the accepted image and runs the same calculation again
to confirm the two agree.

**Starting a new minor or major line.** `scripts/release-line.json` names the
line releases from `dev` belong to, for example `"line": "v0.3"`. To start
v0.4, set it to `"v0.4"` on `dev` before promoting: the next `preview` train
is then v0.4.0, and the ones after it v0.4.1, v0.4.2 with the same setting, so
it never needs resetting. A line at or below the latest release changes
nothing, and a `hotfix/*` train ignores it. A missing or malformed file stops
the build rather than guessing (#1499).

Because both kinds of train now take the next patch, a hotfix and a preview
can compute the same version. Whichever is promoted second is refused at step
5 below (its version no longer matches the recalculation) and is rebuilt.

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
rebuilding that image and re-pinning. The pin is the digest from base-image's
`publish_signing` run (first published 2026-10-10).

**Key rotation:** generate a new pair, replace the two files on the runner
host, commit the new `cosign.pub` (and keep the old public key, see the next
paragraph), then re-sign the manifest that `latest`
points at with the new key and replace its `.sig` asset. Until that third
step is done the one-line installer refuses every install and update: the
`get-orbit.sh` on `main` carries only the committed key, and nothing re-signs
a published manifest by itself (signing only runs inside a release pipeline).
Keep the old public key as a retired key, in the same commit as the new
`cosign.pub`, so no commit exists where the release carry cannot verify its
predecessor (the build before it was signed with the old key):

```sh
mkdir -p cosign-retired
git mv cosign.pub cosign-retired/YYYY-MM-DD.pub   # the day of the rotation
cp /path/to/new/cosign.pub cosign.pub
git add cosign.pub
```

`scripts/ci/carry-previous-release.sh` verifies a predecessor's pair against
`cosign.pub` first, then against each file in `cosign-retired/` in name order,
and the log names the file that verified. A retired key is a public key: keep
it. Delete one only if it is compromised; the next release on each ref then
fails verification and needs an entry in `scripts/ci/carry-accepted-gap` (see
"Carrying the previous build's manifest" below). Nothing else reads
`cosign-retired/`: `get-orbit.sh` and the release checks verify the re-signed
`latest`, not old builds.

Re-sign on the runner host in three steps, with `vX.Y.Z` the current `latest`
release. Only `gitlab-signer` can read the key, but it has no login shell and
no GitHub credential (giving it one would undo the isolation above), so you
download and upload with your own `gh` login and `gitlab-signer` only signs.

First, as yourself, download the manifest into a fresh directory:

```sh
cd "$(mktemp -d)"
gh release download vX.Y.Z -R tomlawesome/orbit -p orbit-release-manifest.json
```

Then, from that directory, copy it into a directory only `gitlab-signer` can
write, sign there as `gitlab-signer` exactly as
`scripts/ci/sign-release-manifest.sh` does (same flags, password read from
`/etc/orbit-signing/password`), and copy the signature back out.
`gitlab-signer` cannot write your directory and you cannot read the key, hence
the hand-over:

```sh
d=/var/tmp/orbit-resign
sudo install -d -m 0700 -o gitlab-signer -g gitlab-signer "$d"
sudo install -m 0600 -o gitlab-signer -g gitlab-signer orbit-release-manifest.json "$d/"
sudo -u gitlab-signer bash -c 'cd /var/tmp/orbit-resign &&
  export COSIGN_PASSWORD="$(< /etc/orbit-signing/password)" &&
  cosign sign-blob --key /etc/orbit-signing/cosign.key \
    --tlog-upload=false --use-signing-config=false --yes \
    --new-bundle-format=false \
    --output-signature orbit-release-manifest.json.sig orbit-release-manifest.json'
sudo install -m 0644 -o "$USER" "$d/orbit-release-manifest.json.sig" .
sudo rm -r "$d"
```

Last, as yourself again, upload it over the old signature:

```sh
gh release upload vX.Y.Z orbit-release-manifest.json.sig -R tomlawesome/orbit --clobber
```

The keyless `.sigstore.json` countersignature covers the manifest, not the
`.sig`, so it is unaffected. Attestations made under the old key stop
verifying, so any digest not yet published must go through validation again
after a rotation.

### Carrying the previous build's manifest (#1480, #1607)

`record_image` also saves the build before this one, its signed release
manifest and signature, as `.orbit-supply-chain/previous/`, so the launcher's
live update test can find the previous preview build by branch.
`scripts/ci/carry-previous-release.sh` does it in two calls. `--prepare` runs
before the image is pushed: it finds the predecessor, fetches its manifest and
signature, verifies them against `cosign.pub` and stages them, so a failure
stops the job before anything is published. The second call, with the pushed
digest, moves the staged pair into `previous/` in one rename. It is fail-loud
and idempotent: a missing or mismatched predecessor fails `record_image` with
a message naming the cause, and nothing is written under `previous/`.

The predecessor is the newest successful `record_image` job on the ref, found
from the project's job list, so a pipeline that ran no `record_image` (a
schedule, a run started by hand) never hides it. Its manifest comes from that
job and its signature from the `sign_evidence` job of the same pipeline, both
by job id, so the two always belong to one build. On a rebuild of the digest
being pushed, the predecessor's own `previous/` pair is carried instead.

`record_image` and `sign_evidence` keep their artifacts for ever
(`expire_in: never`, a few KB per release), so the next release can always
read them. A stuck preview or hotfix release recovers by an ordinary push, a
job retry or waiting, never by a hand-started pipeline or a CI variable.

A ref's first release is recognised automatically: when the whole job list
holds no successful `record_image` job on the ref, the carry logs `first
release, nothing carried`, saves nothing and passes. No variable or setting is
needed. A job list too long to search (the page cap is reached with no match)
fails instead, and is never read as a first release.

When it fails, the message names the cause:

- The predecessor's pipeline has a `sign_evidence` job (the newest one counts)
  that is still running, pending or otherwise in flight: the carry polls
  every 30 seconds (`ORBIT_CARRY_POLL_SECONDS`, a whole number of seconds from 0
  to 60; anything else fails the job naming the variable) for 20 polls, then
  fails saying it is still running. Wait for that job to finish, then run the failed
  job again.
- The newest `sign_evidence` job of the predecessor's pipeline failed or was
  canceled: retry that job, then run the failed job again. The carry does not
  fall back to an older build.
- The predecessor's pipeline has no `sign_evidence` job at all: retry that
  pipeline's `sign_evidence` job if it can be, then run the failed job again;
  the carry does not fall back to an older build.
- The predecessor's manifest or signature answered 404. The message says either
  that the job's artifacts had an expiry date and have expired (a build made
  before `expire_in: never`), or, when the job list gives no expiry date, that
  they are gone (deleted, or never kept). Either way the build before this one is
  lost. Add a line to `scripts/ci/carry-accepted-gap`, commit it through the
  normal review and push: `<ref> <record_image job id> <reason>`, for example
  `preview 123456 artifacts of the pre-#1607 build expired`. The failure message
  names the ref and job id. The carry honours the line only when the
  predecessor it found is that job on that ref, and the failure concerns that
  predecessor's own pair: a 404 on it, or a verifier that ran and rejected its
  signature. It then logs `gap accepted for record_image job N on <ref>
  (<reason>)`, carries nothing and treats the ref as a first release. A line
  never excuses a failing carried `previous/` pair (that pair fails even with a
  matching line), a tooling failure (see below), an API error or a missing
  `sign_evidence` job. A line for another job or ref is logged as stale and
  ignored, and a malformed line fails the job naming it. Remove the entry once
  the next release on the ref has landed. The owner may also press Keep on the
  artifacts of the one predecessor built before this change, which makes the
  entry unnecessary.
- HTTP 401 or 403 on an API call: check that the job token's allowlist
  includes this project with read jobs.
- Any other HTTP status (a 5xx, or a 404 on a job list), a job list that is
  not JSON or a transport error: the carry could not ask, which is not the
  same as nothing being there. The message names the status and URL. Run the
  job again once the API answers.
- An answer larger than the limit (1 MiB for an artifact, 16 MiB for a job
  list page): the carry reads at most limit + 1 bytes, whether or not the server
  declared a length, and fails naming the URL and the limit.
- The manifest and signature verify against neither `cosign.pub` nor any key in
  `cosign-retired/` (the message names every file tried), or a manifest has no
  readable image digest: the predecessor's artifacts are bad and need the owner;
  the recovery is the `scripts/ci/carry-accepted-gap` entry above, for a
  verification failure of the predecessor's own pair. The same failure on the
  predecessor's carried `previous/` pair (the message says "carried") is never
  excused by a line: the build that carried it published a pair that no longer
  verifies, and that needs the owner.
- A tooling failure, which the message says is "not a verdict" and which names
  the tool: `cosign` could not be downloaded (`scripts/ci/ensure-cosign.sh`
  failed), `cosign` exited with a status other than 0 or 1 (for example 2, or
  127 for a missing command), or `openssl` or `base64` is not installed. Only a
  verifier that ran and rejected the signature counts as "does not verify";
  a tool that could not run says nothing about the signature, so no gap line
  excuses it. Fix the tool and run the job again.
- A re-run of an already-published digest whose build carried no `previous/`
  pair fails after the push.

## Stable promotion (on GitLab)

Promotion is a manual GitLab CI job, `promote_stable` in `.gitlab-ci.yml`. It
only appears, as a manual step, on a pipeline running on `main`: the push to
`main` (which starts nothing else, #1546) or one you start yourself on `main`.
A pipeline on any other branch has no such
job, and `promote-stable.sh` refuses to run off `main` as well (#1564), so
only someone who can press a manual job on protected `main` can promote.
Nothing runs it automatically: accepting a release is a human decision.

It needs no input (#1482). The digest it promotes is the one GHCR's
`:sha-<main HEAD>` tag names: the image built and tested for the commit
`main` now holds, which is `preview`'s commit. Pressing the button on that
pipeline is the acceptance; the checks below hold the digest to the same
standard a typed one meets.

An optional `PREVIEW_DIGEST` job variable (`sha256:<64 hex>`) still
overrides that, for a re-run against a digest you name: it must then equal
both tags as well. The job log says which route chose the digest, and prints
it.

To run it:

1. Deploy the accepted preview digest and complete release acceptance.
2. Merge the `preview` -> `main` merge request once acceptance is done.
3. Open the pipeline that merge started on `main`
   (`https://gitlab.tomlawson.io/ai/orbit/-/pipelines?ref=main`), find the
   `promote_stable` job and click Run.


The job (`scripts/ci/promote-stable.sh`) then does the following, in order:

1. If `PREVIEW_DIGEST` is given, checks it is `sha256:<64 hex>`.
2. Confirms `main` and `preview` point at the exact same commit.
3. Resolves GHCR's `:preview` tag and `:sha-<main HEAD>` tag. With no
   `PREVIEW_DIGEST`, the `:sha-<main HEAD>` digest is the one promoted, and
   the job refuses if that tag does not exist, or if the pipeline you pressed
   it in is not for main's current commit. It then confirms both tags
   equal the digest. It refuses if `preview` has moved on, or the digest
   never reached main's own commit.
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
8. Refuses if `ghcr.io/tomlawesome/orbit:vX.Y.Z` already resolves in GHCR,
   unless it already resolves to the exact digest being promoted, in which
   case the job carries on from there: it skips step 9 and still checks both
   tags hold that digest before step 10. This lets a rerun finish a
   promotion that failed after tagging GHCR but before creating the GitLab
   tag (for example, an expired `GITLAB_RELEASE_TOKEN`).
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
2. Click **Run workflow** and enter the release tag, for example `v0.3.0`.


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
for any channel, including `preview`; only the self-fetch is restricted. It does not check the manifest's signature itself; [Installing a preview build](installing-preview.md) gives the checks to run by hand first.

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
rotation, since they carry only the current key. `latest` carries a
manifest signed under the current key only once the re-sign step above is
done. A user who pins an older
`ORBIT_VERSION` must also fetch `get-orbit.sh` from that version's own tag
(`…/orbit/vX.Y.Z/scripts/get-orbit.sh`), which still carries the key that
release was actually signed with. That holds only for releases left signed
under their original key: the release that was `latest` at rotation was
re-signed in "Key rotation" above and now verifies only with the current key,
so its own tag's `get-orbit.sh` (old key) refuses it; pin that release with
`main`'s `get-orbit.sh` instead.

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

Promotion to `preview` does not wait on the nightly browser run: the
push to `preview` runs the full browser set on the commit being promoted, and
that run is the promotion proof; the `dev -> preview` merge request runs the
quick checks only. `ORBIT_REUSE_TOKEN`
(read-only, unprotected, masked, environment scope `ci-read-tokens`, so only the
jobs that read it receive it -- see "Who starts a pipeline, and where it runs"
in `docs/quality-strategy.md`) is still read by the jobs that look up earlier
pipelines' evidence.

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
([ADR-0016](adr/0016-release-identity-and-installer-era-boundary.md)), and the
installer refuses them. Pinning a version tag requires
the image's own embedded version to name that release, so a moved tag cannot
pass an image off as a version it is not. Moving tags such as `preview` make
no version claim and are unaffected; `latest` always points at the newest
promoted release.

Tags can move; digests cannot. Compose does not default to any discovery tag.
Always set `ORBIT_IMAGE` to the accepted digest, and record that digest.
