# Flakes

A flake is a check that failed and passed again on unchanged code. One heading
per flake, one line per sighting: `date · commit · pipeline/job · symptom`.
The third sighting under a heading gets an issue, linked from the heading;
fixing the cause deletes the heading in the same commit.

## availability-route.test.mjs "GET /api/auth/availability carries phase: starting straight from getBootPhase" (#869)

- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, nowhere near auth/availability) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default in a run that took 393s overall against 232s for the same file set minutes before, with unrelated files failing alongside it — wall-clock-under-load, not this test. First sighting.
- 2026-09-27 · 6420d955 (+ #1002's uncommitted desk archive card, none of it near this route; six other worktrees building in parallel on this host) · local `scripts/test-backend.sh` · timed out at the 5s default; green on an immediate rerun of the file alone (2.1s for all 6 tests). Same wall-clock-under-load shape as the check-base-image-current.test.mjs flake (#1134, since fixed); first sighting for this test.

## extraction-shortlist-recall.test.ts "countShortlistRecall over real corpus pages adds to the tallies it is given rather than replacing them"

- 2026-09-27 · 6420d955 (+ #1003's uncommitted notification-history work, nowhere near document extraction) · local `scripts/test-backend.sh`, worktree `1003-notification-history`, seven agents building in parallel on the same shared host · timed out at the 5s default in the same heavily-loaded run as the sighting above. First sighting.

## document-lifecycle.test.ts:1335 "emits a bounded rejected lifecycle record when reconciliation finds an available document's ciphertext missing" — #1404

- 2026-09-09 · 11a68e8 (+ #911's uncommitted setup-mail work, none of it near documents) · local `pnpm test:integration` · the bounded reason came back `crypto_metadata_missing` where the test expects `storage_object_missing`. The same file passed on the run immediately before, on the same code, and the run's other 39 files were green both times — so reconciliation appears to reach the two missing-piece checks in a different order under load.
- 2026-09-10 · 257d263 (+ #961's uncommitted `modelExtraction` health work, none of it near reconciliation) · local `pnpm test:integration` · failed on one run and passed on the run before it on the same code, and two later runs on the branch point without the change were green here as well. Only the four `@node-rs/argon2` files failed on every run.

## v19-keyboard.spec.ts:432 "settings: reached via the account panel"

- 2026-09-08 · af13319 · local `scripts/test-e2e-local.sh`, kept stack, 10 repeat runs · failed 2 of 10. The settings sessions list renders one "sign out of <device>" button per session and is unbounded, so on a stack reused across runs (168 sessions by the tenth) `auditTabOrder`'s 60-stop cap is exhausted, and `readSessions()` resolving after `.cards` lets rows arrive after the visibility snapshot. Likely fix shape: the `.cand` exclusion the household test already uses.
- 2026-09-20 · c463c2f · pipeline 1335 / smoke (job 17734, !958, mockups and docs only — no `web/` change) · the same test, now at `:437`, desktop-chromium. Passed on the retried job 17753 on the same commit. Second sighting.

## repair_journeys: hostile-value-privacy-negatives, "could not start the labelled container vector"

- 2026-09-09 · 9e27d38 · pipeline 822 / repair_journeys (!908) · `docker run … busybox:stable sleep 600` failed after the four journeys before it passed; the job was green on 810–815 the same morning on unchanged harness code (M7 touches nothing in `scripts/test-repair-journeys.sh`). The `docker run` sends its own output to `/dev/null` (`test-repair-journeys.sh:955-960`), so the log cannot say whether it was a Docker Hub pull failure or something else; the next sighting should show that output first.
- 2026-10-18 · 5b460996 (!1074; launcher pin and Go image only since the green c9df1a49 run, nothing the repair journeys read) · pipeline 2702 / `repair_journeys` job 37078 · same message, after the four journeys before it passed; the log does not name the docker error. Second sighting.

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

## document-lifecycle.test.ts "emits a bounded rejected lifecycle record when reconciliation finds an available document's ciphertext missing" — #1404

- 2026-09-15 · `feature/m8-addresses` · local `node scripts/test-integration.mjs` (full suite, disposable PostgreSQL 18 container) · failed once in a whole-suite run, then passed both on its own file (34/34) and on an immediate re-run of the whole suite (404 passed), on unchanged code. The failing run reported 600 ms against the file's ordinary pace.

The assertion itself was not captured, so the next sighting should record it.
Reconciliation reads the document store, and this suite shares one database
with `fileParallelism: false` — so the first thing to check is whether the
run that failed had a neighbouring file still holding or removing files under
the shared `DOCUMENTS_ROOT`, rather than anything about the record's bounds.
First sighting; no issue yet (an issue on the third, per the testing-and-ci
skill).
- 2026-10-13 · 77ff631a (`fix/1316-audit-fixes`, the frozen #1316 audit head) · local `node scripts/test-integration.mjs` (full suite) · `crypto_metadata_missing` where `storage_object_missing` was expected, at ~:1509; the next full run passed. Past the third sighting: filed as #1404.

## fidelity: `first-run-error matches its mockup (porting)` — the mockup capture drifts, the app render does not

- 2026-09-16 · 55f8e36 · pipeline 1159 / fidelity (job 14458) · 5458 of 1,600,000 pixels differ (0.3411%) against a 0.1000% budget, the other 44 tests green and the job healthy at 2.5 minutes. The diff is confined to the card's text block (x 650-948, y 330-672): the app draws "already exists here—" and the mockup "already exists here —", about a pixel apart vertically. The same screen's baseline test passed at 0 pixels in the same run, so the app render is byte-identical to what is committed and only the freshly-captured mockup moved. Job 14352 ran the full gate on this merge's own parent 1dfdee1 two hours earlier and got 13 pixels on this same test, with every other screen's count identical across the two runs — so the merge (`feature/m8-addresses`, whose only web file is a new refusal in `login/+server.js`) cannot have caused it. 13 to 5458 pixels on an unchanged app render points at text shaping in the mockup capture; the host has only ten fonts and substitutes silently, which is the first thing to check on the next sighting.

## extraction-shortlist-recall.test.ts "adds to the tallies it is given rather than replacing them" (first seen alongside a password.test.ts timeout, since fixed under #1104)

- 2026-09-18 · `fix/m9-surface-bugs` · local `pnpm run test` (whole unit suite, 270 files in parallel) · both timed out at 5000 ms in the full run, then passed together in isolation (32/32, ~4.5 s for both files) on unchanged code. The full run was under heavy load (import phase 239 s, tests 833 s), so this reads as scheduler starvation rather than anything in either test — neither file changed on this branch. First sighting of each; no issue yet (an issue on the third, per the testing-and-ci skill).

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

## v19-create.spec.ts:50 "the create form saves a real item into the orbit"

- 2026-09-22 · 4fc18a27, same session · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=8`, desktop-chromium · `expect(page).toHaveURL(/\/home$/)` at `tests/e2e/v19-create.spec.ts:69` stayed on `/create` after 5000ms instead of navigating to `/home`. Did not occur at 1, 2 or 4 workers on the same code, only at 8. First sighting; no issue yet (an issue on the third, per the testing-and-ci skill).

## v19-entry.spec.ts:99 "a signed-out visit lands in login and returns to the page it wanted"

- 2026-09-23 · 079bd351 (#1080) · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=4`, mobile-chromium · `expect(locator('.dialwrap, .mdial').visible()).toHaveCount(1)` at `tests/e2e/v19-entry.spec.ts:114` received `0` after 5000ms. The test seeds its own household a beat earlier, so there is nothing for another worker to have taken away; under four workers on a 0.6-cpu app the screen had simply not drawn inside the five seconds. Green at two workers in the run before. First sighting; an issue on the third, per the testing-and-ci skill.
- 2026-10-16 · 6f768016 (!1070, `dev` -> `preview`) · pipeline 2657 / smoke_firefox (job 36649), desktop-firefox · now at :102; failed once, passed on retry.

## v19-item-actions.spec.ts:188 "completing an item from the v19 view moves its orbit"

- 2026-09-23 · 079bd351 (#1080) · local `scripts/test-e2e-local.sh --ci-cap`, `ORBIT_E2E_WORKERS=4`, mobile-chromium · `page.waitForURL: Navigation failed because page crashed!` inside `settleArrival` (`tests/e2e/support/arrival.ts:29`). The browser process died, not an assertion: the host was carrying four chromium workers, the capped stack and other projects' containers, with 2.2Gi free of 23Gi and 10.6Gi of swap in use when the run started. Green at two workers in the run before. First sighting; an issue on the third.

## v19-screen-reader.spec.ts:356 "sign-out screen" — mobile-chromium, desktop-webkit — #1520

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

- 2026-10-16 · 6f768016 (`dev` merge of !1069; same tree as a08de7a1, whose pipeline 2650 passed this job) · pipeline 2655 / smoke_webkit (job 36622), desktop-webkit, now at :450 · failed on the first attempt AND on retry #1: after the sign-out press the page never reached `/logout`; it stayed on `/settings`, then went to `/api/auth/login?returnTo=%2Fsettings` and on to the provider's sign-in, as if /settings reloaded without a session before the goodbye took over. A different symptom from the first sighting. The settings sign-out changed in !1069 (#1439), so on the next sighting check whether /settings reloads before it navigates to /logout. Job retried as 36630.
- 2026-10-25 · 9dba0fd1 (dev, !1092 merged; hand-started for browser evidence) · pipeline 2981 / smoke (job 39403), mobile-chromium · the sign-out stopped at the provider's authorize page instead of reaching /logout; passed on the in-job retry.

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

## sign-in-methods.spec.ts:158 "a reader changes their password from the helm, inline" — desktop-chromium

- 2026-09-27 · d97cb335 (!997) · pipeline 1740 / smoke (job 25230) · `.note.ok` never showed "password changed" within 5000ms at line 190. Retried as job 25322 on the same commit: green. !997 touches only mail-in failure reasons and cannot reach the password form. First sighting; an issue on the third.
- 2026-09-30 · 6f720bed (!1005, M14 batch: 500 page, staged attachment preview, contrast fixes; none reach the password form) · pipeline 1827 / smoke (job 26687) · same failure at line 190; the in-job retry then got "the password was refused (HTTP 403)" in 3.5s, consistent with the first attempt having changed it. Job retried as 26693: green. Second sighting.
- 2026-09-30 · 977a6cba (!1006, M14 pocket-film batch: `web/src/lib/tour/*` and two pocket route files; none reach the password form) · pipeline 1832 / smoke (job 26744) · this time at line 183: the wrong-current-password `.note` ("current password") never appeared within 5000ms, element not found. Playwright's in-job retry passed (reported `1 flaky`). Third sighting: filed as #1173.
- 2026-09-30 · a2da0d64 (!1006, the commit that filed #1173; touches only this file and this doc) · pipeline 1836 / smoke (job 26825) · failed on BOTH attempts this time: first attempt (19.1s) timed out waiting for `.note.ok` "password changed" at line 190; the in-job retry (4.3s) then failed differently, with "the password was refused (HTTP 403)" at `tests/e2e/support/local-credentials.ts:76` -- the first attempt's save had gone through for real, and the retry's own setup could no longer prove the account's old password. Fourth sighting. Root cause found: the save is one HTTP round trip that the UI's note waits on regardless of how long it takes (two Argon2id derivations plus ending every other session), so the fixed 5000ms wait was racing the response rather than answering it -- and the `finally` cleanup raced the still-in-flight first save the same way, leaving the account's password in whichever state finished last. Fixed by waiting on the save's own network response (`page.waitForResponse`) before asserting the note, and by only running the cleanup once that response is known to have succeeded. Reproduced by hand with a temporary 6s delay injected into the password route: the old test failed identically on both attempts (line 183, matching the third sighting); the fixed test passed every time under the same injected delay. Closed by #1173.

## sign-in-methods.spec.ts:129, :162 and v19-axe-sweep.spec.ts:372, /settings never draws its cards — desktop-webkit (#1195)

- 2026-10-03 · 58dec64f (!1017) · pipeline 2005 / smoke_webkit (job 30263) · three in one run, all the `.cards`-never-renders shape #1195 already names: `:129` "the helm lists the sign-in methods an account actually has" and `:162` "a reader changes their password from the helm, inline" each timed out in `openSettings` (`expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 })`, line 121) on both their attempts; `v19-axe-sweep.spec.ts:372`'s `/settings` case instead hung inside axe's own `.analyze()` for the full 60000ms test timeout on attempt 1, then hit "Target page, context or browser has been closed" on retry -- a hang rather than the quick element-not-found the other two show, but on the one screen #1195 already says draws broken. `:129` and `v19-axe-sweep.spec.ts:372`'s `/settings` case both already carry `test.fail(test.info().project.name === "desktop-webkit", ...)` from 00e44355, yet both are in this job's own failed-test list rather than reported as expected failures; `:162` carries no such marker at all. Not established here why the existing markers did not keep these out of the failure count, or whether #1195 is the whole explanation for the axe hang rather than a contributing one -- both worth the next sighting's attention. Not treated as a fresh flake needing its own issue: the cause is already #1195's.

## v19-explore-search.spec.ts:314 "clicking the note line's add act, at rest, opens /create" — desktop-chromium

- 2026-09-30 · 6f720bed (!1005, none of it in the search strip) · pipeline 1827 / smoke (job 26687) · `#strip-note .act` "add an item" resolved but stayed hidden for 5000ms; Playwright's in-job retry passed in 3.7s. First sighting.

## v19-explore-search.spec.ts, five tests in one run — desktop-webkit

- 2026-10-03 · 58dec64f (!1017) · pipeline 2005 / smoke_webkit (job 30263) · five tests in the same file and run, each an element or count that should appear after typing into `#explore` not showing within its 5000ms: `:161` "typing in #explore filters the results by title, section and provider" -- `#explore-results` never contained "Kwik-Fit MOT proving" (failed on both attempts); `:230` "#strip never draws below the field, even on a short viewport" -- `#strip` stayed `hidden` (passed on retry, 16.7s); `:260` "ArrowRight steps the strip's selection and Enter opens the selected entry" -- `#explore-results li` stayed at 0 of an expected 2 (passed on retry); `:284` "hovering a mark selects it" -- `#strip .match` stayed at 0 of an expected 2 (passed on retry); `:314` "clicking the note line's add act, at rest, opens /create" -- `#strip-note .act` "add an item" stayed `hidden` on attempt 1, and the retry was interrupted by the job's own `maxFailures` cutoff rather than failing on its own account. One sighting here covers all five rather than five headings, since they share one shape (search results not appearing in time) in one run; first sighting on desktop-webkit. `:314` has one earlier desktop-chromium sighting above with the identical locator and symptom (2026-09-30, pipeline 1827) -- not combined with this one, different engine. An issue on the third sighting of any of these on desktop-webkit.
- 2026-10-03 · 6ce69cf0 (!1017) · pipeline 2011 / smoke_webkit (job 30393) · `:296` "hovering a mark selects it" -- `#strip .match` stayed at 0 of an expected 2 for 5000ms, then passed on the in-job retry (12.8s). Second sighting of this one. The other four from the first line now carry `test.fail` under #1197 (the strip not opening on desktop Safari at all) and fail consistently rather than by chance -- `:161`, `:236`, `:269` held in pipelines 2009 and 2011, and `:326` (the add act hidden on both attempts here) was marked after this run. This hover test is the one that keeps passing on retry, so it stays unmarked and recorded here.

## backup-restore-cli.test.ts:337 "refuses (capacity-insufficient) before ever calling confirm(), when the document volume has no room"

- 2026-09-27 · 6420d955 (+ #1069's uncommitted desk-create work, nowhere near backup/restore) · local `scripts/test-backend.sh`, seven worktrees running it at once · `Error: Test timed out in 5000ms`, alongside the sighting below in the same file. The whole file passed alone immediately after on the same code — 24 of 24, the two above included, 60s total — so it is the 5s default under a very loaded host, not the test. First sighting.

## backup-restore-cli.test.ts:362 "refuses (restore-not-confirmed) and takes no checkpoint when confirm() returns false, only after preflight/capacity already passed"

- 2026-09-27 · 6420d955 (+ #1069's uncommitted desk-create work, nowhere near backup/restore) · local `scripts/test-backend.sh`, seven worktrees running it at once · `Error: Test timed out in 5000ms`, alongside the sighting above in the same file. Same rerun, same result: green alone. First sighting.

## pocket-measure.spec.js:540 "/home · film-create meets the pocket floors" — pocket-measure, 390x664

- 2026-09-30 · 0135f516 (!1006, the batch that built this film chapter) · pipeline 1855 / fidelity (job 27168) · `page.waitForFunction` hit the 60000ms test timeout. The same test passed on pipeline 1836 (same film code), and the job retried as 27270 on the same commit was green. First sighting; an issue on the third.

## v19-layout-and-themes.spec.ts:282, /household/[id] axe check — desktop-firefox, desktop-chromium — #1307 — quarantined 2026-10-16 (agent-infra#30)

- 2026-10-03 · 594b745a (!1017) · pipeline 1999 / smoke_firefox (job 30199) · two theme packs in one run, each a real axe violation rather than a timeout: "/household/[id] in the clouds pack has no WCAG A/AA violations" reported one violation, `color-contrast` on `.zero`; "/household/[id] in the dawn pack has no WCAG A/AA violations" reported the same, `color-contrast` on `.zero`. The merged report's own outcome field marks both "expected" (its usual sign that a later attempt passed), but that later attempt's own result is not present in this job's artifact, so this entry records only the one failing attempt actually captured — not why or how it later passed, and not whether other packs or screens share the same `.zero` contrast gap without being caught. First sighting; an issue on the third.
- 2026-10-07 · 5a12b2bd (!1043; nothing on /household) · pipeline 2233 / smoke (job 33111, desktop-chromium) · "/household/[id] in the clouds pack" and "… in the dawn pack" each failed once and passed on the in-job retry. The rule is not in the output, because a passing retry prints no detail. Second sighting.
- 2026-10-07 · the same batch plus its pipeline fixes, uncommitted · local `test-e2e-local.sh`, desktop-chromium · the same two tests, the same shape: failed once, passed on retry. Third sighting: filed as #1307.
- 2026-10-07 · 68040844 (!1043; the repair-journeys fixture only) · pipeline 2236 / smoke (job 33177, desktop-chromium) · "/household/[id] in the clouds pack" and "… in the dawn pack" failed once each and passed on retry, as before. Still #1307.

## v19-layout-and-themes.spec.ts:288, /settings/mail axe check in the retrograde pack — desktop-firefox

- 2026-10-15 · 0a2cec29 (dev, !1067 merged) · dev pipeline 2628 / smoke_firefox (job 36379) · "/settings/mail in the retrograde pack has no WCAG A/AA violations" failed its first attempt and passed on the in-job retry. The same parametrised axe check as #1307, on another screen. First sighting.

## v19-arrival.spec.ts:290 — the newcomer never reaches /home — desktop-webkit

- 2026-10-04 · ba984c1b (!1017, the WebKit suite's first full run) · pipeline 2099 / smoke_webkit (job on the desktop-webkit project) · `toHaveURL(/\/home/)` gave up after three polls with no "Timeout" line, so the attempt ended on an error rather than the 30 s wait; the body kept class `instrument`. The in-job retry at line 164 failed too, because the first attempt had already created the newcomer's household (the spec header warns of exactly this; its screenshot shows /home). Seven local runs on desktop-webkit in the pinned Playwright image (alone, under the CI cpu cap, and with two workers beside it) all passed. First sighting; an issue on the third.

## v19-administration.spec.ts:77 "household recovery on the clock (#1001) › restores a household within its window, then hard-deletes another by the two-tap protocol" — desktop-webkit, mobile-webkit — #1448 — quarantined 2026-10-16 (agent-infra#30)

- 2026-10-05 · dac67650 (!1017) · pipeline 2131 / smoke_webkit (job 31782) · `page.evaluate: TypeError: Load failed` (WebKit's words for a fetch that did not complete) inside `createHousehold`'s in-page `fetch` at line 35, 7.2s in, straight after sign-in; the in-job retry passed (11.8s). Only the passing retry was traced, so the failing attempt's network is not recorded. Suspected, not established: the arrival at `/` navigating on to `/home` while the in-page fetch was out (support/arrival.ts describes that #840 race; this file's sign-in does not wait for it), made likelier on WebKit by the multi-second sky rasterising stall measured on #1219. First sighting; an issue on the third.
- 2026-10-08 · 89ca8357 (`fix/door-site-whole`, the door batch; nothing in it touches administration) · local `scripts/test-e2e-local.sh --project desktop-webkit`, the whole suite inside the CI Playwright image, with other sessions using the host · `page.evaluate: TypeError: Load failed` in the spec's seeding fetch; green on the rerun of the file alone against a fresh stack on 64a4ad67 (same administration code). Second sighting (the first is above, same words, in CI).
- 2026-10-16 · a08de7a1 (!1069, v0.3 security batch) · pipeline 2650 / smoke_webkit_mobile (job 36592), mobile-webkit · failed once, passed on retry.

## settings-notification-history.spec.ts:137 "a member sees their own last sent reminders, plainly, on both dialects" — desktop-firefox

- 2026-10-09 · 11e0e1c4 (#1325; the spec's only change there is its seed payload) · pipeline 2277 / smoke_firefox (job 33640) · `getByRole('tabpanel', { name: 'sent to you lately' })` not visible in 5 s after the tab click; passed on the in-job retry. First sighting.

## v19-archive.spec.ts:262 "a wrong passphrase is refused, and nothing is read" on desktop-webkit (#1233)

- 2026-10-06 · 4bb20449 (dev, !1035 merged) · local full suite, both WebKit projects, inside CI's Playwright image (#1235), local worker count · `page.waitForResponse: Timeout 30000ms exceeded` on the slow POST; the same test passed in a five-file targeted run minutes earlier and in a second full desktop-webkit run an hour later. Error context lost to a later run clearing `test-results/`.
- 2026-10-08 · 24866e53 (door batch, !1044) · CI pipeline 2248 `smoke_firefox`, desktop-firefox · failed once, passed on retry: the same test on a second browser.
- 2026-10-08 · 91df467a (door batch, !1044) · CI pipeline 2254 `smoke_webkit` · failed once, passed on retry.
- 2026-10-15 · a6168fe6 (!1069, v0.3 security batch) · pipeline 2640 / smoke_webkit (job 36460) · `#1253: the menu is still open after sign-out started` at line 303 (the menu layer still visible after 2 s); passed on the in-job retry. Second sighting.
- 2026-10-10 · a318e11b (#1342 batch) · pipeline 2382 `smoke_firefox` (job 34367) · failed both attempts, and once in three local desktop-firefox runs after the worker fix. Cause found: the sign-in-again challenge opened on the busy screen, then moved to the form once GET /api/auth/methods answered, rebuilding its password field under Playwright's fill (the trace shows the field empty and the button disabled). Fixed with tests/unit/archive-challenge-opens-once.test.mjs; four local runs green after.

## web/tests/fidelity screens.spec.js "household"

- 2026-10-06 · f3e61aeb (#1248, #1251; neither touches the household screen) · local `pnpm --filter orbit-web fidelity` · drifted 0.1109% once, passed on the next run on the same code. First sighting.

## v19-archive.spec.ts:192 "write an archive, then bring it into a second household — a clash stays out" on desktop-webkit

- 2026-10-08 · 24866e53 (door batch, !1044) · CI pipeline 2248 `smoke_webkit` · failed once (49.6s), passed on retry. First sighting.

## sign-out-descent.spec.ts:195 "sign out from home's menu reaches the dusk (phone-narrow, as the browser is)" on desktop-webkit — #1505

- 2026-10-08 · 24866e53 (door batch, !1044) · CI pipeline 2248 `smoke_webkit` · failed once (10.4s), passed on retry. First sighting.
- 2026-10-14 · 465eca6b (door branch, !1066) · pipeline 2588 / smoke_webkit (job 36178) · "(phone-narrow, world forced)" at line 193, desktop-webkit, failed once and passed on retry.
- 2026-10-22 · 77ffcabb (`preview` push of v0.3.1, same tree as 5635d9f3) · pipeline 2908 / smoke_webkit (job 38686) · failed once, passed on retry. Third sighting: filed as #1505.

## bootstrap-protection.spec.ts:387 "once the instance is claimed the code is spent, cookie or no cookie" — [unclaimed]

- 2026-10-08 · 059878f1 (#1325, which touches no sign-in code) · local `scripts/test-e2e-local.sh --spec 'tests/e2e/v19-(home-drawer|create|item-actions|mail-review)\.spec\.ts'` · `expect(session.ok()).toBe(true)` at `tests/e2e/support/bootstrap.ts:112` (`claimInstanceAsAdministrator`): `/api/auth/session` was not OK straight after the claim's sign-in. Every project depends on `[unclaimed]`, so 141 tests did not run. The next run of the same command on the same commit passed it. Traces: `~/projects/.backups/orbit/e2e-orbit-e2e-local-ecd11949-2436667-20261008-222859`. First sighting.

## v19-keyboard.spec.ts:313 "arrive: the sign-in door opens by Tab and Enter alone" on desktop-chromium

- 2026-10-09 · 79c68846 (#1319 stage 3b; this test unchanged on the branch) · local `scripts/test-e2e-local.sh --keep --project desktop-chromium`, whole suite, with the fidelity suite running alongside · `page.goto: net::ERR_ABORTED` on `/home` at line 328. Passed on a rerun of the file against the same stack. Traces: `~/projects/.backups/orbit/e2e-1319-stage3b-79c68846-desktop-chromium`. First sighting.
- 2026-10-16 · 7264f015 (`dev` after !1073, which touches test tooling and scripts only; this test now at line 315) · pipeline 2674 / smoke (job 36868, !1072) · first attempt: signed out, `/home` landed on the test identity provider's `/authorize` page instead of Orbit's `/login?returnTo=%2Fhome` (`toHaveURL` at line 331); retry #1: `page.goto: net::ERR_ABORTED` on `/home` at line 330, as the first sighting. 392 others passed. Job retried as 36881. Second sighting.

## v19-home-drawer.spec.ts:212 "on the desk › the dial's documents chip opens the item's drawer at its real documents" (desktop-webkit)

- 2026-10-09 · 52e9f358 · local `scripts/test-e2e-local.sh --spec tests/e2e/v19-home-drawer.spec.ts`, all projects · `.callout.show .chip` never appeared within 5s after `dispatchEvent("mouseenter")` on the dial body, desktop-webkit only (the other desk projects green). Green on an immediate rerun of the spec on desktop-webkit alone, same commit. First sighting.

## belt-endcap-controls.spec.js:68 "an end-cap press is the arrow key's press at 1600x1000"

- 2026-10-09 · dad77c25 (#1325 rebased onto dev; the tree differs from pipeline 2287's green 8170fecb only in design files, an ADR, this log and one e2e spec) · pipeline 2290 / fidelity (job 33718) · `ArrowRight did not come back`; the same test passed at 390x844 in the same run. 45/45 locally with `--repeat-each=5` on the same commit; job retried as 33765. First sighting.

## pocket-measure.spec.js:551 "/home · row-… meets the pocket floors" — `openRow`'s tap never opens the panel (row-retire-armed at 390x664, row-snooze at 360x640) (#1376) — quarantined 2026-10-16 (agent-infra#30)

- 2026-10-09 · abcb06f1 · pipeline 2301 / fidelity (job 33822) · `openRow`'s tap on Car MOT's face never opened its panel (`locator.waitFor` ran to the 60 s test timeout), after `go()` had already waited for `body[data-home-ready]`; 487 others passed. Locally in the pinned image on 6afb412e: 20 repeats alone, then every `/home · row-` state 15 times over 4 workers (420 runs), all green. First sighting.
- 2026-10-10 · cd964294 (!1052; since 8b9bf878, whose fidelity job 34065 passed, only e2e specs and one unit test changed) · pipeline 2341 / fidelity (job 34107) · row-snooze at 360x640, the same wait at `pocket-states.js:61` for Car MOT's opened panel ran to the 60 s test timeout; 487 others passed. Retried as job 34122. Second sighting.

- 2026-10-10 · d80cf61b (!1054) · pipeline 2392 / fidelity (job 34627) · "/home · document-preview meets the pocket floors" at 390x664, the same wait at `pocket-states.js:61` for Car MOT's opened panel ran to the 60 s timeout; 487 others passed. Third sighting: filed as #1376.
- 2026-10-10 · e0d5d796 (`dev`, merge of !1057; its head 327d32c1 passed fidelity in pipeline 2440, and the merge adds only `scripts/install.sh`, its test and `scripts/ci/repin-base-image.sh`) · pipeline 2461 / fidelity (job 35271) · "/home · row-complete meets the pocket floors" at 390x664, `locator.waitFor` ran to the 60 s test timeout; 487 of 488 passed.
- 2026-10-14 · 00987a9d (door branch, !1066) · pipeline 2590 / fidelity (job 36196) · `pocket-measure.spec.js:544` "pocket measurement at 390x664 › /home · row-open meets the pocket floors" — `locator.waitFor: Test timeout of 60000ms exceeded`; 487 others passed. Diff since pipeline 2588 (where it passed) is an e2e keyboard spec and docs only; job retried as 36215.
- 2026-10-16 · 614118ff (!1069; one e2e spec and this file changed since pipeline 2645, where fidelity passed) · pipeline 2649 / fidelity (job 36559) · "pocket measurement at 360x640 › /home · row-edit": `openRow` tapped the Car MOT row and the panel never opened (`locator.waitFor: Test timeout of 60000ms exceeded`); 487 others passed. Retried as 36573.

## install-orchestrator.test.ts "runInstall: success > installs a pre-provisioned target unattended: assets from the image, secrets, migration, digest (#6, #42, #45, #53)"

- 2026-10-09 · 40850119 (+ #1333's uncommitted validation work, none of it near install) · local `scripts/test-backend.sh`, worktree `1333`, with a PostgreSQL integration run going on the same shared host · failed after 7.3s (the only failure besides one test #1333 itself changed); the assertion text was not captured. Passed when the file was run alone straight after, and in a full `scripts/test-backend.sh` rerun on the same code. First sighting.
- 2026-10-09 · 73481e5e (#1345) · local scripts/test-backend.sh under parallel load · 5–7 s timeout; passed alone and on rerun
- 2026-10-09 · 3d6d7c20 (#1349) · local scripts/test-backend.sh under parallel load · 5–7 s timeout; passed alone and on rerun
- Third sighting: filed as #1365 (unattended-install case times out under host load).

## v19-tour-chapter-add.test.mjs

- 2026-10-09 · 73481e5e (#1345) · local scripts/test-backend.sh under parallel load · 5–7 s timeout; passed alone and on rerun

## notification-worker-health.test.ts

- 2026-10-09 · 3d6d7c20 (#1349) · local scripts/test-backend.sh under parallel load · 5–7 s timeout; passed alone and on rerun
- Third sighting: filed as #1365 (unattended-install case times out under host load).

## v19-keyboard-pocket.spec.ts:411 "item page (pocket): actions and the back link work by keyboard" — mobile-webkit

- 2026-10-09 · 1e0299ab (!1050) · pipeline 2313 / smoke_webkit_mobile (job 33924) · `Tab never reached the requested control within 60 presses`; after the reschedule save, focus went to `body` past the pills. Failed on both attempts. Passed in jobs 33895 and 33901 on the same commit, in 33925, and locally. The /item page is retired by #1319 (merged in 51d9a8ef), so this spec goes with it. First sighting.

## desk-phone-small-drifts.test.mjs

- 2026-10-10 · b929a182 (#1329) · local scripts/test-backend.sh under parallel load · 5 s timeout on the dynamic import in "burnsInOf, the phone's"; passed alone and on rerun

## v19-screen-reader.spec.ts:347 "/administration" — mobile-chromium

- 2026-10-10 · d80cf61b (!1054) · pipeline 2392 / smoke (job 34442) · failed after 15.8 s on the first attempt; the job was cut off by the 30-minute limit before the retry or any error text. Passed locally on mobile-chromium, and 1.1 s on pipeline 2382.

## v19-home-drawer.spec.ts:241 "a document opens its preview beside the drawer; the page opens the reader; Escape walks back" — desktop-chromium

- 2026-10-10 · 65e369b5 (!1057) · local `scripts/test-e2e-local.sh --ci-cap --reuse`, 6 runs of the spec · failed once in 9.2 s with `apiRequestContext.get: socket hang up`; passed on the other five. First sighting.

## v19-keyboard-pocket.spec.ts:438 "item drawer (pocket): opened from the dial by keyboard, is fully reachable" — mobile-webkit, mobile-chromium — #1381 — quarantined 2026-10-16 (agent-infra#30)

- 2026-10-10 · 327d32c1 (!1057; app code identical to 65e369b5, whose pipeline 2430 passed this job) · pipeline 2440 / smoke_webkit_mobile (job 34934) · `auditTabOrder`: `Tab reached a control the screen does not show as visible` for the drawer's Snooze, Complete, Attach, Retire, Edit and Copy link buttons, on the first attempt and the in-job retry.
- 2026-10-10 · 327d32c1 (!1057) · pipeline 2440 / smoke_webkit_mobile (job 35081, the first re-run) · the same audit message on the first attempt; passed on the in-job retry.
- 2026-10-10 · 327d32c1 (!1057) · pipeline 2440 / smoke_webkit_mobile (job 35145, the second re-run) · failed its first attempt, passed on the in-job retry. Third sighting: filed as #1381.
- 2026-10-13 · 5e852f6f (!1064, a flake-log line on top of 9232c92c, whose pipeline 2559 passed this job) · pipeline 2560 / smoke_webkit_mobile (job 36008), in a pipeline slowed by a GitLab update · `auditTabOrder` failed at line 442.
- 2026-10-13 · 5e852f6f (!1064) · pipeline 2560 / smoke_webkit_mobile (job 36018, the second re-run; the job passed) · `Tab reached a control the screen does not show as visible`; passed on the in-job retry.
- 2026-10-13 · 3a297cc8 (!1065, #1316 audit fixes) · pipeline 2570 / smoke_webkit_mobile (job 36070) · `home (pocket) with the item drawer open` audit failed on the first attempt and the in-job retry, so the job failed. Still #1381.
- 2026-10-13 · 6a06e88d (!1065) · pipeline 2574 / smoke_webkit_mobile (job 36101), mobile-webkit · failed its first attempt, passed on the in-job retry. Still #1381.
- 2026-10-15 · 1c636dbd (!1069, v0.3 security batch with follow-ups) · pipeline 2643 / smoke_webkit_mobile (job 36492), mobile-webkit · `Error: home (pocket) with the item drawer open`: `Tab reached a control the screen does not show as visible` for the drawer's Snooze, Complete, Attach, Retire, Edit and Copy link buttons (`support/keyboard.ts:322`); passed on the in-job retry. Still #1381.
- 2026-10-16 · 6f768016 (!1070, `dev` -> `preview`) · pipeline 2657 / smoke (job 36648), mobile-chromium · failed once, passed on retry.

## v19-document-preview.spec.ts:401 "the preview's pager turns a multi-page document in place, and the reader opens on its page" — mobile-webkit, desktop-webkit — #1501

- 2026-10-10 · 327d32c1 (!1057; app code identical to 65e369b5, whose pipeline 2430 passed this job) · pipeline 2440 / smoke_webkit_mobile (job 34934) · failed its first attempt (9.0 s), passed on the in-job retry (13.5 s). First sighting.
- 2026-10-16 · a08de7a1 (!1069, v0.3 security batch) · pipeline 2650 / smoke_webkit (job 36591), desktop-webkit · now at :401: failed once, passed on retry.
- 2026-10-22 · 5635d9f3 (!1084, `dev` -> `preview` for v0.3.1; same product code as a98c6f88, whose pipeline 2889 passed this job) · pipeline 2901 / smoke_webkit (job 38636), desktop-webkit · failed every attempt: at :423 the image stayed "Page one of pager-proving.pdf" where "Page 2" was expected (20 s). Third sighting: filed as #1501. Job retried as 38651.
- 2026-10-25 · 9dba0fd1 (dev, !1092 merged; hand-started for browser evidence) · pipeline 2981 / smoke (job 39403), desktop-chromium · page 3 never reached: `Page 2 of pager-proving.pdf` after 20 s; passed on the in-job retry. First sighting on Chromium.

## v19-upload-limit.spec.ts:76 "an administrator lowers the upload limit, an over-limit upload is refused, and the default comes back" — desktop-chromium

- 2026-10-13 · 3a297cc8 (!1065) · pipeline 2570 / smoke (job 36067) · failed its first attempt in 1.5 s, passed on the in-job retry. First sighting.

## v19-tour.spec.ts:170 "a first-time reader gets the film, works its transport, and a second arrival stays silent" — desktop-webkit

- 2026-10-13 · 3a297cc8 (!1065) · pipeline 2570 / smoke_webkit (job 36069) · failed its first attempt in 3.4 s, passed on the in-job retry. First sighting.

## v19-administration.spec.ts:146 "document jobs and the two mail tests (#1071) › the relay test's pill and reason ..." — desktop-firefox

- 2026-10-13 · 6a06e88d (!1065) · pipeline 2574 / smoke_firefox (job 36099) · failed its first attempt, passed on the in-job retry. First sighting.

## v19-mail-review.spec.ts:398 "the desk reads a staged paper's page one, from the suggestion's drawer and from the inbox ..." — desktop-firefox

- 2026-10-13 · 6a06e88d (!1065) · pipeline 2574 / smoke_firefox (job 36099) · failed its first attempt, passed on the in-job retry. First sighting.
- 2026-10-22 · 77ffcabb (`preview` push of v0.3.1, same tree as 5635d9f3) · pipeline 2908 / smoke_firefox (job 38685) · failed once, passed on retry. Second sighting.

## v19-mail-review.spec.ts:431 "the phone sheet reads a staged paper's page one, and tells a gone mail apart from one it just cannot draw (#1155)" — mobile-webkit, marked expected-to-fail for #1196

- 2026-10-13 · 5e852f6f (!1064; the same app code passed this job on pipeline 2559, where the test failed as expected) · pipeline 2560 / smoke_webkit_mobile (job 36017, the first re-run) · "Expected to fail, but passed", on the first attempt and the in-job retry: the #1196 driver fault it is marked for does not happen every run. First sighting.

## v19-keyboard.spec.ts:314 "arrive: the sign-in door opens by Tab and Enter alone" — desktop-chromium, `net::ERR_ABORTED` on /home (the #1096 symptom, after its fix)

- 2026-10-14 · 0c6e60bf · local `scripts/test-e2e-local.sh` full run, 2 workers, stopped at 681/1413 under host load · `page.goto: net::ERR_ABORTED at http://127.0.0.1:<port>/home` after 1.9s. Passed alone on the same code and a fresh stack (`--reuse … --project desktop-chromium --spec tests/e2e/v19-keyboard.spec.ts:314`, 3.7s). #1096's fix reasoned from `workers: 1`; this run had 2. First sighting.

## v19-create.spec.ts:399 "the quick add's box takes a document by click or by drop, and opens the full form with it" — desktop-firefox, `socket hang up`

- 2026-10-14 · 0c6e60bf · local `scripts/test-e2e-local.sh` full run, 2 workers, stopped at 681/1413 under host load · `apiRequestContext.get: socket hang up` on `GET /api/auth/session` from the household-cleanup helper, after 9.9s. Passed alone on the same code and a fresh stack (`--reuse … --project desktop-firefox --spec tests/e2e/v19-create.spec.ts:399`, 9.7s). First sighting.

## GitLab outage during artifact transfer (502 / connection refused)

- 2026-10-15 · a6168fe6 (!1069, v0.3 security batch) · pipeline 2640 / acceptance and repair_journeys (jobs 36463 and 36464), 20:46-20:54 UTC · both failed while moving artifacts, GitLab answering 502 or refusing connections; both passed on retry (jobs 36469 and 36470) with no change. First sighting.

## v19-document-preview.spec.ts:370 "a one-page document's reader says "one page" and has no arrows" — desktop-webkit, desktop-chromium — #1503

- 2026-10-15 · 1c636dbd (!1069, v0.3 security batch with follow-ups) · pipeline 2643 / smoke_webkit (job 36491), desktop-webkit · failed its first attempt (20.1 s), passed on the in-job retry. No error text printed: the job was cut off at its 30-minute timeout before the report. First sighting.
- 2026-10-16 · 6f768016 (!1070, `dev` -> `preview`) · pipeline 2657 / smoke_webkit (job 36650), desktop-webkit · now at :370; failed once, passed on retry.
- 2026-10-22 · 5635d9f3 (!1084, `dev` -> `preview` for v0.3.1; same product code as a98c6f88, whose pipeline 2889 passed this job) · pipeline 2901 / smoke_webkit (job 38636), desktop-webkit · failed once, passed on retry. Third sighting: filed as #1503.
- 2026-10-22 · 77ffcabb (`preview` push of v0.3.1, same tree as 5635d9f3) · pipeline 2908 / smoke (job 38684), desktop-chromium · failed once, passed on retry. Now seen on Chromium too.
- 2026-10-25 · 9dba0fd1 (dev, !1092 merged; hand-started for browser evidence) · pipeline 2981 / smoke_firefox (job 39404), desktop-firefox · the reader's page count empty after 5 s (`"one page"` expected); passed on the in-job retry.

## v19-create.spec.ts:207 "a document picked on the create form is attached to the saved item" — desktop-webkit

- 2026-10-15 · 1c636dbd (!1069, v0.3 security batch with follow-ups) · pipeline 2643 / smoke_webkit (job 36491), desktop-webkit · failed its first attempt (9.8 s), passed on the in-job retry. No error text printed: the job was cut off at its 30-minute timeout before the report. First sighting.

## v19-screen-reader.spec.ts:312 "/household/[id]" — desktop-webkit

- 2026-10-15 · 1c636dbd (!1069, v0.3 security batch with follow-ups) · pipeline 2643 / smoke_webkit (job 36491), desktop-webkit · failed its first attempt (1.8 s); the live log shows the in-job retry passing (3.1 s). No error text printed: the job was cut off at its 30-minute timeout before the report. First sighting.

## v19-create.spec.ts:1022 "the desk's lane offers 'not this one' while it is still reading, and pressing it closes the lane" — desktop-webkit

- 2026-10-16 · a08de7a1 (!1069, v0.3 security batch) · pipeline 2650 / smoke_webkit (job 36591), desktop-webkit · failed once, passed on retry. First sighting; an issue on the third.

## v19-about-loading.spec.ts:69 "a slow click on About shows that it is loading before the content arrives" — desktop-webkit, mobile-webkit — #1502

- 2026-10-18 · 5bfff8b6 (!1074, the branch that adds this test) · pipeline 2688 / `smoke_webkit` job 36975 · no loading sign (`aria-busy`, progress bar, a "loading" status or text) appeared within 10 s while the About data request was held; passed on its retry in the same job (11.1 s). The same run was loaded enough that one wheel scroll landed over a second late (#1472 note 40486). First sighting.
- 2026-10-18 · c9df1a49 (!1074) · pipeline 2691 / `smoke_webkit_mobile` job 37001, mobile-webkit · failed once, passed on retry. Second sighting, two pipelines in a row; the test is new on this branch.
- 2026-10-22 · 5635d9f3 (!1084, `dev` -> `preview` for v0.3.1; same product code as a98c6f88, whose pipeline 2889 passed this job) · pipeline 2901 / smoke_webkit (job 38636), desktop-webkit · failed once, passed on retry. Third sighting: filed as #1502.
- 2026-10-25 · 9dba0fd1 (dev, !1092 merged; hand-started for browser evidence) · pipeline 2981 / smoke_webkit_mobile (job 39406), mobile-webkit · the loading state not visible within 10 s; passed on the in-job retry.

## v19-document-preview.spec.ts:299 "the reader turns a multi-page document to its last page and back, by arrows and by keys" — desktop-webkit, mobile-webkit — #1501

- 2026-10-18 · c9df1a49 (!1074, no document-preview change) · pipeline 2691 / `smoke_webkit` job 37000 · failed once, passed on retry. First sighting.
- 2026-10-22 · 5635d9f3 (!1084, `dev` -> `preview` for v0.3.1; same product code as a98c6f88, whose pipeline 2889 passed this job) · pipeline 2901 / smoke_webkit (job 38636), desktop-webkit · failed once, passed on retry. Second sighting.
- 2026-10-22 · 77ffcabb (`preview` push of v0.3.1, same tree as 5635d9f3) · pipeline 2908 / smoke_webkit (job 38686) and smoke_webkit_mobile (job 38687) · failed once in each, passed on retry. Third sighting: same family as #1501, fixed with it.

## preview.test.ts:760 "renderDocumentPagePreview > the page is drawn in the sandbox, never on the server's own thread (#1427) > draws a 300 dpi A4 scan to a PNG of the page's shape"

- 2026-10-20 · 0469e455 (the accepted v0.3.0 commit, unchanged since preview pipeline 2677 passed every job first time) · pipeline 2774 / fast (job 37576), the stable-promotion run on `main`, with the !1078 pipeline and five local agent stacks on the same host · `Orbit could not draw a picture of this document` from the sandboxed renderer, in a 449 s `fast` run. Retried as job 37634. First sighting.
- 2026-10-22 · 2b120e89 (signing-image re-pin and cosign bump only since the green bea1293c run; nothing near documents) · local `scripts/test-backend.sh`, worktree `v031-parts`, while a base-image rebuild ran on the same host · same message, in a 919 s run; the file alone passed at once (40.9 s with the test below). Second sighting.

## validation.test.ts "structural document classification > classifies unsupported %PDF-1.7 ... as unsupported_structure"

- 2026-10-20 · 0469e455 · pipeline 2774 / fast (job 37576), same run as the sighting above · timed out at the 5 s default. Wall-clock-under-load shape. First sighting.

## sign-out-descent.spec.ts:195 "sign out from home's menu reaches the dusk (narrow desk, as the browser is)" and "(wide desk, as the browser is)" on desktop-webkit

- 2026-10-21 · 8a841e3c (!1074) · pipeline 2833 / `smoke_webkit` job 38057 · both cases failed first and passed on Playwright's retry in the same run ("2 flaky"), which fails the job; green on pipeline 2834 (b331397f, installer-only change, nothing under `web/`). First sighting.

## settings-text-size-tab-stop.test.mjs:128 "settings, phone layout: the text size tab stop starts on the applied step > with standard applied, the one tab stop is the ticked tile"

- 2026-10-22 · 2b120e89 (nothing near settings since the green bea1293c run) · local `scripts/test-backend.sh`, same 919 s run as preview.test.ts:760's second sighting · timed out at the 5 s default; the file alone passed at once. Wall-clock-under-load shape. First sighting.

## build_image: Corepack could not download the pnpm binary from registry.npmjs.org

- 2026-10-22 · 39134f33 (!1081) · pipeline 2875 / `build_image` job 38351 · `Could not download the pnpm 12.4.1 binary: Could not reach https://registry.npmjs.org/@pnpm/exe.linux-x64-musl/12.4.1: timed out after 30s` in the `web-deploy.sh` step, a minute after the `deps` stage of the same build, on the same base image, had fetched pnpm 12.4.1 fine. Retried. First sighting.

## mail-relay-sender-check-failures.test.ts "finding 1: a mailer that never answers > ends the request at the send deadline (shortened to 300 ms here) with a stable 503"

- 2026-10-22 · 2f16facd (!1081; browser-test and flakes-log changes only since the green 39134f33 run, nothing near mail) · pipeline 2878 / `integration` job 38382 · `expected 429 to be 503`: the request met the rate limit instead of the send deadline. Retried as job 38407. First sighting.

## v19-mail-sender-check.spec.ts:123 "a member sends the check email from the settings mail screen, opens the link, and the relay starts listening" — desktop-webkit

- 2026-10-22 · 5635d9f3 (!1084, `dev` -> `preview` for v0.3.1; same product code as a98c6f88, whose pipeline 2889 passed this job) · pipeline 2901 / smoke_webkit (job 38636), desktop-webkit · failed once (`toHaveURL` expected `/settings/mail$`, got `/settings/mail?sender=verified`), passed on retry. First sighting.

## v19-create.spec.ts:1182 "dropping a new file after a refusal relabels the button 'not this one' and hides 'refused'" — desktop-webkit

- 2026-10-22 · 77ffcabb (`preview` push of v0.3.1, same tree as 5635d9f3) · pipeline 2908 / smoke_webkit (job 38686) · failed once, passed on retry. First sighting.

## v19-explore-search.spec.ts:336 "Enter on the no-match add act carries the typed name to /create" — desktop-webkit

- 2026-10-22 · 77ffcabb (`preview` push of v0.3.1, same tree as 5635d9f3) · pipeline 2908 / smoke_webkit (job 38686) · failed once, passed on retry. First sighting.

## sign-out-descent.spec.ts:267 "sign out from another page's menu plays the descent (wide desk)" on desktop-firefox

- 2026-10-22 · 39134f33 (!1081) · pipeline 2875 / `smoke_firefox` job 38354 · "#1253: the page is still showing over the dusk", 10 s predicate timeout; passed on Playwright's retry in the same run. First sighting for this variant and browser.

## v19-axe-sweep.spec.ts:388 "the signed-in v19 sweep › /settings/mail has no automated WCAG A/AA violations" on desktop-firefox

- 2026-10-22 · 39134f33 (!1081) · pipeline 2875 / `smoke_firefox` job 38354 · failed its first attempt, passed on Playwright's retry in the same run. The same screen as the layout-and-themes axe flake above, from the sweep spec. First sighting.

## install.backups.test.mjs:358 "a slow but healthy `compose down` (4 s) is not a timeout: the rollback completes, no cause line, all three volumes removed (guards FR2)"

- 2026-10-23 · c1d9a453 (!1088, which changes no installer code) · pipeline 2932 / `fast` job 38895 · the output carried "Docker did not finish within": the fake's 4 s `compose down` overran its 6 s cap. The `fast` job took 584 s, near its limit, so the runner was loaded. Wall-clock-under-load shape (#1447). First sighting.

## document-lifecycle.test.ts "recovers an outage-staged upload after the bounded retry delay without re-upload" (integration)

- 2026-10-23 · 14491076 (the !1088 merge; same tree passed `integration` in MR pipeline 2933) · `dev` push pipeline 2934 / `integration` job 38935 · `lifecycle` was `rejected`, expected `available` (`tests/integration/document-lifecycle.test.ts:662`): the retry after the bounded delay had not landed when the test looked. Retried as job 38942: passed. Wall-clock shape (#1447). First sighting.

## sign-out-descent.spec.ts:196 "sign out from home's menu reaches the dusk (narrow desk, world forced)" — desktop-chromium

- 2026-10-25 · 9dba0fd1 (dev, !1092 merged; hand-started for browser evidence) · pipeline 2981 / smoke (job 39403) · "#1262: the forced world was not drawn beneath the descent", then "#1253: the dusk never arrived"; passed on the in-job retry. First sighting since the #1447 rewrite (2c37d733).

## sign-out-descent.spec.ts:267 "sign out from another page's menu plays the descent (phone-narrow)" — desktop-chromium

- 2026-10-25 · 9dba0fd1 (dev, !1092 merged; hand-started for browser evidence) · pipeline 2981 / smoke (job 39403) · "#1253: the dusk never arrived" (`#dusk` absent); passed on the in-job retry. First sighting since the #1447 rewrite (2c37d733).

## v19-create.spec.ts:1256 "the desk's create form: dropping another file while Adding… shows still attaches the file that was picked" — desktop-firefox

- 2026-10-25 · 9dba0fd1 (dev, !1092 merged; hand-started for browser evidence) · pipeline 2981 / smoke_firefox (job 39404) · the held item write never seen within 20 s after Add was clicked (line 1317); passed on the in-job retry. First sighting.
