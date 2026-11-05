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

GitLab (the project's own GitLab host, project `ai/orbit`) is where Orbit is built, tested and
merged. GitHub (`tomlawesome/orbit`) is a one-way push mirror: it carries the
same history and tags, and GHCR (`ghcr.io/tomlawesome/orbit`) is the public
image source. Nothing about stable promotion happens on GitHub; it only
receives what GitLab already decided (#821). The path of an image: `record_image`
pushes the tested image to the GitLab host's container registry and records its digest,
`sign_evidence` attests it from the dedicated signing runner, `publish_channel`
adds the channel tag (#661, ADR-0020), and `.github/workflows/publish-from-gitlab.yml`
copies that digest to GHCR when the mirror delivers the `preview` push. Nothing
built on GitHub reaches a registry. The mirror itself (GitLab Settings >
Repository > Mirroring) is owner-managed, and a red GitHub run never blocks a
GitLab merge.

## What you do, in short

To ship a stable release:

Before step 1, on `dev`: write `src/release-notes/<version>.ts` (for everyone / for administrators; empty parts show nothing). It ships in the image, so it must be merged before the preview is built.

1. Merge `dev` into `preview`. CI tests the build, signs the evidence and
   publishes the image to GHCR as `:preview`.
2. Deploy that preview by its digest and do release acceptance: the
   charter's list ([v1 charter](v1-charter.md#release-acceptance), item 4),
   checked off on the release's acceptance issue. Update is proven by the
   launcher's `live` update leg, not by hand (#1601). Start an
   `ai/orbit-launcher` pipeline by hand on `dev` with `RUN_LIVE=true` and four
   `ai/orbit` job IDs:
   - `ORBIT_TO_RECORD_IMAGE_JOB` and `ORBIT_TO_SIGN_EVIDENCE_JOB`: this
     preview's `record_image` and `sign_evidence` jobs.
   - `ORBIT_FIRST_RECORD_IMAGE_JOB` and `ORBIT_FIRST_SIGN_EVIDENCE_JOB`: the
     same two jobs of the release it updates from.

   Set all four: without the `FIRST` pair the "from" release is the launcher
   branch's own previous build. The `live` and `live-fedora` legs install the
   earlier release, seed a household, an item and a document, update to this
   preview, and fail naming anything that changed. Link the green pipeline on
   the acceptance issue. The upgrade matrix (#1647) will fold this into the
   promotion pipeline.
3. Update [the roadmap](roadmap.md) for the release: set each row's status
   and evidence to what the accepted code does, mark kept promises
   `delivered`, and add a row for any promise found anywhere new. A promise
   that will not be kept is marked `dropped` and removed from where it was
   made.
4. Merge `preview` into `main` with the merge request's Merge button.
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
- A `hotfix/*` branch starts from `main`, publishes and accepts a patch, is
  merged into `main` with the merge request's Merge button, promoted, and
  then merged back into `dev`. Its push, and the merge request into it, run a
  short gate (owner decision 48, #1636): the fast, policy, integration, image,
  image-scan, local-smoke and launcher jobs and, on the push, the publish
  jobs; both skip `smoke`, `smoke_webkit`, `smoke_webkit_mobile`,
  `rig_chromium`, `rig_firefox`, `rig_webkit`, `acceptance` and
  `repair_journeys`.
- No back-merge of `preview` into `dev` after an ordinary promotion: the
  `dev` -> `preview` merge commit carries no file changes, the next promotion
  merges cleanly without it, and each back-merge costs a full pipeline. Merge
  `preview` back into `dev` only when something landed on `preview` directly,
  as a hotfix does (owner, 2026-10-17).

Stable promotion needs `main`'s head to be the tested commit, or the merge
commit of it with an identical tree. Never squash or rebase a promotion merge
request: that makes a new commit nothing tested.

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
it. Delete one only if it is compromised. A deleted key blocks only the next
release's own predecessor pair, which then fails verification and needs an entry
in `scripts/ci/carry-accepted-gap` (see "Carrying the previous build's manifest"
below). A carried pair signed by it never blocks a push: it is judged only when a
rebuild picks it, and a new commit is never a rebuild. Nothing else reads
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
stops the job before anything is published. It verifies the predecessor's own
carried `previous/` pair too, but only records the verdict: that pair is judged
when it is used (see the rebuild entry below). The second call, with the pushed
digest, moves the staged pair into `previous/` in one rename. It is fail-loud
and idempotent: a missing or mismatched predecessor fails `record_image` with
a message naming the cause, and nothing is written under `previous/`.

The predecessor is the newest successful `record_image` job on the ref, found
from the project's job list, so a pipeline that ran no `record_image` (a
schedule, a run started by hand) never hides it. Its manifest comes from that
job and its signature from the `sign_evidence` job of the same pipeline, both
by job id, so the two always belong to one build. A build whose signing finally
failed (its newest `sign_evidence` job failed, was canceled or skipped) is never
signed and so not a release: the carry skips it and carries the build before it,
the `previous/` pair of that job, fetched by its job id and verified. On a
rebuild of the digest being pushed, the predecessor's own `previous/` pair is
carried instead.

`record_image` and `sign_evidence` keep their artifacts for ever
(`expire_in: never`, a few KB per release), so the next release can always
read them. A stuck preview or hotfix release recovers by an ordinary push, a
job retry or waiting, never by a hand-started pipeline or a CI variable.

A ref's first release is recognised automatically: when the whole job list
holds no successful `record_image` job on the ref, the carry logs `first
release, nothing carried`, saves nothing and passes. No variable or setting is
needed. A job list too long to search (the page cap is reached with no match)
fails instead, and is never read as a first release. The same holds when the
newest `record_image` job was never signed (its `sign_evidence` failed, was
canceled or skipped): the carry takes the build before it, and reads it as a
first release only if that job has no `previous/` pair and its own manifest is
still there. If its manifest is gone too, that is a missing build, not a first
release.

When it fails, the message names the cause:

- The predecessor's pipeline has a `sign_evidence` job (the newest one counts)
  that is still running, pending or otherwise in flight: the carry polls
  every 30 seconds (`ORBIT_CARRY_POLL_SECONDS`, a whole number of seconds from 0
  to 60; anything else fails the job naming the variable) for 20 polls, then
  fails saying it is still running. Wait for that job to finish, then run the failed
  job again.
- The newest `sign_evidence` job of the predecessor's pipeline failed, was
  canceled or was skipped: this is not a failure. That `record_image` job was
  never signed, so it is not a release, and the carry logs `record_image job N
  was never signed (sign_evidence <status>): not a release, carrying the build
  before it` and carries job N's own `previous/` pair in its place, verified like
  any predecessor pair. If job N has no `previous/` pair and its own manifest is
  still there, nothing before it was ever signed and the carry logs a first
  release, carrying nothing; if its own manifest is gone too, the carry treats
  it as a missing build, as below. A line in
  `carry-accepted-gap` for job N excuses the pair that stands in for it, never
  an API error or a `sign_evidence` job still in flight (which is waited for).
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
  never excuses the carried `previous/` pair (it is not needed: that pair is
  judged only on a rebuild, and a push escapes it), a tooling failure (see
  below), an API error or a missing `sign_evidence` job. A line for another job or ref is logged as stale and
  ignored, and a malformed line fails the job naming it. Remove the entry once
  the next release on the ref has landed. The owner may also press Keep on the
  artifacts of the one predecessor built before this change, which makes the
  entry unnecessary.
- HTTP 401 or 403 on an API call: check that the job token's allowlist
  includes this project with read jobs.
- A transport error (a curl exit other than 0 and the size cap's own 63) or an
  HTTP 408, 429 or 5xx on an API call: the carry makes at most 3 attempts,
  `ORBIT_CARRY_RETRY_SECONDS` apart (a whole number of seconds from 0 to 30,
  default 2; anything else fails the job naming the variable). Each attempt
  reads into a fresh buffer, never curl's own `--retry`, so a failed attempt's
  body can never be mixed into the next answer, and only the last attempt's body
  and status are used. When the attempts run out, the message names the status
  or curl exit, the URL and `after 3 attempts`. Run the job again once the API
  answers.
- Any other HTTP status (a redirect, or a 404 on a job list) or a job list that
  is not JSON: never retried, the carry fails at once naming the status and
  URL. The carry could not ask, which is not the same as nothing being there.
- An empty signature file (the predecessor's) fails as its own error before the
  verifier runs, naming the file. It is never a verdict, so no
  `carry-accepted-gap` line excuses it. An empty carried signature is a bad
  carried pair (see the rebuild entry below).
- A job list page whose `X-Page` is missing or is not the page asked for, or
  whose `X-Total-Pages` is greater than `X-Page` with no `X-Next-Page`: the
  carry fails saying `pagination headers missing, so the end of the list cannot
  be known: not a first release`. A dropped header is never read as the end of
  the list. Run the job again.
- An answer larger than the limit (1 MiB for an artifact, 16 MiB for a job
  list page): the carry reads at most limit + 1 bytes, whether or not the server
  declared a length, and fails naming the URL and the limit.
- The manifest and signature verify against neither `cosign.pub` nor any key in
  `cosign-retired/` (the message names every file tried), or a manifest has no
  readable image digest: the predecessor's artifacts are bad and need the owner;
  the recovery is the `scripts/ci/carry-accepted-gap` entry above, for a
  verification failure of the predecessor's own pair (or of the pair standing in
  for a never-signed one). The same failure on the predecessor's carried
  `previous/` pair never fails a push: it is only recorded.
- A tooling failure, which the message says is "not a verdict" and which names
  the tool: `cosign` could not be downloaded (`scripts/ci/ensure-cosign.sh`
  failed), `cosign` exited with a status other than 0 or 1 (for example 2, or
  127 for a missing command), `openssl` or `base64` is not installed, or the
  verifier failed before `cosign` ran (a full `TMPDIR`: its `mktemp` fails). Only a
  verifier that ran and rejected the signature counts as "does not verify";
  a tool that could not run says nothing about the signature, so no gap line
  excuses it. Fix the tool and run the job again.
- A re-run of an already-published digest whose build carried no `previous/`
  pair fails after the push.
- A rebuild (a retry of `record_image` for an already recorded commit) picks the
  predecessor's carried `previous/` pair, and that pair is bad (it does not
  verify, a half pair, a malformed digest or an empty signature): the job fails
  after the push, naming the cause and saying `push a new commit; a retry of this
  commit cannot carry`. A new commit is never a rebuild, so an ordinary push
  recovers; no gap line is needed or honoured.

## Upgrade matrix

The matrix jobs exist (#1665): `upgrade_cell` (one job per slot and shape, 15
cells, three slots at a time) and `upgrade_cell_launcher`. They start only on
a push to `preview` and on `hotfix/*` pushes (owner decision 43a), in the
`acceptance` stage, after `classify` and `build_image`. `classify` fetches the
tags and adds the `ORBIT_UPGRADE_*` keys to its dotenv file. The launcher job
reports a skip until the launcher cell (#1666, blocked on
ai/orbit-launcher#331) is built. The decision is ADR-0040.

The matrix checks that an existing install can be updated to the candidate. It
runs once per train: on a push to `preview` and on `hotfix/*` pushes. It never
runs on a merge request, a schedule or `main`.

Each cell is one old release times one configuration shape. The old releases
are the last three stable tags (`UPGRADE_FROM_COUNT`, in
`scripts/ci/upgrade-versions.mjs`). The shapes are plain, mail, secrets-file,
oidc and all-keys. A cell installs the old release fresh, seeds one item and
one document, updates with the candidate's `scripts/install.sh`, then checks
that the update was accepted, that the running image is the candidate, that the
shape survived and that the item and document still read back. One more job
updates the plain shape through the launcher and has a longer budget (about 12
minutes).

### When a cell fails

A failing cell turns the preview (or hotfix) pipeline red. It does not yet stop
the image being recorded: `record_image` waits on the cells only once that
change lands (#1665). Its last log line says what failed:

```text
upgrade-cell FAIL version=v0.3.4 shape=mail step=update assertion=preflight-accepted detail="..."
```

Read the version, the shape, the step (`install`, `seed`, `shape`, `update` or
`assert`) and the assertion. The same line is in the cell's
`upgrade-cells/<slot>-<shape>.line` artefact and is the JUnit failure message.
To reproduce, run `scripts/ci/upgrade-cell.sh` with the environment shown in
the job (`SLOT`, `SHAPE` and the `ORBIT_UPGRADE_*` values from `classify.env`).
A failure is an update that real operators would hit, so fix the candidate; do
not rerun until it passes.

### When it skips

A cell prints a `SKIP` line and exits 0 when nothing install-relevant changed
since the newest stable tag, or when its version slot is empty. If the diff
cannot be read, the matrix runs.

### The release list

The release manifest carries two fields, `updateFrom` (the last three stable
releases) and `releases` (all stable releases), newest first. They are written
from the same `stableReleases()` list the matrix uses (#1667), and the
installer refuses an update from further back than `updateFrom` and names the
release to update to first. Retracted tags are in neither list. `record_image`
needs the tags fetched to write them. `promote_stable` downloads the signed
manifest of the build it promotes (the newest `record_image` copy on the tested
branch, which must name the promoted digest) and refuses when its `updateFrom`
is no longer the newest three stable tags, or when the manifest cannot be had.
`ORBIT_PROMOTE_SKIP_UPDATE_PATH=1` skips the check for local runs and tests
only; CI never sets it.

## Stable promotion (on GitLab)

Promotion is a manual GitLab CI job, `promote_stable` in `.gitlab-ci.yml`. It
only appears, as a manual step, on a pipeline running on `main`: the push to
`main` (which starts nothing else, #1546) or one you start yourself on `main`.
A pipeline on any other branch has no such
job, and `promote-stable.sh` refuses to run off `main` as well (#1564), so
only someone who can press a manual job on protected `main` can promote.
Nothing runs it automatically: accepting a release is a human decision.

It needs no input (#1482). The digest it promotes is the one GHCR's
`:sha-<tested commit>` tag names. The tested commit is `main`'s head, or, when
`main`'s head is the Merge button's merge commit with the same files as the
commit merged in, that merged-in commit (#1640). Pressing the button on the
pipeline for `main`'s head is the acceptance; the checks below hold the digest
to the same standard a typed one meets.

An optional `PREVIEW_DIGEST` job variable (`sha256:<64 hex>`) still
overrides that, for a re-run against a digest you name: it must then equal
both tags as well. The job log says which route chose the digest, and prints
it.

To run it:

1. Deploy the accepted preview digest and complete release acceptance.
2. Merge the `preview` -> `main` merge request once acceptance is done.
3. Open the pipeline that merge started on `main`
   (the project's pipelines page on the GitLab host, filtered to `main`), find the
   `promote_stable` job and click Run.


The job (`scripts/ci/promote-stable.sh`) then does the following, in order:

1. If `PREVIEW_DIGEST` is given, checks it is `sha256:<64 hex>`.
2. Finds the tested commit: `main`'s head if GHCR has `:sha-<main HEAD>`.
   Otherwise `main`'s head must be a two-parent merge commit whose second
   parent has a `:sha-` tag and whose files (tree) are identical to
   `main`'s; that parent is then the tested commit. Anything else, such as a
   squash, a rebase, an octopus merge or a merge that changed files, is
   refused.
3. Resolves GHCR's `:preview` tag and `:sha-<tested commit>` tag. With no
   `PREVIEW_DIGEST`, the `:sha-<tested commit>` digest is the one promoted,
   and the job refuses if that tag does not exist, or if the pipeline you
   pressed it in is not for main's current commit. It then confirms both
   tags equal the digest. It refuses if `preview` has moved on, or the
   digest never reached the tested commit.
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
10. Creates the annotated tag `vX.Y.Z` on the tested commit through the API.
    Its message ends with a `Tested on: <branch>` line naming the image's
    source branch (`preview` or the `hotfix/*` branch).

GitLab's push mirror carries the new tag to GitHub within minutes.
`.github/workflows/release-on-tag.yml` there watches for `v*` tags and runs
`gh release create --verify-tag --generate-notes`, so the GitHub Releases page
keeps working for the public. GitHub makes no decision of its own: if a
release for that tag already exists, it does nothing. The workflow reads the
`Tested on:` line to find the pipeline whose launcher, manifest and signature
it attaches, so a hotfix release gets its files without anyone fetching them
by hand (#1640). A tag made before that line existed falls back to searching
the mirrored branches.

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
#    one needs read access to the GitLab registry's ai/orbit image.
cosign verify-attestation --key cosign.pub \
  --type https://tomlawson.io/attestations/orbit-validation/v1 \
  --insecure-ignore-tlog=true \
  <gitlab-registry>/ai/orbit@sha256:...
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
