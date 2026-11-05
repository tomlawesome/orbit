# ADR-0042: A delivery push stands on trusted passes of the same work; only what changed runs again

**Status:** Proposed (owner direction on #1546, 2026-11-04: "if the passed
tests are being reused from a preview run, where any element that has a code
change can't be reused, but any element that doesn't can")
and owner decisions 64a (`promotion_readiness` blocks the dev -> preview
merge request) and 65a (reused evidence counts for seven days), 2026-11-04
**Date:** 2026-11-04
**Supersedes:** ADR-0028 section 2's last rule ("delivery branches still
never consume evidence; they record it") and section 3's "the delivery
branch is the guard"
**Amends:** ADR-0020 (the attestation predicate also names the runs that did
the work); ADR-0028 section 3 (how a human forces a rerun)
**Relates to:** #1546 (promotion CI time), #1692 (`rig_webkit` split), #1412
(browsers at promotion and nightly), #1362 (one branch table), #1615
(the rig jobs), ADR-0039 (three test runners), `docs/quality-strategy.md`
"Standing on an earlier run"

## Context

The v0.3.6 release took three promotion rounds on 2026-11-04. Each `preview`
push ran every job from scratch, about 45 minutes with a quiet runner, for an
image that had not changed between rounds. The third round would have stood
on `fast`, `integration`, `rig_chromium` and `rig_firefox` from pipeline
3546, which passed on the same image, and run only what the fix touched.

ADR-0028 built the key that makes this safe -- the artefact under test, the
checkout minus a proven deny-list, and since the 2026-10-29 amendment the
job's own definition and scripts -- but spent it only on merge requests. Its
reason was trust, not the key: an MR pipeline runs the branch's own CI file,
so the branch could emit any key and any evidence it liked, and the delivery
push was the guard that caught a forged or flaky pass. That guard costs a
full run per round.

Two more findings from the same day: the nightly schedule (pipeline 3504,
on a `dev` head that predated #1615) ran no rig job, so `rig_webkit` first
ran a full suite at promotion and had never passed one; and `rig_webkit`
does not fit its 45-minute limit, the rig suite and the phone film being
about 22 minutes each on a loaded runner (#1692).

## Decision

The standard pattern is a **content-addressed action cache with a trust
boundary on who may write to it**: Bazel's remote action cache (the key is
the hash of the action's inputs, command and environment; the value is its
result; developers read the cache, only trusted CI writes it, because a
poisoned entry is indistinguishable from a good one) and Nix's binary caches
(a store path is substituted only from a cache whose signing key the
consumer trusts). Orbit's key is ADR-0028's composite key, the "result" is
"this job passed", and the trust boundary is GitLab's branch protection.
Departures, each with its reason, are listed in section 7.

### 1. Whose evidence counts

Confirmed: **only passes recorded by a pipeline on a protected branch**.

- Trusted refs are `dev` and `preview`, for every consumer. A `hotfix/*`
  pipeline's evidence counts only for pipelines on the same hotfix branch:
  a hotfix tree diverges from `dev`, so cross-use would seldom match, and
  the rule keeps the set everyone trusts to the two branches whose
  protection the owner audits. `main` runs only `promote_stable` and has no
  candidate job.
- The reason stands as the caller stated it: an MR pipeline runs the merge
  request's own `.gitlab-ci.yml` and `scripts/ci/**`, so a branch can write
  a "passed" evidence file for any key without running anything. A
  protected-branch pipeline runs only code that was merged through review.
- The ref is the one the GitLab API reports for the pipeline, never a field
  in the evidence file. The rule applies to **the job that really did the
  work**, found by following `stands_on` to the end of the chain, not to the
  proxy that stood on it; the real job must also be `success` (or a
  quarantine-only failure, exit 3) and within the age limit.
- Who consumes: every protected-branch pipeline -- the `preview` push, a
  `hotfix/*` push, a `dev` push, the nightly schedule on `dev`, and a
  pipeline started by hand on any of them -- and the promotion merge
  request (`dev` -> `preview`), because its job is to predict the push.
  Ordinary merge-request pipelines keep ADR-0028's economy unchanged: they
  read evidence from any ref.
- The lookup walks the recent pipelines of each trusted ref (`?ref=dev`,
  `?ref=preview`, and the current `hotfix/*` branch), not the project's
  last twenty on any ref, so a busy day of merge requests cannot push last
  night's evidence out of reach.

### 2. What the key must cover

ADR-0028's three axes already cover every input the job reads from the
repository: the artefact (image content ID, stamp excluded), the checkout
minus the job's deny-list, and the job's own definition (its YAML block and
anchors, the global `variables` block -- which holds every pinned runner
image -- the `scripts/ci/**` it names, and the reuse machinery). No axis is
added and the key version does not move, so evidence recorded before this
change stays readable; the machinery change itself moves every key once,
as the amendment rule intends.

Two jobs have an input outside the key and are **never reused on a
protected-branch pipeline**, marked `alwaysRunsOnDelivery` in
`job-inputs.json` with the reason beside the mark:

- `supply_chain_image`: the Trivy database moves daily. ADR-0028 let a merge
  request stand on a scan up to seven days old because `dev` rescanned; the
  rescan now has to be the delivery push itself (about two minutes).
- `smoke_local_only`: the image's stamp (version, revision, channel) is
  excluded from the content ID, so a `dev`-built and a `preview`-built
  image share a key while their stamps differ. `build_image` verifies the
  stamp on every build (`verify-image-identity.sh`), but the runtime
  reading of it -- `verify-startup-banner.sh` -- lives in the three stack
  smoke jobs that now reuse. It moves into `smoke_local_only` too, which
  already stands the stack up on every `preview` and `hotfix/*` push
  (about three minutes) and runs the non-root and privacy-boundary checks.
  One always-run stack job per push carries the three runtime checks.

### 3. Freshness

Seven days, measured from the finish time of the job that really ran, the
same number ADR-0020 puts on the attestation at publication and the same
knob (`ORBIT_MAX_EVIDENCE_AGE_DAYS`, default 7) so the owner can shorten the
release gate without a code change. One number: a pass of the same bytes is
no less a pass on day six, and the only thing age guards against is flakiness,
which the nightly re-exposes whenever the tree under a job's key moves.

### 4. What `record_image` and `sign_evidence` sign

The release record names the run that did the work for every gating job.

- `record_image` collects, through the API with the read-only token the
  lookup uses, the `ci-evidence/<job>.json` of every reuse-candidate job it
  needs that is present in this pipeline, follows `stands_on` to the real
  run and re-applies section 1's checks to it (protected ref, success, age).
  A gating candidate with no evidence file, or whose real run fails a check,
  fails `record_image` before anything is pushed: "did not really run" must
  not read as "ran and passed", which until now was only true for merge
  requests.
- The result is an `evidence` list -- one entry per job: name, key, the real
  job id, its pipeline id and ref, its finish time, and whether this
  pipeline stood on it -- written into `gitlab-tested-image.json` (the
  transport record that never expires) and restated, shape-validated as the
  digest is, into the attestation predicate `sign_evidence` mints. The
  predicate's existing fields are unchanged; the verifier reads named fields
  and ignores others, so old attestations still verify and `promote_stable`
  is unaffected. The release manifest (ADR-0031) is untouched: which run
  validated the image is a validation fact, which ADR-0020 places in the
  attestation, not a release-content fact the launcher consumes.

### 5. Forcing a full run

- A pushed commit whose message carries the trailer `CI-Reuse: off` (the
  promotion's merge commit message is editable in the merge dialog; a
  direct push can also pass `-o ci.variable="ORBIT_REUSE=off"`) runs every
  job. Only the safe direction is reachable this way, so the message needs
  no more trust than it has.
- `ORBIT_REUSE=off` on a pipeline started by hand, and the `ci: rerun`
  label on a merge request, work as before.
- "Retry" on a reused job still reuses; the routes above are the way.

### 6. Failures before release day

- **The nightly runs the rig.** Already so on `dev` since bc8d8452
  (2026-11-03) and on the v037 branch: `.rig_rules` opens on
  `*nightly_browsers`; pipeline 3504 ran on an older head. The decision
  confirms it and pins it with a test: every job `record_image` needs that
  is a reuse candidate runs in the nightly, so the nightly is the
  promotion's dress rehearsal and, through section 1, its evidence.
- **Opening a promotion requires trusted evidence for every gating job at
  the merge request's tree.** A `promotion_readiness` job in the
  `dev` -> `preview` merge-request pipeline reads the verdicts `classify`
  and `build_image` already took (in trusted mode, section 1) and fails
  when any candidate job not marked `alwaysRunsOnDelivery` has no trusted
  pass to stand on, printing one line per job: "stands on job N, pipeline
  P, ref R, age" or "no trusted pass: run the browsers on dev first". With
  "Pipelines must succeed" on, the merge waits. The ordinary way to satisfy
  it is last night's green run; the fast way is a pipeline started by hand
  on `dev`, whose rules run the browsers. Under semi-linear merging the
  merge commit's tree is `dev`'s tree, so the prediction holds for the
  push. A green nightly is therefore not a separate requirement: it is how
  the evidence usually gets there.
- A `preview` push then runs `build_image`, `build_launcher`, the two
  always-run jobs, the publish lane, and whatever the readiness job could
  not find: ordinarily 15 to 20 minutes against 45 or more.

### 7. `rig_webkit` splits in two

- `rig_webkit` keeps the rig projects (`rig-webkit-desktop`,
  `rig-webkit-phone`, `pnpm rig:webkit`); a new `film_webkit` runs the phone
  film (`pocket-webkit`, `pnpm fidelity:webkit`), one worker, as the
  retired `fidelity_webkit` did. Each runs its own quarantine pass, writes
  its own evidence under its own key, has `timeout: 35m` (22 measured, so
  about 13 minutes of headroom; #1546 found 6 to 9 too thin), and gates
  `record_image` (optional on hotfix, as the rig is). The film is not a rig
  job in ADR-0039's sense, so it is named for what it is.
- No further sharding and **no `resource_group`** on either. The rig jobs
  run on `light` (4 jobs at once, 6 CPUs and 6 GB each); with the split the
  three browsers' four jobs fill those slots exactly, and `--shard` would add
  jobs that queue for a slot and each pay the install and sync again. The
  film is pinned to one worker because its timing fails beside parallel
  workers, so it cannot shard. Cross-pipeline contention is already handled
  by the nightly yielding to a promotion and by section 1 (a reused rig job
  holds a slot for seconds); `scripts/gitlab-ci-lanes.test.mjs` already
  asserts the rig jobs carry no `resource_group`, and that stays. The
  `heavy-*` groups on the stack jobs are unchanged: a reused stack job
  enters its group and its `orbit-build` slot for about a minute (image
  pull, helpers, gate), which is accepted; the verdict cannot be known at
  pipeline creation, since the keys are computed in `classify`.

### 8. Where this departs from the pattern

- The cached value is a verdict, not an output. A build cache replays the
  artefact; here the artefact (`image.tar`) is always rebuilt (ADR-0028:
  `build_image` never skips) and only the test result is reused. Reason:
  publication needs the bytes on hand, and the registry layer cache makes
  the rebuild cheap.
- The trust boundary is the ref's protection, read from the API, rather
  than a signature over each cache entry. Reason: GitLab already enforces
  who can write to `dev` and `preview`; a signing step would protect the
  evidence file against a party that can already forge the pipeline.
- Entries expire after seven days. Content-addressed caches do not expire
  by time. Reason: tests are not pure functions of their inputs -- flakes,
  and the scanner's moving database -- so the window bounds how long a
  wrong verdict can live.
- The store is the job's own artefact and a walk of recent pipelines, not
  an index. Reason: unchanged from ADR-0028 section 2; revisit if the
  per-ref walk grows slow.

## Consequences

- The delivery push stops being the guard against a flaky pass. What
  replaces it: the pass must come from a protected pipeline, be under
  seven days old, and be named in the signed record; and the nightly runs
  the full set for real whenever the tree under a job's key moved. A flake
  that passed once on `dev` can now reach `preview` without running again.
  Accepted: it would have been equally likely to pass again, and the
  record says which run it was.
- The reuse machinery is in every key, so the pipeline after this lands
  reruns everything once. Land it, let a nightly run, then promote.
- `record_image` gains a hard check it lacked: every gating candidate must
  prove it ran. A pipeline where a candidate skipped itself fails at
  `record_image` with the job named, instead of publishing.
- `.gitlab-ci.yml`'s `.reuse_gate` comment, `docs/quality-strategy.md`
  "Standing on an earlier run", and the "Browsers run at promotion and
  every night" section change to say so; the `promotion_readiness` line
  joins `docs/releasing.md`'s promotion steps.

## Alternatives considered

- **Keep the delivery push as the guard and only shard** (ADR-0028 as is).
  Rejected by the owner's direction: the rounds, not the jobs, were the
  cost, and sharding shortens each round without removing it.
- **Trust merge-request evidence too, with a signed evidence file.**
  Rejected: the signing key would have to be available to the MR pipeline
  that could forge the key it signs.
- **Require a green nightly at the same `dev` head to open a promotion.**
  Rejected as the rule, adopted as the usual means: a release-day fix
  would wait a night; the readiness job asks for the evidence, however it
  got there.
- **Decide reuse at pipeline creation through `rules:`** so a reused stack
  job never takes a slot. Rejected: the keys need the checkout and the
  content ID, which exist only inside the pipeline.
- **Shard `rig_webkit` by `--shard=i/n`.** Rejected for now: `light` has
  four slots, the split already fills them, and the film cannot shard.

## Risks

- A protected-branch pipeline started by hand on `dev` by any Developer
  writes trusted evidence. That is the same trust `dev`'s push pipeline
  already carries; the hand-started pipeline runs `dev`'s own committed
  CI. Noted, not mitigated.
- `CI_COMMIT_MESSAGE` as a switch is new here; it can only add work.
- The attestation predicate grows. `verify-validation-evidence.sh` must
  keep verifying attestations minted before this change; the spec tests it.
