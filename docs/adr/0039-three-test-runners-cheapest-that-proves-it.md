# ADR-0039: Three test runners, and every check lives in the cheapest one that proves it

**Status:** Proposed (round 1 with the owner, #1517)
**Date:** 2026-11-01
**Amends:** `docs/quality-strategy.md` "Test layers"; the interim "Browsers"
rule in `AGENTS.md` (2026-10-25)
**Relates to:** #1517 (testing review), #1546 (promotion CI time), #1413,
#1414, #949 (closed into #1517), #1357 (contract fixtures), #1416 (flakes)

## Context

Testing costs more than the work it checks (owner, 2026-10-25): since
2026-10-11 `dev` took 228 test commits against 19 feature commits, and a
browser run holds the stack alone, so runs queue behind each other.

Measured at dev c42461c6 (2026-11-01; pipeline job durations from the API,
nightly 3302):

- Browser jobs: `smoke_webkit` 38 min, `smoke` 28, `fidelity_webkit` 28,
  `smoke_firefox` 26, `fidelity` 20, `smoke_webkit_mobile` 15. About 2 h 35 min
  of job time, two at a time on the one Docker runner.
- Merge-request pipeline: `fast` 12 min, `integration` 10–12 min; every other
  job under 6.
- `tests/e2e`: 61 files, 291 tests, each run on up to five browser/device
  projects against the full stack (app, Postgres, sign-in provider, mail,
  ClamAV, Tika), one instance and one database, two workers behind a reset
  gate (#1080). Read file by file, the lowest layer that proves each test is:
  **34 need the stack**, 204 need only a browser, 43 need only the database
  or the API, 10 need neither.
- `web/tests/fidelity`: 30 files, 741 runs (508 are the 44 px tap-floor
  measurement). They already run without the stack: the built web app with
  `ORBIT_FIXTURES=1` answers its own API from fixtures (#451), on a runner with
  no Docker. 66 runs need no browser at all; only `screens.spec.js` compares
  pixels.
- Vitest already mounts Svelte pages in happy-dom with a fetch mock in about
  twenty unit files.

So most browser time is spent proving, against the full stack and five
browsers, things that a browser with fixture answers, or no browser, proves
the same. The standard shape is the test pyramid — many small tests, fewer
medium, few large (*Software Engineering at Google*, ch. 11, test sizes) —
with selection by what changed (Vitest `--changed`, Playwright
`--only-changed`) and parallel workers where tests share no state
(Playwright's isolation guidance).

## Decision

1. **Three runners, and no fourth.**
   - **Vitest** (node, or happy-dom for page markup and behaviour modules; the
     `integration` project adds real Postgres). No browser.
   - **The rig**: Playwright against the built web app with `ORBIT_FIXTURES=1`.
     A real browser, no Docker, no database, no sign-in provider. Today's
     `web/tests/fidelity` runner, widened to carry journeys.
   - **The stack**: Playwright against the full Compose stack
     (`scripts/test-frontend.sh`). Only for what nothing cheaper can prove.
   A component harness (Vitest browser mode, Playwright component testing)
   is declined: it would be a fourth runner for forty tests the rig already
   covers.

2. **A check lives in the cheapest runner that proves it.** The rule, applied
   when a test is written and when one is moved:

   | It proves | Runner |
   |---|---|
   | Logic, dates, reducers, wording, which controls a page shows, aria names in markup | Vitest default |
   | Status codes, sessions, 401/303/503 boundaries, schema, authorisation, limits | Vitest integration |
   | Real focus and keyboard, screen-reader readback via the browser's tree, axe, layout, scroll, motion, pixels, the tour | the rig |
   | Real sign-in and cookies, uploads and the document pipeline (Tika, ClamAV), mail in and out, archive import and export, invitations and membership, the bootstrap claim, the maintenance window end to end, runtime properties of the image | the stack |

   The rig is only trustworthy if its fixtures match the engine, so #1357
   (every canned answer parses with the engine's schema) is part of this
   decision and lands before journeys move onto the rig.

3. **The suites are repartitioned once, file by file**, using the survey on
   #1517 as the starting list, not as the verdict: the mover reads each test.
   Journeys that leave the stack go to `web/tests/rig/` (one folder beside
   `fidelity/`, same config and projects); unit-shaped tests to `tests/unit`;
   API-shaped ones to `tests/integration`, filling the two known gaps (second
   factor, archive busy). A moved test is rewritten once for its new layer,
   not ported assertion by assertion, and one whose assertion already exists
   in a lower layer is deleted and named in the commit.

4. **Browsers by runner, not by habit.** The rig runs on Chromium desktop and
   phone at every run, and on Firefox and WebKit (desktop and phone) at
   promotion and nightly. The stack runs on Chromium desktop and phone, plus a
   WebKit sliver of the sign-in journeys (entry, local sign-in, first-run
   door), because cookie and redirect behaviour differs by browser and the
   rest of the stack journeys are server behaviour that does not.

5. **Parallelism comes from the rig, not from isolating the stack.** The rig
   shares no state, so it runs `fullyParallel` with as many workers as its
   runner's CPUs allow (measured, not assumed). The stack suite keeps two
   workers and the reset gate; #949's per-spec isolation is not built, because
   the suite shrinks to what cannot be unshared anyway (the instance-wide
   roster, the maintenance window, the upload limit). Locally a rig run holds
   no stack, so several can run at once.

6. **Run what the change can affect, prove everything at promotion.**
   - Merge request: `vitest run --changed <merge base>` for the default and
     integration projects, without coverage; lint and type check as now.
   - Push to `dev`: the full Vitest run with the coverage ratchet, so a merge
     still cannot lower a floor.
   - Promotion and nightly: everything, every browser, as now (#1412).
   - No per-screen selection for the browser jobs (#1413 closes): at
     promotion the full run is the point, and on a merge request the rig is
     cheap enough to run whole.

7. **How much proof a change needs** (replaces the interim rule of
   2026-10-25, which it keeps in substance):
   - A change under `web/` runs the rig suite locally, whole, on
     `desktop-chromium`, plus the phone project when the change is phone work;
     WebKit-specific work runs on the WebKit project too.
   - The stack suite runs locally only when the change touches sign-in,
     uploads and documents, mail, archive or the server; then the touched
     specs, not the suite.
   - Proof that a test is stable is `--repeat-each=3` on the one project that
     flaked. The full matrix is for promotion.

## Consequences

- The stack jobs shrink from 291 tests on five projects to about 34 on two
  (plus the WebKit sliver); the rig grows by about 200 journeys but runs with
  workers on the no-Docker runners. Measured after the first batch moves; the
  numbers above are counts, not timings.
- #1546's remaining plan (shard the stack suites) is reconsidered after the
  move: sharding spends more runner time on the same tests, and the move may
  make it unnecessary.
- A wiring fault between the real server and the client is caught at
  promotion or nightly, not on the rig. #1357 narrows that gap to behaviour
  the fixtures cannot express.
- Writing a test gets cheaper: a happy-dom or rig test needs no stack, so the
  228-to-19 ratio falls on the writing side as well as in CI.

## Alternatives considered

- **Shard the stack suites only** (#1546 as planned): same tests, more
  runners; does not touch the local cost or the writing cost.
- **Isolate the stack per spec** (#949): instance-wide state cannot be
  unshared without an instance per worker; expensive for a suite that should
  be small.
- **A component harness**: a fourth runner; declined above.

## Build work (filed as issues once this is accepted)

#1357 first; then the move in batches, largest files first (`v19-create`,
`v19-home-drawer`, `v19-keyboard`, `v19-keyboard-pocket`, `v19-screen-reader`,
`signed-out`, `maintenance`, `v19-explore-search`, `v19-axe-sweep`); the rig
projects and CI jobs; `vitest --changed` on merge requests (#1414); the
browser matrix; `docs/quality-strategy.md` and `AGENTS.md` updated;
`scripts/test-frontend.sh` split. #1358–#1361 (shared helpers) run after the
move, on what is left in each suite.
