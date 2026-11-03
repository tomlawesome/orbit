# ADR-0040: The upgrade matrix installs the old version fresh in every cell, and covers exactly the releases the installer allows

**Status:** Accepted (owner answers 38a, 39a and 40a on #1647, 2026-11-03)
**Date:** 2026-11-03
**Relates to:** #1647 (upgrade matrix), #1661–#1666 (its parts), #1667
(installer refuses an update from more than three releases back), #1643 and
#1645 (the v0.3.4 refusal and its acceptance shapes), #1597 (no-change lane
logic), #1601 (launcher live leg), ADR-0019, ADR-0028, ADR-0031, ADR-0039;
ai/orbit-launcher#331

## Context

v0.3.4 refused the owner's own update because `.env-orbit` held `COMPOSE_FILE`
(#1643). No pipeline ran an update from an existing install. A fresh install
cannot find what only an upgrade breaks. The owner decided (2026-11-02) that
updates are tested against more than the previous version, once, at the big
promotion gate, and that long monolithic end-to-end runs are not acceptable
(#1412, #1546, #1636).

## Decision

1. **Build once, fan out by artefact.** The candidate is built once
   (`build_image` gives `image.tar`; `build_launcher` gives the launcher
   archive). Each cell takes those artefacts. This is the "build once, deploy
   many" pattern.
2. **A fresh old-version install per cell, not a restored snapshot.** Each
   cell installs the old release with that release's own `install.sh` from its
   signed manifest, seeds one item and one document, then updates with the
   candidate's installer. This is an "ephemeral environment per test". The
   registry pull-through cache (old images, Postgres, ClamAV, Tika) is the only
   thing cells share. Nothing is shared on disk.
3. **A static `parallel:matrix`** over version slots (`latest-1` to
   `latest-N`) times configuration shapes (plain local accounts, mail overlay,
   secrets as `*_FILE` references, OIDC configured, a `.env-orbit` with every
   documented optional key). Slots are bound late: the tags are read when the
   pipeline runs.
4. **`resource_group` per version slot** caps concurrency on the shared host
   (owner answer 39a). Cells in one slot run one after another.
5. **The matrix covers exactly the last `UPGRADE_FROM_COUNT` (3) stable
   releases** (owner answer 40a). There is no oldest-minor slot. The installer
   refuses an update from further back and names the release to update to first
   (#1667), so every update path the installer allows is tested and none is
   left untested. The release list is published in the signed release
   manifest, the "supported upgrade paths in signed release metadata" pattern.
   The matrix and the refusal read it from one function, `stableReleases()`
   in `scripts/ci/upgrade-versions.mjs`, so they cannot disagree.
6. **Verdict line.** Each cell ends with one line, also written to
   `upgrade-cells/<slot>-<shape>.line` and used as the JUnit failure message:
   `upgrade-cell PASS|FAIL|SKIP version=… shape=…`. A FAIL also names the
   step (`install`, `seed`, `shape`, `update`, `assert`), the first failed
   assertion and one sanitised line of detail. It never holds a secret or the
   claim code.
7. **Skip rule, with a fail-safe.** The matrix runs on the `dev` to `preview`
   merge request and on `hotfix/*` pushes, never on merge requests into `dev`
   or on `main`. It is skipped only when the diff from the newest stable tag to
   `HEAD` is readable and touches none of the installer, configuration,
   compose, migration or install-engine paths. A diff that cannot be read
   (missing tag, shallow history, git error) runs the matrix (the #1597
   fail-safe).
8. **The launcher cell** is one extra job: the plain shape, updated through the
   launcher. The launcher is driven through a terminal, so it cannot meet the
   three-minute cell budget. It has its own budget of about 12 minutes (timeout
   15 minutes), the same verdict line (`shape=launcher`), and no headless flag
   (owner answer 38a). It waits for ai/orbit-launcher#331 in launcher v0.4.5
   and a bumped `launcher/pin.json`; until then the job is not in the
   pipeline.

## Why not a golden snapshot

A snapshot restored per cell looks cheaper, but it is not. The shape of an
install lives in the install (secrets files, overlay composition,
`.env-orbit` keys), not in the data. A snapshot still needs one install per
version to make it, and it is then a per-version artefact that has to be
carried and trusted. The fresh install costs about 60 to 80 seconds against the
cache. It is also the operator path we claim to test: assets come out of the
resolved image (ADR-0019). A fresh install is both cheaper and more faithful.

## Consequences

- With three slots and five shapes there are 15 cells of about three minutes
  each, plus the launcher cell.
- A failing cell blocks the promotion merge request like any other gate job.
- The number three appears once, as `UPGRADE_FROM_COUNT`. The one other place
  that repeats it is the slot list in the CI matrix, and a test fails when the
  two differ.
- Out of scope: browser tests, more than one shape per cell, downgrade tests.

## Risks

- **R1** The engine may refuse an update whose repository changes (ghcr to the
  loopback registry). Fallback: copy the old image into the loopback registry
  by digest and install both sides from it. The spike checks this first.
- **R2** ClamAV fetches its signatures on first start (bounded at 120
  seconds). If app readiness waits on it, the install step can exceed its
  budget. The spike measures it; the mitigation is the 8 minute job timeout,
  not a different shape.
- **R3** Host contention beside the browser jobs. `resource_group` caps it and
  cells are interruptible; `seconds=` in the PASS line shows where to tune.
- **R4** The seeded session may not survive the update. Readback logs in once
  more before it fails.
- **R5** Older `install.sh` versions differ. Only three releases back are
  used, so the difference is bounded.
- **R6** The OIDC shape proves that OIDC configuration survives the update,
  not OIDC sign-in, which needs a browser and is out of scope.
