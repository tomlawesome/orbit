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

## v19-first-run-door.spec.ts:250, and `net::ERR_ABORTED` on a /home navigation — mobile-chromium

- 2026-09-10 · cb9cbfd · pipeline 907 / smoke (job 10645, !911) · `v19-first-run-door.spec.ts:250` "a claimed local-only instance shows the sign-in card in the ring" — `expect(locator).toBeVisible()` failed, element not found. Passed on the retried job 10651 on the same commit.
- 2026-09-19 · 977a74d · pipeline 1275 / smoke (job 16651, !946) · `v19-keyboard.spec.ts:568` "administration: the local-user controls are reachable and announced" (desktop-chromium), retry #1 — `page.goto: net::ERR_ABORTED at http://127.0.0.1:3000/home`. Its first attempt was the account-panel flake above; the retry died before reaching the screen at all, so this test has never yet reported on its own subject in CI.

`net::ERR_ABORTED` on a navigation points at specs sharing one Orbit instance,
which is #949 — a sibling spec's teardown or sign-out landing on top of this
one. The door card not being found may be the same thing wearing a different
hat, or may be its own timing; two sightings do not say. The third gets an
issue.

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

## password.test.ts "matches the same password however the client composed its accents" and extraction-shortlist-recall.test.ts "adds to the tallies it is given rather than replacing them"

- 2026-09-18 · `fix/m9-surface-bugs` · local `pnpm run test` (whole unit suite, 270 files in parallel) · both timed out at 5000 ms in the full run, then passed together in isolation (32/32, ~4.5 s for both files) on unchanged code. The full run was under heavy load (import phase 239 s, tests 833 s), so this reads as scheduler starvation rather than anything in either test — neither file changed on this branch. First sighting of each; no issue yet (an issue on the third, per the testing-and-ci skill).

## local-sign-in.test.ts "spends a real derivation whichever of the four cases it is"

- 2026-09-19 · 9ccca49 (!950, none of it near sign-in) · pipeline 1278 / `integration` job 16683 · `expect(Math.max(...times)).toBeLessThan(Math.min(...times) * 6)` — the four attempts' elapsed times spread wider than 6×. Retried on the same commit as job 16708 and passed. The assertion measures wall-clock on a shared, loaded runner; its own comment (`tests/integration/local-sign-in.test.ts:283-285`) says a strict bound "would measure the runner rather than the code", and the host was writing at 80–160 MB/s under another tenant at the time.

## v19-keyboard.spec.ts:568 "administration: the local-user controls are reachable and announced"

- 2026-09-19 · d0d5b47 (+ #1062's uncommitted end-cap focus-ring work, none of it near administration) · local `scripts/test-e2e-local.sh --spec tests/e2e/v19-keyboard.spec.ts --project desktop-chromium` · the "send a new setup link" button was not found at all: `expect(locator).toHaveAttribute` on `.person` filtered to the row that is not "· you", timing out at 5s with "element(s) not found". The other 22 tests in the run passed. The same test passed on the same code in CI — pipeline 1281 / smoke (job 16738), `✓ 111 [desktop-chromium] ... (3.1s)` — where the run's only two failures were the belt end-caps #1062 was fixing. So the row either had no second person or had not rendered when the assertion looked, rather than the control being missing. First sighting; no issue yet (an issue on the third, per the testing-and-ci skill).
