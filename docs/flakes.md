# Flakes

A flake is a check that failed and passed again on unchanged code. One heading
per flake, one line per sighting: `date · commit · pipeline/job · symptom`.
The third sighting under a heading gets an issue, linked from the heading;
fixing the cause deletes the heading in the same commit.

## check-base-image-current.test.mjs "tells the reader to merge dev when dev already pins the tag's current digest"

- 2026-09-19 · 3e855e2 (+ #1052's uncommitted administration work, none of it near this script) · local `scripts/test-backend.sh` · timed out at the 5s default. The whole file passed on a rerun immediately after on the same code, taking 1.9s for this test and 7.5s for the file — so it is the wall-clock budget under a loaded host, not the script. Every test here spawns real `git` subprocesses against temporary repositories.

## document-lifecycle.test.ts:1335 "emits a bounded rejected lifecycle record when reconciliation finds an available document's ciphertext missing"

- 2026-09-09 · 11a68e8 (+ #911's uncommitted setup-mail work, none of it near documents) · local `pnpm test:integration` · the bounded reason came back `crypto_metadata_missing` where the test expects `storage_object_missing`. The same file passed on the run immediately before, on the same code, and the run's other 39 files were green both times — so reconciliation appears to reach the two missing-piece checks in a different order under load.
- 2026-09-10 · 257d263 (+ #961's uncommitted `modelExtraction` health work, none of it near reconciliation) · local `pnpm test:integration` · failed on one run and passed on the run before it on the same code, and two later runs on the branch point without the change were green here as well. Only the four `@node-rs/argon2` files failed on every run.

## v19-keyboard.spec.ts:432 "settings: reached via the account panel"

- 2026-09-08 · af13319 · local `scripts/test-e2e-local.sh`, kept stack, 10 repeat runs · failed 2 of 10. The settings sessions list renders one "sign out of <device>" button per session and is unbounded, so on a stack reused across runs (168 sessions by the tenth) `auditTabOrder`'s 60-stop cap is exhausted, and `readSessions()` resolving after `.cards` lets rows arrive after the visibility snapshot. Likely fix shape: the `.cand` exclusion the household test already uses.
- 2026-09-20 · c463c2f · pipeline 1335 / smoke (job 17734, !958, mockups and docs only — no `web/` change) · the same test, now at `:437`, desktop-chromium. Passed on the retried job 17753 on the same commit. Second sighting.

## repair_journeys: hostile-value-privacy-negatives, "could not start the labelled container vector"

- 2026-09-09 · 9e27d38 · pipeline 822 / repair_journeys (!908) · `docker run … busybox:stable sleep 600` failed after the four journeys before it passed; the job was green on 810–815 the same morning on unchanged harness code (M7 touches nothing in `scripts/test-repair-journeys.sh`). The `docker run` sends its own output to `/dev/null` (`test-repair-journeys.sh:955-960`), so the log cannot say whether it was a Docker Hub pull failure or something else; the next sighting should show that output first.

## The /home account panel does not register as open when armed — desktop and pocket — #1064

- 2026-09-10 · cb9cbfd · pipeline 907 / smoke (job 10645, !911) · two in one run, both passing on the retried job 10651 on the same commit: `v19-keyboard.spec.ts:463` "inbox: reachable via the account panel" (desktop-chromium) — `home account panel: Tab never reached the requested control within 60 presses`; and `v19-keyboard-pocket.spec.ts:276` "home (pocket): the account menu's Inbox link is reachable by Tab" (mobile-chromium) — `expect(locator).toHaveClass(expected)`, its retry aborting the /home navigation instead (that half is the heading below).
- 2026-09-15 · 332f237 · pipeline 1127 / smoke (job 13931, !918) · `v19-keyboard-pocket.spec.ts:262` "home (pocket): the account menu is light-dismiss by keyboard" (mobile-chromium) — `expect(locator).toHaveClass(/open/)` on the sheet. Passed on the retried job 13936 on the same commit, in 1.4s.
- 2026-09-19 · 977a74d · pipeline 1275 / smoke (job 16651, !946) · five at once, four of which Playwright itself reported flaky (passed on retry, same run, same commit): `v19-axe-sweep.spec.ts:209` (desktop, `button.orb` stayed `aria-expanded="false"`), `v19-axe-sweep.spec.ts:225` (mobile, `#morb` the same), `v19-keyboard-pocket.spec.ts:276` (mobile, `#maccount` stayed `"msheet"`), and `v19-keyboard.spec.ts:539` and `:568` (desktop, the 60-press cap inside `openSettingsFromHome`).

This is the split the previous heading asked for on its next sighting, and the
2026-09-19 run settles it the other way round from the guess there: the three
shapes are one fault, not three. `openSettingsFromHome`
(`v19-keyboard.spec.ts:226`) arms `button.orb` and then Tabs for the Settings
link, which lives INSIDE the panel — so a panel that never opened burns the
whole 60-press cap, and reports it against "home account panel". The sessions
list has nothing to do with it.

It is not a transition that has yet to commit either: `toHaveAttribute` polled
thirteen times across five seconds and read `"false"` every time. Five seconds
is not a missed frame, it is a lost event. `settled` / `settleHome`
(`support/keyboard.ts:298`) waits for `#explore` to be attached, which its own
comment admits is only "home rendered its normal markup at all" — something the
server-rendered HTML already satisfies. The toggle ships from the server
carrying `aria-expanded="false"`, so a press landing before Svelte attaches its
handler is swallowed in silence. #1064 has the detail and the fix shape.

Neither the axe sweep nor accessibility is a subject here: both axe tests died
on the `aria-expanded` precondition before `axeCheck()` ran, and no run has
reported an axe violation.

**Fixed, 2026-09-20 (#1064).** The guess above was right and the window is
hydration's: home is server-rendered whole, and a press arriving before
`readHome()` resolves and the mount binds the behaviour is dropped with
nothing to replay it. Home now remembers that press and applies it when the
screen goes live, and publishes `body[data-home-ready]` as the last step of
the mount — the three settle helpers wait for that instead of for markup the
server already sent. Reproduced on demand before the fix by delaying
`/api/workspace`. Left here rather than deleted: a fourth sighting after this
means the fix is wrong, not that the flake is back.

## v19-first-run-door.spec.ts:250, and `net::ERR_ABORTED` on a /home navigation — #1096

- 2026-09-10 · cb9cbfd · pipeline 907 / smoke (job 10645, !911) · `v19-first-run-door.spec.ts:250` "a claimed local-only instance shows the sign-in card in the ring" — `expect(locator).toBeVisible()` failed, element not found. Passed on the retried job 10651 on the same commit.
- 2026-09-19 · 977a74d · pipeline 1275 / smoke (job 16651, !946) · `v19-keyboard.spec.ts:568` "administration: the local-user controls are reachable and announced" (desktop-chromium), retry #1 — `page.goto: net::ERR_ABORTED at http://127.0.0.1:3000/home`. Its first attempt was the account-panel flake above; the retry died before reaching the screen at all, so this test has never yet reported on its own subject in CI.
- 2026-09-23 · 68e3d66f · pipeline 1491 / smoke (job 20319, !971) · `v19-keyboard.spec.ts:296` "home: every control is reachable, focus is visible, and Tab is not trapped" (desktop-chromium) — the same abort on the first attempt AND on retry #1, so the job failed outright at 834s. **Third sighting: #1096 filed.**

**Fixed, 2026-09-23 (#1096).** Not #949, and nothing to do with a sibling
spec: `playwright.config.ts` pins `workers: 1`, so no other spec was running,
and the app answered `/api/auth/session`, `/api/auth/availability` and
`/api/health` with 200 in the same second. All three sightings are one race
inside the failing test, and all three traces show it the same way. The
account signs in with no household anywhere (each test cleans its own away,
and since #1077 the database is back to a seed that holds none), so
`hooks.server.js` sends the returnTo to `/` — 303, in the trace — and `/` is
the arrival, which reads the workspace and hands a reader with somewhere
onward to /home with `location.replace`. The helper then seeds a household and
calls `page.goto("/home")`, and the seed has turned that decision ONWARD while
the read is still in flight: two /home document requests leave milliseconds
apart (09:07:38.328 and 09:07:38.330 in job 20319), the survivor carrying
`Referer: http://127.0.0.1:3000/` — the arrival's own — and Playwright's,
which has no referer, reported as `net::ERR_ABORTED`. In job 10645's trace the
survivor came back 200, so nothing was wrong with the server or the address.
Pipeline 1500's smoke (job 20514) ran the identical predecessor —
`v19-keyboard.spec.ts:252`, same file, same worker — and the test passed in
2.4s, so the ordering is not what differs; the width of the arrival's read is.

`support/arrival.ts`'s `settleArrival` already waits for that decision to
land, and commit 72d8efd0 put it everywhere for #840 in September — but the
sweep missed `v19-keyboard.spec.ts` and `v19-keyboard-pocket.spec.ts`, which
are exactly the two files every `net::ERR_ABORTED` sighting came from. Both
now wait there. The 2026-09-10 door card is left unexplained: it is a
different symptom in a different file and one sighting says nothing.

The app container logged nothing about any of this because it could not: the
`smoke` job's `after_script` diagnostics print "Cannot connect to the Docker
daemon" on all three runs, so `show-stack-diagnostics.sh` produces nothing on
the job it exists for. That is its own defect, not this one.

## v19-tour.spec.ts:354 "journey 1: the first landing on home gets the walk, and skipping ends it"

- 2026-09-15 · 332f237 · pipeline 1127 / smoke (job 13936, !918) · desktop-chromium — `page.evaluate: Execution context was destroyed, most likely because of a navigation`. Playwright reported it flaky: it failed once and passed on its own retry inside the same run, so the job was green.

A `page.evaluate` racing a navigation is the spec reading the page while the
walk is still moving it, not a product fault on the evidence so far. One
sighting proves nothing either way.

## migrations.test.ts "migrates every current migration into a fresh PostgreSQL 18 database"

- 2026-09-10 · `feature/m8-tier2` · local `vitest run --project integration tests/integration/migrations.test.ts` against a disposable PostgreSQL 18 container · failed once, then passed on three consecutive re-runs of the same file on unchanged code. The failing run took 18.8 s against 1.4–1.8 s on each passing run, so it looks like contention with the containers the other migration scenarios in the same file create and drop, rather than a schema-contract mismatch. First sighting; no issue yet (an issue on the third, per the testing-and-ci skill). The next sighting should capture the assertion itself, which this one did not.

## document-lifecycle.test.ts "emits a bounded rejected lifecycle record when reconciliation finds an available document's ciphertext missing"

- 2026-09-15 · `feature/m8-addresses` · local `node scripts/test-integration.mjs` (full suite, disposable PostgreSQL 18 container) · failed once in a whole-suite run, then passed both on its own file (34/34) and on an immediate re-run of the whole suite (404 passed), on unchanged code. The failing run reported 600 ms against the file's ordinary pace.

The assertion itself was not captured, so the next sighting should record it.
Reconciliation reads the document store, and this suite shares one database
with `fileParallelism: false` — so the first thing to check is whether the
run that failed had a neighbouring file still holding or removing files under
the shared `DOCUMENTS_ROOT`, rather than anything about the record's bounds.
First sighting; no issue yet (an issue on the third, per the testing-and-ci
skill).

## fidelity: `first-run-error matches its mockup (porting)` — the mockup capture drifts, the app render does not

- 2026-09-16 · 55f8e36 · pipeline 1159 / fidelity (job 14458) · 5458 of 1,600,000 pixels differ (0.3411%) against a 0.1000% budget, the other 44 tests green and the job healthy at 2.5 minutes. The diff is confined to the card's text block (x 650-948, y 330-672): the app draws "already exists here—" and the mockup "already exists here —", about a pixel apart vertically. The same screen's baseline test passed at 0 pixels in the same run, so the app render is byte-identical to what is committed and only the freshly-captured mockup moved. Job 14352 ran the full gate on this merge's own parent 1dfdee1 two hours earlier and got 13 pixels on this same test, with every other screen's count identical across the two runs — so the merge (`feature/m8-addresses`, whose only web file is a new refusal in `login/+server.js`) cannot have caused it. 13 to 5458 pixels on an unchanged app render points at text shaping in the mockup capture; the host has only ten fonts and substitutes silently, which is the first thing to check on the next sighting.

## extraction-shortlist-recall.test.ts "adds to the tallies it is given rather than replacing them" (first seen alongside a password.test.ts timeout, since fixed under #1104)

- 2026-09-18 · `fix/m9-surface-bugs` · local `pnpm run test` (whole unit suite, 270 files in parallel) · both timed out at 5000 ms in the full run, then passed together in isolation (32/32, ~4.5 s for both files) on unchanged code. The full run was under heavy load (import phase 239 s, tests 833 s), so this reads as scheduler starvation rather than anything in either test — neither file changed on this branch. First sighting of each; no issue yet (an issue on the third, per the testing-and-ci skill).

## local-sign-in.test.ts "spends a real derivation whichever of the four cases it is"

- 2026-09-19 · 9ccca49 (!950, none of it near sign-in) · pipeline 1278 / `integration` job 16683 · `expect(Math.max(...times)).toBeLessThan(Math.min(...times) * 6)` — the four attempts' elapsed times spread wider than 6×. Retried on the same commit as job 16708 and passed. The assertion measures wall-clock on a shared, loaded runner; its own comment (`tests/integration/local-sign-in.test.ts:283-285`) says a strict bound "would measure the runner rather than the code", and the host was writing at 80–160 MB/s under another tenant at the time.

## v19-keyboard.spec.ts:568 "administration: the local-user controls are reachable and announced"

- 2026-09-19 · d0d5b47 (+ #1062's uncommitted end-cap focus-ring work, none of it near administration) · local `scripts/test-e2e-local.sh --spec tests/e2e/v19-keyboard.spec.ts --project desktop-chromium` · the "send a new setup link" button was not found at all: `expect(locator).toHaveAttribute` on `.person` filtered to the row that is not "· you", timing out at 5s with "element(s) not found". The other 22 tests in the run passed. The same test passed on the same code in CI — pipeline 1281 / smoke (job 16738), `✓ 111 [desktop-chromium] ... (3.1s)` — where the run's only two failures were the belt end-caps #1062 was fixing. So the row either had no second person or had not rendered when the assertion looked, rather than the control being missing. First sighting; no issue yet (an issue on the third, per the testing-and-ci skill).

## repair_journeys: a different journey fails on each run of the same commit — #1089

- 2026-09-20 · f5349ffa (!962, `design/866-tour-round-5` — tour mockups and `design/owner-decisions.md` only, nothing the harness reads) · pipeline 1373 / `repair_journeys` job 18392 · `FAIL: rotate-database-credential did not report result=done`, after `diagnosis result=failed checked=18 skipped=0`. The `cancelled-repair` journey passed on this run.
- 2026-09-20 · f5349ffa · pipeline 1373 / `repair_journeys` job 18463 (retry of the above, same commit) · `FAIL: a refused dangerous batch exited 0, expected 6` — in `cancelled-repair`, the journey that had just passed, and `rotate-database-credential` was never reached. A third retry of the same pipeline, job 18499, passed the whole suite.

- 2026-09-22 · ce995b01 (!967, whose diff is `.gitlab-ci.yml` comments, one import in an e2e spec, this file, and `scripts/ci/repin-base-image.sh` with its test — none of it in the install, diagnose or repair path) · pipeline 1460 / `repair_journeys` job 19795, 179s so a real run · `FAIL: rotate-database-credential did not report result=done`, this time in `credential-drift`; `cancelled-repair` and `signal-cleanup` both passed first. The diagnosis found the mismatch; the repair did not run — `restart-services` reported `skipped` and the execution came back `unactionable`.

The signature is the moving failure point, not either symptom: three real runs
(278s, 241s and 179s, so none was lane-skipped) picked a different journey to
fail in, and a retry was green, all on a commit the diff could not reach. `dev`
ran the same job for real at the 2026-09-20 parent commit `3b6ca05c` (pipeline
1369, job 18305, 241s, passed), so the branch was not the cause then either.
**Third sighting: #1089 filed.**

## extraction-shortlist-recall.test.ts:108 "adds to the tallies it is given rather than replacing them" — #1087

- 2026-09-22 · b7a5a883 (!964, which changes only the base-image digest in `Dockerfile` and `.github/supply-chain-policy.json`) · pipeline 1417 / fast (job 18983) · `Error: Test timed out in 5000ms`, 5535ms. Passed on the retried job 19206 on the same commit. `dev` ran the same test green at the same base on pipeline 1379.

The failure is a timeout, not an assertion: the test is synchronous, so it
exceeded the 5 s cap doing its own work. It is the only test in the file that
runs `countAll` over the whole real corpus twice (`SAMPLE.slice(0, 3)` and then
`SAMPLE`) instead of reading the `tallies` the describe block computes once, and
the `fast` project's `testTimeout` is `5_000` (`vitest.config.ts:81`). A loaded
runner is enough to push it over. If it recurs, the fix shape is a per-test
timeout on this one case rather than a global raise.

- 2026-09-22 · 25b3c913 (the `dev` merge of !966, which touches only `web/src` and one e2e spec) · pipeline 1454 / fast (job 19676) · `Error: Test timed out in 5000ms`, alongside a timeout in `password.test.ts`. Retried as job 19693 on the same commit: green, 273 of 273 files and 4338 tests. The diff cannot reach either file, and both failures were timeouts rather than assertions, which is why the job was re-run rather than investigated as a regression. Two pipelines were executing on the same host at the time — 1455 was started manually two minutes into 1454 — so the contention was partly self-inflicted. **Third sighting: #1087 filed.**

## v19-arrival.spec.ts:164 "the newcomer's arrival: the climb, the labelled sky, the real count, the question" — #1085

- 2026-09-22 · 4fc18a27 (#1080, feature/1080-parallel-e2e-workers rebased onto dev's #1077 merge) · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=2`, desktop-chromium · `expect(locator('.nf .disc .big')).toHaveText("2")` received `"1"` at `tests/e2e/v19-arrival.spec.ts:229`, 5000ms timeout. Passed on the same code at `ORBIT_E2E_WORKERS=1` (full 198/198 green) immediately before this run. Under the CI cpu cap, `orbit-app` is shared across concurrently-running workers; this spec counts a discovered household population that another worker's fixtures may still be settling, so a worker-count-dependent race in the count (not the sharing #1080 already removed) is the first thing to check on the next sighting.
- 2026-09-22 · 4fc18a27, same session · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=4`, desktop-chromium · different symptom, same spec: `signInThroughTheDoor` (`tests/e2e/v19-arrival.spec.ts:79`) timed out after 180000ms waiting for `getByRole('link', { name: 'Orbit W0 Newcomer' })` — the sign-in itself never completed, well before the count assertion the first sighting hit.
- 2026-09-22 · 4fc18a27, same session · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=8`, desktop-chromium · same symptom as the second sighting: `signInThroughTheDoor` timed out after 180000ms waiting for `getByRole('link', { name: 'Orbit W4 Newcomer' })`. Third sighting; filed as #1085.
- 2026-09-23 · 079bd351 (#1080, rebased onto dev's 1e2883ae; carries the count fix) · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=4`, desktop-chromium · the sign-in symptom again, not the count one: `signInThroughTheDoor` (`tests/e2e/v19-arrival.spec.ts:79`) exhausted the test's whole 180000ms budget waiting for `getByRole('link', { name: 'Orbit W0 Newcomer' })`, and the `page.waitForResponse` set up before it timed out with it. The same commit ran the full suite green at `ORBIT_E2E_WORKERS=2` immediately before (204 passed, 79 skipped, 9.2m), so the count race the fix addressed is gone and this half is not. Two other specs failed in the same four-worker run, one of them a chromium page crash, which is why this is being read as the capped app and the loaded host rather than as one spec reading another's data. Four workers is above the count the suite ships on (two).
- 2026-09-23 · 42271b4f · local `scripts/test-e2e-local.sh --ci-cap --spec tests/e2e/v19-arrival.spec.ts --project desktop-chromium`, `ORBIT_E2E_WORKERS=4` · did not reproduce: "Running 9 tests using 1 worker", green in 58.9s. Naming one spec file leaves Playwright only that file plus its own required setup/claim files to schedule, so `ORBIT_E2E_WORKERS` never gets a second file to hand to a second worker — the isolated run cannot exercise the cross-worker contention the four sightings above were taken under, whatever the env var says. Read this as ruling out nothing about the earlier sightings, only as ruling out single-spec isolation as a way to reproduce them.
  Code read alongside it found a candidate mechanism for the earlier sightings that single-spec isolation structurally cannot exercise: `createSession` (`src/lib/auth/session.ts:58`) takes `pg_advisory_xact_lock` on `ACCOUNT_LIFECYCLE_LOCK_KEY` (`src/lib/auth/authority-locks.ts:2`, `"orbit:account-lifecycle"`) — one key, not scoped to the signing-in user — and holds it for the whole transaction. `provisionIdentity`'s sign-in branch (`src/lib/auth/provision.ts:200`) takes the same key. Every sign-in on the instance, across every worker, therefore queues on one Postgres lock while `orbit-app` grinds through each transaction at 0.6 cpu; that is a real serialisation point, not a deadlock (the queue drains, FIFO-ish, on commit), but it turns concurrent sign-in load from several workers' specs into one queue with no bound tied to the 180s test timeout. Not confirmed against a hang — the single-file run above could not put load behind the lock — so this is the next thing to check with `pg_stat_activity`/`pg_locks` filtered to `hashtextextended('orbit:account-lifecycle', 0)` during a real multi-file four-worker run, not an established cause.

## v19-create.spec.ts:50 "the create form saves a real item into the orbit"

- 2026-09-22 · 4fc18a27, same session · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=8`, desktop-chromium · `expect(page).toHaveURL(/\/home$/)` at `tests/e2e/v19-create.spec.ts:69` stayed on `/create` after 5000ms instead of navigating to `/home`. Did not occur at 1, 2 or 4 workers on the same code, only at 8. First sighting; no issue yet (an issue on the third, per the testing-and-ci skill).

## v19-entry.spec.ts:99 "a signed-out visit lands in login and returns to the page it wanted"

- 2026-09-23 · 079bd351 (#1080) · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=4`, mobile-chromium · `expect(locator('.dialwrap, .mdial').visible()).toHaveCount(1)` at `tests/e2e/v19-entry.spec.ts:114` received `0` after 5000ms. The test seeds its own household a beat earlier, so there is nothing for another worker to have taken away; under four workers on a 0.6-cpu app the screen had simply not drawn inside the five seconds. Green at two workers in the run before. First sighting; an issue on the third, per the testing-and-ci skill.

## v19-item-actions.spec.ts:188 "completing an item from the v19 view moves its orbit"

- 2026-09-23 · 079bd351 (#1080) · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=4`, mobile-chromium · `page.waitForURL: Navigation failed because page crashed!` inside `settleArrival` (`tests/e2e/support/arrival.ts:29`). The browser process died, not an assertion: the host was carrying four chromium workers, the capped stack and other projects' containers, with 2.2Gi free of 23Gi and 10.6Gi of swap in use when the run started. Green at two workers in the run before. First sighting; an issue on the third.

## v19-screen-reader.spec.ts:356 "sign-out screen" — mobile-chromium

- 2026-09-23 · 1e2883ae (the `dev` merge of !971, #1088's document preview and #1094's belt stepping) · pipeline 1496 / smoke (job 20420) · `locator.click` on `.account .signout` exceeded the file's own 90s budget, on the first attempt AND on retry #1, so the job failed outright at 938s. The button was found every time and never became visible: "locator resolved to `<button class="signout svelte-1we9htl">sign out →</button>`" followed by 170-odd "element is not visible" retries across 90 seconds. The test reached the screen it asked for — the trace has `GET /settings` at 200 and every settings API read behind it — and `page.locator("button.orb").click()` returned without error, so what failed is the desk account panel opening, not the navigation. The two error contexts were captured on `/home`, not `/settings`: the first shows the dial with this file's own seeded item, the second home's adrift surface, because the #1077 reset runs again between the attempts and takes the household `beforeAll` seeded with it. `.account` is desk chrome (home.css scopes it under `.desk`) and both dialects are server-rendered with CSS choosing (CON-10), which is why the button exists in a pocket run at all.

The same test was green on the same code two hours earlier — pipeline 1491's
smoke, both the failed job 20319 (`✓ 278 ... (2.0s)`) and the retried job
20407 (`✓ 277 ... (1.9s)`), on `68e3d66f`, which is the merge's own head — and
no other pipeline ran `1e2883ae`. An account panel that does not register as
open when armed is the #1064 family, fixed on 2026-09-20 for `/home` by
waiting for `body[data-home-ready]`; `/settings` has no such marker, so the
first thing to check on the next sighting is whether the press landed before
that screen bound its own chrome. The next sighting should also record the
page's URL at failure, which this one has to infer.

## `sidecar_images` job: the dependency proxy answers 404 for a pinned manifest

- 2026-09-23 · `chore/base-image-repin` c6538042 (!981, a policy-file re-pin, nothing near the sidecar list) · pipeline 1564 / job 21507, 22:07–22:11 UTC · Trivy's worker for `node:24-alpine@sha256:333f6b3e…` got `404 Not Found` (GitLab's HTML error page) from `gitlab.tomlawson.io:443/v2/ai/dependency_proxy/containers/library/node/manifests/sha256:333f6b3e…`; the other three images in the same run resolved. The same digest had scanned on pipeline 1560 forty minutes earlier, and the retry on the same commit (21543) passed in 204 s. First sighting; no issue yet. The host's disk had been cleared by hand about two hours before, so a proxy cache entry gone missing is one guess — the next sighting should check whether the proxy had the manifest cached (`dependency_proxy/manifests` under the group's storage) or had to go upstream.
- 2026-09-23 · `chore/base-image-repin` 07ad6f6a (!981 after the schedule re-pinned it) · pipeline 1568, 22:59 UTC · five jobs at once — `sidecar_images` (clamav), `smoke` and `smoke_local_only` (postgres), `supply_chain_image` (trivy), `repair_journeys` — each got `not found` from the proxy for a different pinned digest, so the proxy as a whole was refusing rather than one entry missing. `pipelines/1568/retry` about 15 minutes later: all five passed. Second sighting. Both today, both within three hours of the host's disk being cleared by hand; Docker Hub's anonymous pull limit is the other candidate, given the day's pull volume — the next sighting should read the proxy's own log on the GitLab host (`dependency_proxy` entries in `gitlab-rails/production_json.log`) to tell the two apart.
