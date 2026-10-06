# Flakes

A flake is a check that failed and passed again on unchanged code. One heading
per flake, one line per sighting: `date · commit · pipeline/job · symptom`.
The third sighting under a heading gets an issue, linked from the heading;
fixing the cause deletes the heading in the same commit.

## check-base-image-current.test.mjs "tells the reader to merge dev when dev already pins the tag's current digest" (#1134)

- 2026-09-19 · 3e855e2 (+ #1052's uncommitted administration work, none of it near this script) · local `scripts/test-backend.sh` · timed out at the 5s default. The whole file passed on a rerun immediately after on the same code, taking 1.9s for this test and 7.5s for the file — so it is the wall-clock budget under a loaded host, not the script. Every test here spawns real `git` subprocesses against temporary repositories.
- 2026-09-24 · 8f05e163 (#1107, no change near this script) · local `./node_modules/.bin/vitest run` (full suite) · timed out at the 5s default alongside "falls back to fetching dev when it is not already present locally" below, both in the same file, both green on an immediate rerun of the file alone. Same wall-clock-under-load shape as the first sighting.
- 2026-09-26 · a7dcd3d1 (#1125's phone settings, no change near this script) · local `scripts/test-backend.sh` · timed out at the 5s default; green on an immediate rerun of the file alone. Third sighting: #1134.
- 2026-09-27 · 6420d955 (+ #1057's uncommitted desk search wiring, none of it near this script) · local `scripts/test-backend.sh` (worktree, seven parallel builds sharing the host) · timed out at the 5s default alongside the other two tests in this file's describe block, below and in the new heading below. All three green on an immediate rerun of the file alone (12.3s total, ~3s each). Still #1134.
- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, none of it near this script) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default; a solo rerun of just this file moments later still missed the 5s budget (5.3-6.2s each) while the other six agents' builds were still running, consistent with the wall-clock-under-load shape rather than a new cause.

## check-base-image-current.test.mjs "falls back to fetching dev when it is not already present locally" (#1134)

- 2026-09-24 · 8f05e163 (#1107, no change near this script) · local `./node_modules/.bin/vitest run` (full suite) · timed out at the 5s default; green on an immediate rerun of the file alone. Same file and run as the sighting above; first sighting for this test.
- 2026-09-27 · 6420d955 (+ #1057's uncommitted desk search wiring, none of it near this script) · local `scripts/test-backend.sh` (worktree, seven parallel builds sharing the host) · timed out at the 5s default in the same run as the heading above. Green on an immediate rerun of the file alone. Second sighting.
- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, none of it near this script) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default alongside "tells the reader…" and "keeps the re-pin advice…" above/below, all three in the same file, same run. Second sighting.
- 2026-09-27 · 6420d955 (+ #1002's uncommitted desk archive card, none of it near this script; six other worktrees building in parallel on this host) · local `scripts/test-backend.sh` · timed out at the 5s default alongside "keeps the re-pin advice when dev has not re-pinned either" below, both in the same file, both green on an immediate rerun of the file alone. Same wall-clock-under-load shape.
- 2026-09-27 · 6420d955 (+ #1002's uncommitted desk archive card, same worktree, same host load as the sighting above) · local `scripts/test-backend.sh` · timed out at the 5s default again on a second full run, green on an immediate rerun of the file alone. Third sighting: covered by #1134, which already names this whole file rather than one test in it.

## check-base-image-current.test.mjs "keeps the re-pin advice when dev has not re-pinned either"

- 2026-09-27 · 6420d955 (+ #1057's uncommitted desk search wiring, none of it near this script) · local `scripts/test-backend.sh` (worktree, seven parallel builds sharing the host) · timed out at the 5s default in the same run as the two headings above. Green on an immediate rerun of the file alone. First sighting for this test; same wall-clock-under-load shape as #1134.
- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, none of it near this script) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default alongside the other two tests in this file, same run. First sighting for this test.
- 2026-09-27 · 6420d955 (same uncommitted work) · local `scripts/test-backend.sh`, same worktree, immediate rerun, same seven-agent host load · timed out again at the 5s default. Second sighting.
- 2026-09-27 · 6420d955 (+ #1002's uncommitted desk archive card, none of it near this script; six other worktrees building in parallel on this host) · local `scripts/test-backend.sh` · timed out at the 5s default; green on an immediate rerun of the file alone. Same run as the sighting above; first sighting for this test.

## check-base-image-current.test.mjs "falls back to the tag-moved advice when dev has no remote to resolve it from"

- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, none of it near this script) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default; this test had been green in the same file's own first, less-loaded run minutes earlier — the fourth and last git-spawning test in this file to fall, as load climbed further. First sighting.

## availability-route.test.mjs "GET /api/auth/availability carries phase: starting straight from getBootPhase" (#869)

- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, nowhere near auth/availability) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default in a run that took 393s overall against 232s for the same file set minutes before, with unrelated files failing alongside it — wall-clock-under-load, not this test. First sighting.
- 2026-09-27 · 6420d955 (+ #1002's uncommitted desk archive card, none of it near this route; six other worktrees building in parallel on this host) · local `scripts/test-backend.sh` · timed out at the 5s default; green on an immediate rerun of the file alone (2.1s for all 6 tests). Same wall-clock-under-load shape as the check-base-image-current.test.mjs headings above; first sighting for this test.

## extraction-shortlist-recall.test.ts "countShortlistRecall over real corpus pages adds to the tallies it is given rather than replacing them"

- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, nowhere near document extraction) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default in the same heavily-loaded run as the sighting above. First sighting.

## check-base-image-current.test.mjs "keeps the re-pin advice when dev has not re-pinned either"

- 2026-09-27 · 6420d955 (+ #1142's uncommitted pocket CSS and design notes, none of it near this script) · local `scripts/test-backend.sh`, with seven other agents building on the host · timed out at the 5s default, as did two more tests in the same file whose names scrolled past the captured tail; the file alone was green on an immediate rerun (8 of 8, 9.8s). Same wall-clock-under-load shape as the two headings above; first sighting for this test.

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

## v19-keyboard-pocket.spec.ts:570 "inbox (pocket): fully reachable by keyboard" — mobile-chromium

- 2026-09-27 · 7b812e69 (+ #1149's uncommitted home-dial Escape work, none of it near the inbox) · local `scripts/test-e2e-local.sh`, both projects, keyboard-pocket and mail-review specs together · `auditTabOrder` reported `Tab reached a control the screen does not show as visible: a "open the relay →"` — the empty queue's relay card (`.pki-quiet`, inbox/pocket.svelte) was on screen (the test's own `toBeVisible` wait had passed) but its pill was left out of the visible-controls snapshot, so the audit took it for an invisible stop. The same spec on the same code was green in the run before (one project, 18 of 19 passing) and in the run after (23 passed, 14 skipped). First sighting; the next one should record the pill's computed opacity at snapshot time, since the audit's `isReallyVisible` reads it.
- 2026-09-27 · 2bc73418 · local `scripts/test-e2e-local.sh`, full suite, mobile-chromium · the same `a "open the relay →"` report, on a branch that does not touch the inbox. Opacity not captured. Attempted fix in the same commit as this line: the spec now waits for `.pk-inbox`'s entrance animations to finish before the audit, as the household (pocket) test already does; delete this heading once CI has run it green a few times.

## `sidecar_images` job: the dependency proxy answers 404 for a pinned manifest (#1167)

- 2026-09-23 · `chore/base-image-repin` c6538042 (!981, a policy-file re-pin, nothing near the sidecar list) · pipeline 1564 / job 21507, 22:07–22:11 UTC · Trivy's worker for `node:24-alpine@sha256:333f6b3e…` got `404 Not Found` (GitLab's HTML error page) from `gitlab.tomlawson.io:443/v2/ai/dependency_proxy/containers/library/node/manifests/sha256:333f6b3e…`; the other three images in the same run resolved. The same digest had scanned on pipeline 1560 forty minutes earlier, and the retry on the same commit (21543) passed in 204 s. First sighting; no issue yet. The host's disk had been cleared by hand about two hours before, so a proxy cache entry gone missing is one guess — the next sighting should check whether the proxy had the manifest cached (`dependency_proxy/manifests` under the group's storage) or had to go upstream.
- 2026-09-23 · `chore/base-image-repin` 07ad6f6a (!981 after the schedule re-pinned it) · pipeline 1568, 22:59 UTC · five jobs at once — `sidecar_images` (clamav), `smoke` and `smoke_local_only` (postgres), `supply_chain_image` (trivy), `repair_journeys` — each got `not found` from the proxy for a different pinned digest, so the proxy as a whole was refusing rather than one entry missing. `pipelines/1568/retry` about 15 minutes later: all five passed. Second sighting. Both today, both within three hours of the host's disk being cleared by hand; Docker Hub's anonymous pull limit is the other candidate, given the day's pull volume — the next sighting should read the proxy's own log on the GitLab host (`dependency_proxy` entries in `gitlab-rails/production_json.log`) to tell the two apart.
- 2026-09-28 · `chore/base-image-repin` b1d3820e (!1001) · pipeline 1796 · seven jobs at once, all pulling `node:24-alpine@sha256:83f1c388…` through the proxy; `sidecar_images` retried as job 26189 and passed. Third sighting: filed as #1167.
- 2026-10-05 · `chore/base-image-repin` 02c495d3 (!1027, the scheduled re-pin) · pipeline 2139, 06:46–06:48 UTC · eight jobs at once: `not found` from the proxy for pinned trivy and `node:24-alpine@sha256:83f1c388…` digests, and in `sidecar_images` a `403 Forbidden` from `/jwt/auth` for the ollama pull scope (new: the proxy's auth step, not a missing cache entry). `pipelines/2139/retry` at about 09:30 UTC: green. Fourth sighting, on #1167.

## Runner host out of disk: `no space left on device`, and browsers crashing in the same pipeline (#1200)

- 2026-09-27 · 0eb5ac03 (!995, phone batch) · pipeline 1721 · four jobs lost, none to an assertion: `sidecar_images` (runner 1, `cp: write error: No space left on device` copying the Trivy cache), `smoke_local_only` (runner 8, `no space left on device` writing to `/builds/.orbit-docker-data/containerd`), `fidelity` (runner 7, `Page crashed` in `pocket-kit.spec.js:142`, 169 of 170 appearance tests and all 508 measurements passed), `smoke` (runner 8, `Target crashed` opening a page in `second-factor.spec.ts:223`, 170 passed). Both runners are on the host `gitlab-runners`; the nightly tidy runs at 03:15. First sighting.
- 2026-10-01 · f80a6d1f (!1013, Firefox run) · pipeline 1934, 21:42 UTC · `build_image` (`pnpm install`: `No space left on device` in the image build) and `sidecar_images` (Trivy: `unable to initialize fs cache: DB error: write /tmp`, then `cp: write error: No space left on device`); the seven jobs behind them skipped. Pipeline 1933 (!1014) on the same host at the same time. Second sighting; the host's disk was full eight hours after the nightly tidy, so the tidy's reserve (3 GB) is not holding a day's pulls.
- 2026-10-03 · 0e2bfac9 (!1020, launcher pin; diff is `launcher/pin.json` only) · pipeline 2024 / fast (job 30633) · `ENOSPC: no space left on device, mkdtemp '/tmp/orbit-vitest-…'` failed 15 tests in `config-contract.parity.test.ts`, and `restore-engine.interruption.test.ts:138` in the same run. Job retried as 30724. Third sighting: filed as #1200.

## Runner host killed two jobs at once with exit 137, mid-run

- 2026-10-03 · 58dec64f (!1017) · pipeline 2005, jobs 30264 (`smoke_webkit_mobile`) and 30265 (`smoke_local_only`) · both jobs' `step_script` sections ended at the identical second, `section_end:1791018971:step_script` at 09:16:11Z, and both then failed with `exit code 137` a few seconds into `after_script`. 30265 was still mid-pull of a 489MB image layer with no error logged first; 30264 was 15 tests from the end of its own run. Neither job's own log explains the kill -- a job container cannot see the host's OOM killer -- and `after_script`'s own "Cannot connect to the Docker daemon" is the same non-diagnostic noise already recorded under the `v19-first-run-door.spec.ts:250` heading above (#1096's own note), not evidence of cause here. The same pipeline's `smoke_webkit` (30263) had already finished 55s earlier, on its own `maxFailures` cutoff, with several previously-green tests failing or flaky (below) -- consistent with the host already under load before whatever killed the other two, though not proof of it. First sighting of two jobs dying together like this; a one-off host event, not a code suspect, so no issue yet.

## v19-reduced-motion.spec.ts:244 "reduced motion › signed-out screens hold still" — desktop-chromium

- 2026-09-27 · 68c86337 (the `dev` merge of !995) · pipeline 1734 / smoke (job 25072) · failed after 20.5s. Passed in pipeline 1740 on d97cb335 (!997), whose diff touches only mail-in failure reasons and cannot reach the signed-out screens. First sighting; an issue on the third.

## fidelity: `item matches its approved appearance` — over budget under load (#1163)

- 2026-09-27 · 68c86337 (the `dev` merge of !995) · pipeline 1734 / fidelity (job 25068) · 1730 pixels differ (0.1081%) against the 0.1% budget. Passed in pipeline 1740 on d97cb335 (!997), which does not touch the item screen. Matches the known load sensitivity: the same screen measured 0.1056% and 0.115% with other runs on the host and 0.04% on a quiet one. First sighting in CI; an issue on the third.
- 2026-09-27 · 667f28d8 (the M14 desk batch, which does not touch the item screen) · local fidelity gate in the pinned Playwright image, alongside the pocket-measure run and other agents' builds · 1689 pixels differ (0.1056%). Rerun alone in the same image: 645 pixels (0.0403%), passed. Second sighting.
- 2026-09-27 · 7bf02998 (`feature/1161-unrolled-search`, desk home only) · local fidelity gate in the pinned Playwright image, beside pocket-measure · 1689 pixels (0.1056%); rerun alone: 678 pixels (0.0424%), passed. Third sighting: filed as #1163.
- 2026-09-27 · 1ec4047a (!999; its shared-code changes are `/auth/error` states and a settings data call, neither on the item screen) · pipeline 1773 / fidelity (job 25919) · 1820 pixels (0.1138%). Job retried.

## fidelity: pocket-home-drawers.spec.js:73 "the dial arrives on a forward arrival, never on Back" (#1164)

- 2026-09-27 · 667f28d8 (the M14 desk batch; its only home change is the desk's `+page.svelte` search wiring, not the pocket dial) · local fidelity gate in the pinned Playwright image on a loaded host · after Back to /home, `expect(dial).not.toHaveClass(/arrive/)` found no dial element within the timeout. Rerun alone in the same image straight after: passed in 4.8s. First sighting.
- 2026-09-27 · b1157cd6 (#1142/#1159 pocket row changes on `fix/1142-opened-signal`, none in the dial's arrival) · local pocket fidelity in the pinned Playwright image, during the pocket-measure run and another agent's work · failed the same way; rerun alone in the same image: passed in 8.3s. Second sighting.
- 2026-09-27 · ee496987 (`fix/1131-desk-contrast`, a desk filled-primary button colour change, none in the pocket dial) · local fidelity gate in the pinned Playwright image · failed the same way; rerun alone in the same image: passed in 41.1s (whole file) with test 7 of 13 clean at 3.1s. Third sighting: filed as #1164.
- 2026-10-01 · d3141346 (!1013, #1183's Firefox projects for tests/e2e; nothing under web/ or tests/fidelity) · pipeline 1926 / fidelity (job 28697) · now at line 95: after Back to /home, `expect(dial).not.toHaveClass(/arrive/)` found no dial element. The same pipeline's smoke ran about eleven minutes longer than usual alongside it on the shared runner.
- 2026-10-04 · 0bfe9636 (!1021, #1151's audit fixes; the batch's home changes are the pocket's save and leave-guard paths, not the dial's arrival) · pipeline 2079 / fidelity (job 31205) · at line 95 again: after Back to /home, `expect(dial).not.toHaveClass(/arrive/)` failed; 176 of 177 passed in the same job, which ran 17.8 minutes alongside fidelity_webkit and repair_journeys on the shared runner. Fifth sighting, still #1164.
- 2026-10-04 · 03320b1f (!1021; since the last green run of this test at bc9ba29e the batch touched only the create form, the item page's panel-switch confirm, an admin pocket line and `push/alerts.js`, none on the dial's path) · pipeline 2085 / fidelity (job 31292) · at line 108 again: after Back to /home, `.pocket .mdial` not found within 5s; 176 of 177 passed. Re-run as job 31304 on the same commit: green. Sixth sighting, still #1164; the second in a row on this branch (2079 was the fifth).
- 2026-10-04 · 0d43ca97 (`dev` after !1021 merged; nothing new on the dial's path since the sighting above) · pipeline 2087 / fidelity (job 31333) · at line 95 again: after Back to /home, `expect(dial).not.toHaveClass(/arrive/)` found no dial within 5s; 176 of 177 passed in the job, which ran 17 minutes alongside `fidelity_webkit` and the acceptance jobs. Seventh sighting, still #1164.
- 2026-10-04 · 2714596f (!1023, the range-fix batch: scripts, `src/lib` and their tests, nothing under `web/`) · pipeline 2095 / fidelity (job 31389) · the same failure at line 95, the job's only red check; a 17.5-minute run in the full acceptance stage. Eighth sighting, still #1164.
- 2026-10-04 · 6329566d (`dev`, the merge of !1023; nothing new on the dial's path) · pipeline 2098 / fidelity (job 31451) · at line 108: after Back to /home, `.pocket .mdial` not found within 5s; 176 of 177 passed. Ninth sighting, still #1164.
- 2026-10-04 · no harness change on `fix/1208-webkit-fidelity-wait`: the approved wait (the dial attached within 30s, then judged once) failed 3 of 5 in the pinned image on an idle host, the dial never coming back. The address reads /item/i-mot before the item screen has rendered; the test's Back lands in that gap, the popstate to /home arrives while the forward navigation is still finishing, and the item screen then renders under /home and stays (a probe: popstate at 181-203ms, the item's title at 271-303ms, no dial 3s later). Waiting for the item screen before Back passed 4 of 4. Not load: a navigation race in the product, left for a ruling.

## sign-in-methods.spec.ts:158 "a reader changes their password from the helm, inline" — desktop-chromium

- 2026-09-27 · d97cb335 (!997) · pipeline 1740 / smoke (job 25230) · `.note.ok` never showed "password changed" within 5000ms at line 190. Retried as job 25322 on the same commit: green. !997 touches only mail-in failure reasons and cannot reach the password form. First sighting; an issue on the third.
- 2026-09-30 · 6f720bed (!1005, M14 batch: 500 page, staged attachment preview, contrast fixes; none reach the password form) · pipeline 1827 / smoke (job 26687) · same failure at line 190; the in-job retry then got "the password was refused (HTTP 403)" in 3.5s, consistent with the first attempt having changed it. Job retried as 26693: green. Second sighting.
- 2026-09-30 · 977a6cba (!1006, M14 pocket-film batch: `web/src/lib/tour/*` and two pocket route files; none reach the password form) · pipeline 1832 / smoke (job 26744) · this time at line 183: the wrong-current-password `.note` ("current password") never appeared within 5000ms, element not found. Playwright's in-job retry passed (reported `1 flaky`). Third sighting: filed as #1173.
- 2026-09-30 · a2da0d64 (!1006, the commit that filed #1173; touches only this file and this doc) · pipeline 1836 / smoke (job 26825) · failed on BOTH attempts this time: first attempt (19.1s) timed out waiting for `.note.ok` "password changed" at line 190; the in-job retry (4.3s) then failed differently, with "the password was refused (HTTP 403)" at `tests/e2e/support/local-credentials.ts:76` -- the first attempt's save had gone through for real, and the retry's own setup could no longer prove the account's old password. Fourth sighting. Root cause found: the save is one HTTP round trip that the UI's note waits on regardless of how long it takes (two Argon2id derivations plus ending every other session), so the fixed 5000ms wait was racing the response rather than answering it -- and the `finally` cleanup raced the still-in-flight first save the same way, leaving the account's password in whichever state finished last. Fixed by waiting on the save's own network response (`page.waitForResponse`) before asserting the note, and by only running the cleanup once that response is known to have succeeded. Reproduced by hand with a temporary 6s delay injected into the password route: the old test failed identically on both attempts (line 183, matching the third sighting); the fixed test passed every time under the same injected delay. Closed by #1173.

## sign-in-methods.spec.ts:129, :162 and v19-axe-sweep.spec.ts:372, /settings never draws its cards — desktop-webkit (#1195)

- 2026-10-03 · 58dec64f (!1017) · pipeline 2005 / smoke_webkit (job 30263) · three in one run, all the `.cards`-never-renders shape #1195 already names: `:129` "the helm lists the sign-in methods an account actually has" and `:162` "a reader changes their password from the helm, inline" each timed out in `openSettings` (`expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 })`, line 121) on both their attempts; `v19-axe-sweep.spec.ts:372`'s `/settings` case instead hung inside axe's own `.analyze()` for the full 60000ms test timeout on attempt 1, then hit "Target page, context or browser has been closed" on retry -- a hang rather than the quick element-not-found the other two show, but on the one screen #1195 already says draws broken. `:129` and `v19-axe-sweep.spec.ts:372`'s `/settings` case both already carry `test.fail(test.info().project.name === "desktop-webkit", ...)` from 00e44355, yet both are in this job's own failed-test list rather than reported as expected failures; `:162` carries no such marker at all. Not established here why the existing markers did not keep these out of the failure count, or whether #1195 is the whole explanation for the axe hang rather than a contributing one -- both worth the next sighting's attention. Not treated as a fresh flake needing its own issue: the cause is already #1195's.

## sign-in-methods.spec.ts:245 "an administrator sends a new setup link from somebody's row" — desktop-chromium

- 2026-09-30 · 977a6cba (!1006, M14 pocket-film batch: `web/src/lib/tour/*`, `web/src/routes/home/pocket.svelte`, `web/src/routes/create/pocket.svelte`; none reach `/administration` or the setup-link mail route) · pipeline 1832 / smoke (job 26744) · `.adminproblem.ok` never showed "Setup link sent to" within 5000ms, on the file's only real attempt (the worker had already bailed out of this file over `sign-in-methods.spec.ts:158`'s failure just before it, so the whole file reran once). Same shape as the "send a new setup link" render-timing sighting under `v19-keyboard.spec.ts` above, in a different spec. Isolated rerun locally (`scripts/test-e2e-local.sh --spec tests/e2e/sign-in-methods.spec.ts --project desktop-chromium --ci-cap`, matching CI's cpu/memory cap): all 4 tests in the file passed, this one in 4.4s. First sighting; an issue on the third.
- 2026-10-04 · 0d43ca97 (`dev` after !1021 merged; the batch touched the local-credentials setup-mail path only to persist the token before sending, #1151 RANGE-R1 is the open finding there) · pipeline 2087 / smoke_firefox (job 31339), desktop-firefox · same shape, now at line 299 (the file grew): `.adminproblem.ok` never showed "Setup link sent to" within 5000ms, element not found, 12.3s into the test. The retry then cascaded: Playwright reran the whole file, and the preceding test (`:241`, adds a local user) failed its retry with a strict-mode violation at line 276 because the first run's "Newcomer Lawson" was still in the roster beside the retry's own, so `:279` never got its retry and the job went red; 181 passed, 1 flaky, 1 failed. Second sighting; an issue on the third. The `:241` cascade is a test-hygiene gap worth fixing with it: the newcomer it creates is never removed.

## sign-in-methods.spec.ts:279 "an administrator sends a new setup link from somebody's row" — desktop-firefox (#1229)

- 2026-10-03 · 594b745a (!1017) · pipeline 1999 / smoke_firefox (job 30199) · `.adminproblem.ok` never showed "Setup link sent to" within 5000ms (19.8s total, no retry of its own — see below). The file is `describe.configure({ mode: "serial" })` (line 127), and this was the serial block's first failure on its first pass through the file, so the whole file reran; on that rerun the earlier test `sign-in-methods.spec.ts:241` "an administrator adds a local user and is told where the link went" (which had passed cleanly, 19.2s, on the first pass) hit the identical `.adminproblem.ok` timeout itself (24.6s), which is why :241 is reported flaky rather than clean, and why this test's own retry shows skipped — serial mode stopped the rerun at :241's failure before reaching :279 again. For :241's failing attempt the trace shows the actual cause: `POST /api/admin/users` at 07:29:38.700Z, with GreenMail's own log not creating that mailbox until 07:29:44.284 — the create-user-and-email round trip took about 5.58s against the UI's 5s wait. No trace was captured for :279 itself (`trace: on-first-retry`, and this was the first/only attempt), so its own round trip isn't independently timed, but GreenMail shows it created `w0-member@example.test` (this test's own recipient) at 07:28:31.580, well after the test had started (~07:28:16) — the same shape. The same job's Tika pipe-server logged two "socket timeout while waiting for task" shutdowns in this run, and the same two tests pass cleanly on desktop-chromium and desktop-webkit in this pipeline, consistent with a loaded host rather than a code change. First sighting on desktop-firefox; the heading above covers one desktop-chromium sighting of this same test (2026-09-30, pipeline 1832). An issue on the third sighting of either.
- 2026-10-06 · c098d32b (!1032 merged to preview; `web/` and `tests/` identical to 3eb5c4dc, on which pipeline 2199 ran this job green) · pipeline 2200 / smoke_firefox (job 32465) · the same `.adminproblem.ok` "Setup link sent to" 5 s miss, on the attempt and the in-job retry; `:243` flaky in the same run with the two-"Newcomer Lawson"-rows strict-mode violation. Job retried as 32477. Second Firefox sighting, third across browsers (desktop-webkit on 2199 the same morning): filed as #1229.

## v19-explore-search.spec.ts:314 "clicking the note line's add act, at rest, opens /create" — desktop-chromium

- 2026-09-30 · 6f720bed (!1005, none of it in the search strip) · pipeline 1827 / smoke (job 26687) · `#strip-note .act` "add an item" resolved but stayed hidden for 5000ms; Playwright's in-job retry passed in 3.7s. First sighting.

## v19-explore-search.spec.ts, five tests in one run — desktop-webkit

- 2026-10-03 · 58dec64f (!1017) · pipeline 2005 / smoke_webkit (job 30263) · five tests in the same file and run, each an element or count that should appear after typing into `#explore` not showing within its 5000ms: `:161` "typing in #explore filters the results by title, section and provider" -- `#explore-results` never contained "Kwik-Fit MOT proving" (failed on both attempts); `:230` "#strip never draws below the field, even on a short viewport" -- `#strip` stayed `hidden` (passed on retry, 16.7s); `:260` "ArrowRight steps the strip's selection and Enter opens the selected entry" -- `#explore-results li` stayed at 0 of an expected 2 (passed on retry); `:284` "hovering a mark selects it" -- `#strip .match` stayed at 0 of an expected 2 (passed on retry); `:314` "clicking the note line's add act, at rest, opens /create" -- `#strip-note .act` "add an item" stayed `hidden` on attempt 1, and the retry was interrupted by the job's own `maxFailures` cutoff rather than failing on its own account. One sighting here covers all five rather than five headings, since they share one shape (search results not appearing in time) in one run; first sighting on desktop-webkit. `:314` has one earlier desktop-chromium sighting above with the identical locator and symptom (2026-09-30, pipeline 1827) -- not combined with this one, different engine. An issue on the third sighting of any of these on desktop-webkit.
- 2026-10-03 · 6ce69cf0 (!1017) · pipeline 2011 / smoke_webkit (job 30393) · `:296` "hovering a mark selects it" -- `#strip .match` stayed at 0 of an expected 2 for 5000ms, then passed on the in-job retry (12.8s). Second sighting of this one. The other four from the first line now carry `test.fail` under #1197 (the strip not opening on desktop Safari at all) and fail consistently rather than by chance -- `:161`, `:236`, `:269` held in pipelines 2009 and 2011, and `:326` (the add act hidden on both attempts here) was marked after this run. This hover test is the one that keeps passing on retry, so it stays unmarked and recorded here.

## backup-restore-cli.test.ts:337 "refuses (capacity-insufficient) before ever calling confirm(), when the document volume has no room"

- 2026-09-27 · 6420d955 (+ #1069's uncommitted desk-create work, nowhere near backup/restore) · local `scripts/test-backend.sh`, seven worktrees running it at once · `Error: Test timed out in 5000ms`, alongside the sighting below in the same file. The whole file passed alone immediately after on the same code — 24 of 24, the two above included, 60s total — so it is the 5s default under a very loaded host, not the test. First sighting.

## backup-restore-cli.test.ts:362 "refuses (restore-not-confirmed) and takes no checkpoint when confirm() returns false, only after preflight/capacity already passed"

- 2026-09-27 · 6420d955 (+ #1069's uncommitted desk-create work, nowhere near backup/restore) · local `scripts/test-backend.sh`, seven worktrees running it at once · `Error: Test timed out in 5000ms`, alongside the sighting above in the same file. Same rerun, same result: green alone. First sighting.

## v19-archive.spec.ts:143 "write an archive, then bring it into a second household — a clash stays out" — desktop-chromium

- 2026-09-30 · 0135f516 (!1006, M14 pocket-film batch plus `dev`'s base-image re-pin; nothing near archives) · pipeline 1855 / smoke (job 27172) · a `toHaveCount` assertion failed on the first attempt and on Playwright's in-job retry, so the job failed outright. Job retried as 27269 on the same commit: green, 221 passed. First sighting; an issue on the third.

## veil.js's fade timer fires after a tour unit file has ended — "window is not defined" (whichever file ran last)

- 2026-10-04 · 91a3ada2 (!1021; the batch's only veil change, W3-S1, adds no timer, and the fade timer itself dates from 2026-09-22) · local `scripts/test-backend.sh` (full 393-file run, two integration suites sharing the host) · every test passed, but Vitest caught one unhandled `ReferenceError: window is not defined` at `removeListeners web/src/lib/tour/veil.js:280`, from `hideVeil`'s `setTimeout` teardown firing after the file's jsdom window was gone, and exited 1. The same file alone passed three times in a row straight after on the same code, and CI's `fast` job was green on `bc9ba29e`. First sighting; an issue on the third.
- 2026-10-04 · 440eb552 (!1024 rebased onto 6329566d; no `web/` change in the branch) · pipeline 2101 / fast (job 31506) · the same unhandled error, this time attributed to `tests/unit/v19-tour-vocabulary.test.mjs`, same stack (`removeListeners` ← `teardownOverlay` ← the `hideTimer` timeout at veil.js:388); 393 files, 5469 tests passed, and the one unhandled error failed the job. The same `dev` code passed `fast` on pipelines 2100 (31486) and 2102 (31526) within the hour. Second sighting; the attributed file differs because the timer outlives whichever file ran last, hence this heading names the mechanism rather than one file. Retried as a job retry on 2101.

## v19-archive.spec.ts:172 and :241, `answerArchiveChallenge`'s `expect(challenge).toHaveCount(0)` at :114 — desktop-firefox

- 2026-10-03 · 594b745a (!1017) · pipeline 1999 / smoke_firefox (job 30199) · two in one run, both passing on the file's own Playwright retry: `:172` "write an archive, then bring it into a second household — a clash stays out" — after filling the password and clicking "confirm and carry on", `expect(challenge).toHaveCount(0)` found the challenge locator still resolving to 1 element on all 13 polls across the 5000ms timeout (27.6s total for the attempt); and `:241` "a wrong passphrase is refused, and nothing is read" — the same assertion, 14 polls, same 5000ms timeout (22.3s total). No trace was captured for either failing attempt (`trace: on-first-retry`), so there is no network or DOM detail beyond the error-context: only that the password-step-up dialog had not closed by the time the assertion gave up. Each passed on its own retry in the same run (33.6s and 19.4s). Not established whether this is the same cause as the desktop-chromium sighting above (different engine; that one's own failing assertion was not recorded, and this pipeline's own `smoke_webkit` job failed these two tests for an unrelated, already-diagnosed reason — a WebKit navigation race, not this challenge-closing wait). First sighting on desktop-firefox; an issue on the third sighting of either.

## pocket-measure.spec.js:540 "/home · film-create meets the pocket floors" — pocket-measure, 390x664

- 2026-09-30 · 0135f516 (!1006, the batch that built this film chapter) · pipeline 1855 / fidelity (job 27168) · `page.waitForFunction` hit the 60000ms test timeout. The same test passed on pipeline 1836 (same film code), and the job retried as 27270 on the same commit was green. First sighting; an issue on the third.

## fidelity: door-station.spec.js:103 "the ring's hand-over to a card at 390x664, motion no-preference › the ring travels from the door's station to the card's"

- 2026-10-01 · d3141346 (!1013, #1183's Firefox projects for tests/e2e; nothing under web/ or tests/fidelity) · pipeline 1926 / fidelity (job 28697) · "a jump between frames at 317ms": 38.9 against the < 20 bound. The full fidelity runs on !1010 and !1012 just before it passed, and the same pipeline's smoke ran about eleven minutes longer than usual alongside it on the shared runner. First sighting; an issue on the third.
- 2026-10-04 · bc9ba29e (!1021, #1151's audit fixes; the only door-side change since the green run on bcaf64e0 is a waiting-card timeout constant, nothing in the ring's motion) · pipeline 2064 / fidelity (job 31041) · "a jump between frames at 280ms": 25.5 against the < 20 bound, same shape as the first sighting. The same test passed on pipeline 2054 ten commits earlier. Second sighting; an issue on the third.

## tour-pocket-webkit.spec.js "plays end to end at 430x932 under normal motion" — pill moving between places (#1174)

- 2026-10-01 · c952834f · local `pocket-webkit` (Playwright image, WebKit) · one fault, "pill moving between places (dim raised) · /create · ch2": the pill was mid-move for over the check's 3s at one sample, with the page painting 9.6 frames a second on a busy host. Green on an immediate rerun of the test alone on the same code (12.2 frames a second). The move is a 350ms fade, so this is the sampler's wall-clock bound under load.
- 2026-10-01 · b6154cd4 · local `pocket-webkit`, full project run (24.8 minutes, host load average above 20) · the same fault, 5 samples. Second sighting.
- 2026-10-01 · b6154cd4 · the test alone, load average 22.7, 5.0 frames a second · the same fault, 3 samples. Third sighting.
- 2026-10-01 · b6154cd4 · the test alone, 10.1 frames a second · the same fault, 2 samples. Fourth sighting. The same test passed on round 4's tour code (dad90e83) at 11.3 frames a second, and then on b6154cd4 at 9.7 frames a second. Round 5 changes nothing in chapter 2, /create or the pill. Past the third sighting, so it needs an issue; not filed from this session (#1174 round 5 note).
- 2026-10-01 · 854f84a4 · local `pocket-webkit`, the sibling play "plays through chapter 3 at 390x844", run with four other tests, 6.0 frames a second · "pill faint (dim raised) · /create · ch2", 8 samples: the same pill at the same place, caught at low opacity rather than marked as moving. Green on a rerun of the test alone on the same code (9.8 frames a second). Round 6 changes nothing in chapters 2 or 3, /create or the pill. Fifth sighting; the issue is #1184.
- 2026-10-03 · 60ada53e (!1018) · pipeline 1987 / fidelity_webkit (job 29946) · "pill moving between places (dim raised) · /create · ch2", 5 samples, 7.0 frames a second at 430x932 — same shape and the same degraded-host range as every sighting above. Sixth sighting, still #1184.
- 2026-10-04 · bc9ba29e (!1021) · pipeline 2064 / fidelity_webkit (job 31042) · "pill faint (dim raised) · /create · ch2", 6 samples, in the 24.5-minute run alongside the full acceptance stage. Seventh sighting, still #1184.
- 2026-10-04 · 0bfe9636 (!1021; its tour changes are W3's shared demo-body scaffolding, film vocabulary and veil tap blocking, none in the pill's motion) · pipeline 2079 / fidelity_webkit (job 31206) · "pill moving between places (dim raised) · /create · ch2", 4 samples, in a 23.6-minute run alongside fidelity and repair_journeys. Eighth sighting, still #1184.
- 2026-10-04 · 0d43ca97 (`dev` after !1021; the batch's tour changes are the film's own transport leak fix, not chapter 2, /create or the pill) · pipeline 2087 / fidelity_webkit (job 31334, 22.0 minutes, alongside `fidelity` and the acceptance stack on the shared runner) · the same assertion at line 671, "the pill in front and never faint; the callouts and rings where the design puts them", failed on every attempt including Playwright's in-job retry; 25 of 26 passed. First sighting in CI rather than locally; still #1174.
- 2026-10-04 · 6329566d (`dev`, the merge of !1023; no `web/` change in it) · pipeline 2098 / fidelity_webkit (job 31452) · "pill faint (dim raised) · /create · ch2", 7 samples, the page painting 6.4 frames a second at 430x932; 25 of 26 passed. Ninth sighting, still #1184.
- 2026-10-04 · harness change on `fix/1208-webkit-fidelity-wait` (82041eb4): a pill fault now counts once it has lasted 60 painted frames (moving: 180) rather than 1000ms (3000ms) of wall time. Ten runs of the test in the pinned image passed at 12 to 16 frames a second.

## tour-pocket-webkit.spec.js "suggested values give way to real text (#1174 round 4)" — at 430x932 only (#1208)

- 2026-10-03 · 60ada53e (!1018) · pipeline 1987 / fidelity_webkit (job 29946) · green: this test is not in the job's failure list at this commit.
- 2026-10-03 · 60ada53e, unchanged · local `pocket-webkit`, full project run · "add-add: #c8-cost's suggestion shows through the film's typed line". 390x844 and 360x780 passed in the same run. First local sighting.
- 2026-10-03 · 60ada53e, unchanged · local `pocket-webkit`, full project run (the app server restarted fresh, nothing in `web/build` touched this time) · the same fault, same field, same size only. Second local sighting.
- 2026-10-04 · 0bfe9636 (!1021; its tour changes are W3's shared demo-body scaffolding, film vocabulary and veil tap blocking, none in the ghost cover or #c8-cost) · pipeline 2079 / fidelity_webkit (job 31206) · "add-add: #c8-cost's suggestion shows through the film's typed line", the same field and size as both local sightings. Third sighting: filed as #1208.
- 2026-10-04 · ad005a79 (!1023, the range-fix batch; its only `web/` change is `web/tests/rolldown-repro/`, so the tour and `/create` code are byte-identical to `dev` at 0d43ca97) · pipeline 2096 / fidelity_webkit (job 31410) · "add-add: #c8-cost's suggestion shows through the film's typed line", the same field and size; 25 of 26 passed in a 21.5-minute run. Fourth sighting.
- 2026-10-04 · ad005a79, unchanged · pipeline 2096 / fidelity_webkit (job 31421, the retry of 31410) · the same fault again, 25 of 26 passed in 20.1 minutes. Fifth sighting. The same check passed twice today on the identical tour code (`dev` 0d43ca97: jobs 31293 and 31334), so this is still the flake and not batch-caused, but it is now failing about half of WebKit runs: #1208's "every run" caveat is close, and the fix for the check moves ahead of the next WebKit-heavy batch. Retried as job 31422 (outcome recorded on #1208).

Both local sightings are on the exact commit CI passed, which is the flake definition itself (fails and passes on unchanged code) rather than grounds for a third sighting's issue. A targeted diagnostic (jump to add-typing, play on to add-add, the real test's own sequence, repeated twice) measured the ghost div's box against the real `#c8-cost` input's box — identical to the sub-pixel, including the fraction — and a pixel-for-pixel compare of the field with and without its placeholder at that exact moment came back at 0 differing pixels both times: the diagnostic could not reproduce what the real test caught. The cause is likely a paint-timing race between WebKit's native placeholder and the ghost's opaque cover rather than a sizing or placement defect, but that is not established — not fixed. The third sighting is on changed code (!1021), so if the fault starts appearing on every WebKit run after the merge it is batch-caused, not this flake — #1208 carries that caveat.

- 2026-10-04 · harness change on `fix/1208-webkit-fidelity-wait` (0098575b): each typed-over field is judged from a settled frame (shot until two in a row match, at most 20) instead of 350ms after the hold. Ten isolated runs in the pinned image could not reproduce the fault before or after the change, so CI is the proof.
- 2026-10-05 · cause found, on the pre-preview batch (`217496af`, `b9a84c57`): once the second picture was itself a settled frame, the 430x932 case failed 3 of 3 on `#c8-name`, and a probe showed why: removing the placeholder of a field half off the top of the screen makes WebKit scroll the page 10 px (scroll anchoring; scrollY 475 to 485), so the second picture was of a different strip (5.92% of pixels differing; 0.0% scrolled back; the film's cover box equals the input's). The old check sometimes shot before the scroll, hence the flake. The check now restores the scroll position before each picture: 9 of 9 across the three sizes and the whole file 24 of 24 in the pinned image. Not a product fault; #1208 closes with the batch.

## v19-layout-and-themes.spec.ts:282, /household/[id] axe check — desktop-firefox

- 2026-10-03 · 594b745a (!1017) · pipeline 1999 / smoke_firefox (job 30199) · two theme packs in one run, each a real axe violation rather than a timeout: "/household/[id] in the clouds pack has no WCAG A/AA violations" reported one violation, `color-contrast` on `.zero`; "/household/[id] in the dawn pack has no WCAG A/AA violations" reported the same, `color-contrast` on `.zero`. The merged report's own outcome field marks both "expected" (its usual sign that a later attempt passed), but that later attempt's own result is not present in this job's artifact, so this entry records only the one failing attempt actually captured — not why or how it later passed, and not whether other packs or screens share the same `.zero` contrast gap without being caught. First sighting; an issue on the third.

## v19-arrival.spec.ts:290 — the newcomer never reaches /home — desktop-webkit

- 2026-10-04 · ba984c1b (!1017, the WebKit suite's first full run) · pipeline 2099 / smoke_webkit (job on the desktop-webkit project) · `toHaveURL(/\/home/)` gave up after three polls with no "Timeout" line, so the attempt ended on an error rather than the 30 s wait; the body kept class `instrument`. The in-job retry at line 164 failed too, because the first attempt had already created the newcomer's household (the spec header warns of exactly this; its screenshot shows /home). Seven local runs on desktop-webkit in the pinned Playwright image (alone, under the CI cpu cap, and with two workers beside it) all passed. First sighting; an issue on the third.

## v19-feedback-recovery.spec.ts:331 and :348 — "Expected to fail, but passed" — desktop-webkit (#1196)

- 2026-10-04 · ba984c1b (!1017) · pipeline 2099 / smoke_webkit · the two journeys marked `fail` on desktop-webkit for #1196 passed instead. Measured locally: WebKit's driver applies the `page.route` mock until the service worker controls the page and not after (route hits stayed at 1 on WebKit against 3 on Chromium), so whether the staged failure appears depends on timing. Not load. A ruling on the mark is with the owner; blocking service workers for the file was tried and exposed the #1178 disabled-button focus checks failing and passing by chance (1, 1 and 3 failures in three runs on unchanged code), so it was not kept.

## v19-administration.spec.ts:76 "household recovery on the clock (#1001) › restores a household within its window, then hard-deletes another by the two-tap protocol" — desktop-webkit

- 2026-10-05 · dac67650 (!1017) · pipeline 2131 / smoke_webkit (job 31782) · `page.evaluate: TypeError: Load failed` (WebKit's words for a fetch that did not complete) inside `createHousehold`'s in-page `fetch` at line 35, 7.2s in, straight after sign-in; the in-job retry passed (11.8s). Only the passing retry was traced, so the failing attempt's network is not recorded. Suspected, not established: the arrival at `/` navigating on to `/home` while the in-page fetch was out (support/arrival.ts describes that #840 race; this file's sign-in does not wait for it), made likelier on WebKit by the multi-second sky rasterising stall measured on #1219. First sighting; an issue on the third.

## v19-feedback-recovery.spec.ts:352 "a mail suggestion whose approval fails, on /inbox leaves focus where the reader was" — desktop-webkit

- 2026-10-05 · dac67650 (!1017) · pipeline 2131 / smoke_webkit (job 31782) · `page.goto: Navigation to "/inbox" is interrupted by another navigation to "/home"` at line 243, 6.3s in, right after `signIn(page, "/home")`; the in-job retry passed (4.1s). Only the passing retry was traced. Same suspected shape as the heading above: the arrival's own hand-on to `/home` landing after the spec's next `goto`. First sighting; an issue on the third.

## sign-in-methods.spec.ts:281 "an administrator sends a new setup link from somebody's row" — desktop-webkit (#1229)

- 2026-10-06 · 3eb5c4dc (!1032, dev -> preview; `web/` and `tests/` identical to 0ef8f497, on which pipeline 2193 ran this job green) · pipeline 2199 / smoke_webkit (job 32442) · `toContainText("Setup link sent to")` on `.adminproblem.ok` found no element within 5 s, on the attempt and the in-job retry. `:243` "an administrator adds a local user and is told where the link went" failed once in the same run and passed on retry (flaky), with a strict-mode violation: `.person` filtered on "Newcomer Lawson" resolved to 2 elements, so the earlier attempt's newcomer was still listed. Job retried as 32450. First sighting; an issue on the third.

## v19-archive.spec.ts:248 "a wrong passphrase is refused, and nothing is read" — desktop-webkit

- 2026-10-06 · 3eb5c4dc (same run and unchanged web tree as the heading above) · pipeline 2199 / smoke_webkit (job 32442) · `toHaveCount(0)` on `.c-archive .challenge` kept resolving to 1 for the whole 5 s, on the attempt (25.7 s) and the in-job retry (27.8 s): the passphrase challenge stayed on screen after the refusal. Both failing attempts were traced. First sighting; an issue on the third.

## v19-feedback-recovery.spec.ts:344 "a mail suggestion whose approval fails, on /inbox is announced, and the act can be repeated by keyboard" — mobile-webkit

- 2026-10-05 · c352cf77 (!1029: install.sh, its tests and docs; `web/` and `tests/` identical to c2d17eda, on which pipelines 2152 and 2184 ran this job green) · pipeline 2188 / smoke_webkit_mobile (job 32287) · `expect(locator).toBeVisible()` on `button[aria-label="Add Mailed renewal … to your orbit"]` gave up after 30 s at line 256, on both the attempt (33.3 s) and the in-job retry (37.7 s): the mail suggestion never appeared on /inbox. The two sibling journeys at the same line (/create, item view) passed in the same run. The job failed on this one. First sighting; an issue on the third.

## v19-feedback-recovery.spec.ts:362 "a save on /create that cannot reach Orbit leaves focus where the reader was" — mobile-webkit

- 2026-10-05 · c352cf77 (same run and same unchanged web tree as the heading above) · pipeline 2188 / smoke_webkit_mobile (job 32287) · `focus is not dropped to the page` at line 373: `focusedElement` was `body` after the staged failure was shown, 5.9 s in; the in-job retry passed (6.5 s), so Playwright counted it flaky. First sighting; an issue on the third.

## v19-feedback-recovery.spec.ts journeys, `page.goto: net::ERR_ABORTED` straight after sign-in — desktop-chromium (local) (#1221)

- 2026-10-05 · 6b57ac93 + the #1219 test changes (none reach these journeys) · local kept stack, uncapped, two workers · `:362` "a household deletion request that fails leaves focus where the reader was": `page.goto: net::ERR_ABORTED` at `/household/<id>` (line 297). First sighting.
- 2026-10-05 · same code · local, the file alone · `:344` "a save on /create that cannot reach Orbit is announced…": `net::ERR_ABORTED` at `/create`; the other ten passed. Second sighting.
- 2026-10-05 · 6b57ac93 unchanged (HEAD's copy of the file) · local, the file twice · the same `:344` failure once in 21 runs. Third sighting: filed as #1221. The symptom is the one support/arrival.ts names for the #840 race -- the arrival at `/` handing on to `/home` after the spec's next `goto` -- and `signIn` (support/signed-in.ts) does not wait for the arrival to settle; the two desktop-webkit headings above may be the same race.
