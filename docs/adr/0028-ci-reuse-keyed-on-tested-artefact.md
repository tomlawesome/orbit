# ADR-0028: CI job reuse is keyed on the artefact under test, not on a guess at its inputs

**Status:** Accepted (owner, 2026-09-09: the web app is built once in
`fast` and handed to `fidelity`, with the image build compiling from source
under the layer cache rather than taking the artefact; evidence found on any
ref counts. Drafted the same day under the #923 rulings and the goal set in
#930. Accepted as ADR-0026 on `design/m11-reuse-adr`; renumbered 0028 when
brought onto `dev`, where 0026 had meanwhile gone to extraction. Text
otherwise unchanged)
**Date:** 2026-09-09
**Relates to:** #930 (this design); #923 (CI time audit and rulings); #898
(input-hash reuse, shipped); ADR-0020 (validation evidence binds digest and
policy); `docs/quality-strategy.md` "Standing on an earlier run"

## Context

The owner's goal: the full gate runs, and after a fix only the sections that
failed run again.

Today (#898) `classify` hashes the checkout filtered by hand-written globs in
`scripts/ci/job-inputs.json`, and a job stands on an earlier pass of the same
job on the same merge request with the same hash, proven by
`ci-evidence/<job>.json`, an artefact the job writes as its last line.

Two things stop this delivering the goal. `fast` is keyed on `**`, so it
always reruns. Every image-running job carries `@image`, a hand-written
guess at which files reach the image, and a guess errs both ways: too broad
costs a rerun; too narrow reuses a stale result, a correctness bug.

Two facts about the build, not stated in #930, constrain the answer:

1. **The image is stamped per commit.** The last `RUN` of the runner stage
   writes `/opt/orbit/VERSION`, `REVISION` and `CHANNEL` from build
   arguments, and the labels carry the same values. So the image digest and
   image ID differ on every commit even when nothing under test changed.
   "Same digest across commits" is only ever true today when `build_image`
   was skipped -- which is the glob decision under another name. A key on the
   image needs an identity that ignores the stamp.
2. **`build_image` has no layer cache** (audit finding 6a: no `CACHED` lines).
   Every build writes fresh layers with fresh timestamps, so two builds of
   identical source are byte-different.

Binding rulings: no new runner capacity; reuse over rebuild; no narrowing
on a `web/**` change; auto-cancel is interim only.

## Decision

A job stands on an earlier pass when the thing it tests is the same thing,
proven by content, and everything else it reads is unchanged, proven by
hashing the whole checkout minus only the paths proven to reach the job
through that artefact. The default is rerun; opting out needs proof.

### 1. What identifies "the same thing under test"

Three axes, combined into one key per job (a SHA-256 over their
concatenation):

- **Artefact axis.** For the six image-running jobs (`smoke`,
  `smoke_local_only`, `acceptance`, `repair_journeys`,
  `launcher_install_compat`, `supply_chain_image`) this is the *image content
  ID*: SHA-256 over the ordered layer content hashes (`RootFS.Layers` in
  `docker image inspect`, the hashes of the uncompressed filesystem layers)
  of the runner image, excluding the final stamp layer. Labels live in the
  image config, not in layers, so they do not count. `build_image` computes
  it after the build and hands it on in `build.env` as
  `ORBIT_IMAGE_CONTENT_ID`. For `fidelity` the artefact is the built site:
  the hash of the `web/build` artefact `fast` produces. For `fast`,
  `fast_docker` and `integration` the source is the thing under test and
  there is no separate artefact axis. (Decided 2026-09-23 on #1060, note
  22560: implemented as no artefact axis for `fidelity` either -- it keys on
  the whole checkout, like `fast`, `fast_docker` and `integration`, rather
  than hashing `web/build`. A deliberate simplification, not an oversight.)
- **Checkout axis.** The hash of the whole checkout minus that job's
  deny-list. `job-inputs.json` inverts: from "what the job reads" (an
  allow-list) to "what the job provably does not read from the checkout" (a
  deny-list). A path may be listed only when the job reaches it solely through
  its artefact or not at all. For the image-running jobs that is `src/**`,
  `web/**` less `web/tests/**`, `drizzle/**`, `docs/**` and `*.md`. Scripts,
  compose files, config and `tests/**` stay in: the jobs run them from the
  checkout. For `fast` the deny-list is `docs/**` less
  `docs/engine-events.md` and `docs/installer-guarantees.md`, `*.md`,
  `tests/e2e/**` less `tests/e2e/local-only-specs.txt`, `web/tests/**`,
  `supply-chain/**` and `.gitleaksignore` (corrected per slice 3 commit
  `c976efc7`: the ADR's original seven-entry list included three
  inadmissible entries -- `.github/**` is not denied at all, since eight
  `fast` suites read a file under it, and `docs/engine-events.md` and
  `tests/e2e/local-only-specs.txt` are each read by a named suite, so each
  is carved back out of its tree's denial. The admissibility rule in section
  6 outranks this example list).
- **Definition axis.** `.gitlab-ci.yml` and `scripts/ci/**`, as today, so a
  pipeline change (a pinned runner-image bump included) reruns everything.

**`build_image` always builds; it no longer skips.** It uses a BuildKit
registry layer cache (`--cache-from`/`--cache-to type=registry`, `mode=max`,
a cache repository in `registry.tomlawson.io`). BuildKit keys a `COPY` step
on the content of what it copies, not on timestamps, so identical content
yields the same layer bytes and therefore the same content ID whatever
commit stamped it. A cache miss (expired cache) produces a new layer with new
timestamps, a new content ID, and a rerun: the safe direction. The
Dockerfile changes so the stamp is the last layer and nothing that varies
per commit precedes a content layer: the early argument-validating `RUN`
moves down to the stamp, and `build_image` validates the arguments before
`docker build` (as `scripts/build-container.sh` already does) so the early
failure it bought (#435) is kept. The `ORBIT_IMAGE_REVISION` workaround in
`build.env` goes: the image always carries this commit's revision.

Reading of ruling 4 (build once): `fast` builds the web app once and hands
`web/build` to `fidelity`; the image keeps building it from source in its
`web-builder` stage, a cache hit whenever `web/**` is unchanged, so the
published image stays reproducible from the Dockerfile alone.

`sidecar_images` keeps its fixed input list: its inputs are the pins.

### 2. Where the evidence lives and how a later pipeline finds it

Evidence stays a job artefact, `ci-evidence/<job>.json`, written as the
job's last script line, now recording the composite key, the content ID, and
the pipeline and job ids. It lives with the job that did the work and
expires with it (14 days).

The lookup moves to where the fact is known. `classify` decides the
source-keyed jobs as today. `build_image`, once it has the content ID, runs
the same lookup for the image-running jobs and appends the verdicts to
`build.env`; each job's gate reads them as it reads `classify`'s today.

The search walks the project's recent pipelines on any ref, newest first,
capped at about twenty, not only this merge request's. The key names
content, so a pass on another branch, or on `dev`, against the same content
is the same evidence. A rebase that changes nothing under test keeps its
reuse, because no commit SHA is in the key; a new merge request whose first
push leaves the image unchanged stands on `dev`'s last full run. Delivery
branches (`dev`, `preview`, `main`, `hotfix/*`) still never consume evidence;
they record it. The reader confirms through the jobs API that the recorded
job is `success`, then reads the artefact; a missing or malformed artefact,
or any lookup failure, means run.

Rejected stores: the container registry (merge-request pipelines push no
image); a project-level index in the package registry (a second store to
clean up; revisit if the walk grows slow); a `pipelines?sha=` lookup (the
commit is the wrong identity).

### 3. A flaky pass is not reused forever; a human can force a rerun

- **Age.** Evidence from a job that finished more than seven days ago is not
  reused (`finished_at` from the API), matching ADR-0020's publication rule.
  Artefact expiry at 14 days is the backstop.
- **The delivery branch is the guard.** Delivery pipelines never reuse, so
  a flaky pass can at most carry one merge request to `dev`, where the full
  run catches it and the fix reruns for real. The age limit bounds how long
  a merge request can ride it.
- **Force.** The merge-request label `ci: rerun` (read from
  `CI_MERGE_REQUEST_LABELS`, as `ci: acceptance` is) disables the lookup;
  remove it afterwards or every push reruns everything. A pipeline started
  by hand takes `ORBIT_REUSE=off`. "Retry" on a reused job reuses again; the
  label is the route.
- **Definition-tied.** The definition axis is in every key, so changing the
  pipeline or the reuse scripts invalidates all evidence at once.

### 4. `fast` is split

Yes (audit 15a). `fast` -- `tsc`, `eslint`, `vitest` less the five suites
that need a Docker daemon, the web build and the pdf.js render check -- runs
on `big`. `fast_docker` runs those five suites on `orbit-build`. Both are
keyed by section 1, not `**`; `fast_docker`'s deny-list also drops `web/**`,
since it builds only the `vapid-generator` target. `.needs_gated` waits on
both. This frees 200--300 s of `orbit-build` slot time per pipeline.

### 5. Auto-cancel on job failure comes out

Kept until slice 3 lands and a measured fix push shows only the failed jobs
rerunning; then `workflow: auto_cancel: on_job_failure` is removed. A red
`fast` already stops the acceptance stage through `.needs_gated`, so
auto-cancel adds nothing there. It fires only when an acceptance job fails
mid-stage, and then cancels siblings whose passes are exactly the evidence
the fix push needs, so the fix pays for them again. `interruptible` on a new
push is untouched.

### 6. Why the key cannot go stale

- **Artefact axis.** The content ID is a hash of the bytes the tests run.
  Two different images share it only on a SHA-256 collision. Nothing
  predicts what reaches the image; the build tool and the hash report it.
  The excluded stamp is not under test; `verify-image-identity.sh` asserts
  it on every build, which now always happens.
- **Checkout axis.** The default is the whole checkout. Only a deny-list
  entry can narrow it, and an entry is admissible only for a path the job
  reaches through its artefact, which the artefact axis already covers. The
  direction of error is the safe one: a forgotten entry costs a rerun; a
  wrong entry is checkable by reading the job's script and the scripts it
  calls. Today a forgotten allow-list entry is silent staleness.
- **Definition axis.** The pipeline and the reuse scripts are in every key.
- **Residual inputs, named.** The base image and every sidecar are pinned by
  digest inside the checkout. The build fetches only what the frozen
  lockfile pins; a Dockerfile fetching unpinned content would be the one way
  the artefact axis could go stale, and is forbidden. The Trivy database
  moves daily: on a merge request `supply_chain_image` may stand on a scan
  up to seven days old; `dev` rescans on merge.
- **Proof before trust.** Slice 2 is accepted only when two builds of the
  same tree on different commits give the same content ID, and a one-file
  change under `src/` gives a different one.

## Consequences

- `@image` and the allow-list reading of `job-inputs.json` go; the
  `image.tar` fetch path in `reuse-gate.sh` goes with `build_image`'s skip.
- `build_image` holds a slot for about a minute on unchanged content where
  it skipped in ten seconds today; that buys reuse of every image job
  whenever the image is unchanged, whichever files the fix touched (686 s of
  `orbit-build` beyond `smoke` in pipeline 813).
- A `web/**` or `src/**` change that leaves the image bytes unchanged (a
  comment, a type, a test file) reuses every image job; one that changes
  them reruns all six, as ruling 26 requires.
- The registry cache needs a cache repository, a cleanup policy and BuildKit
  in the `.dind` job. The Dockerfile reorder is a `Cut: risk` change.

## Alternatives considered

- **Narrow the globs.** Rejected: narrowing is the stale direction (ruling
  26).
- **A derived context key** (the checkout filtered by `.dockerignore`) as a
  skip for `build_image`. Rejected for now: still an input-side key, and it
  saves about a minute over always building with a cache. Revisit if the
  cache proves unreliable.
- **Reproducible builds** (`SOURCE_DATE_EPOCH`, rewritten timestamps) so
  content IDs match even on a cache miss. Optional refinement.
- **Hash only the job's own YAML** for the definition axis. Rejected:
  anchors make the block boundary meaningless.

## Supersession

Refines the design shipped under #898; supersedes nothing. ADR-0020 is
untouched: publication still binds to the pushed digest.

## Implementation slices

1. **Split `fast`; `web/build` becomes an artefact** -- `fast` on `big`,
   `fast_docker` on `orbit-build`, `fidelity` takes the artefact.
2. **`build_image` always builds, with a registry cache and a content ID**
   -- stamp last in the Dockerfile, cache repository, `ORBIT_IMAGE_CONTENT_ID`
   in `build.env`, the proof in section 6 as the acceptance test.
3. **Reuse keys v2** -- deny-list `job-inputs.json`, composite keys, lookup
   in `build_image` for image jobs, project-wide walk, seven-day limit,
   `ci: rerun` and `ORBIT_REUSE=off`.
4. **Auto-cancel removed and measured** -- three pipeline links as closure
   evidence: a red acceptance job, the fix rerunning only it, a `src/`
   change rerunning all six.
5. **Docs** -- `docs/quality-strategy.md` and the pipelines section of
   `AGENTS.md`.
