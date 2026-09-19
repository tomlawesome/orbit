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

## repair_journeys: hostile-value-privacy-negatives, "could not start the labelled container vector"

- 2026-09-09 · 9e27d38 · pipeline 822 / repair_journeys (!908) · `docker run … busybox:stable sleep 600` failed after the four journeys before it passed; the job was green on 810–815 the same morning on unchanged harness code (M7 touches nothing in `scripts/test-repair-journeys.sh`). The `docker run` sends its own output to `/dev/null` (`test-repair-journeys.sh:955-960`), so the log cannot say whether it was a Docker Hub pull failure or something else; the next sighting should show that output first.

## Three keyboard/door specs exhaust the 60-stop Tab cap or lose their target — mobile-chromium and desktop-chromium

- 2026-09-10 · cb9cbfd · pipeline 907 / smoke (job 10645, !911) · four failures in one run, all passing on the retried job 10651 on the same commit:
  - `v19-keyboard.spec.ts:463` "inbox: reachable via the account panel, and keyboard-navigable" (desktop-chromium) — `home account panel: Tab never reached the requested control within 60 presses`.
  - `v19-keyboard-pocket.spec.ts:276` "home (pocket): the account menu's Inbox link is reachable by Tab and navigates on Enter" (mobile-chromium) — failed, and its one retry failed too, with `expect(locator).toHaveClass(expected)` and then `page.goto: net::ERR_ABORTED at http://127.0.0.1:3000/home`.
  - `v19-first-run-door.spec.ts:250` "a claimed local-only instance shows the sign-in card in the ring" (mobile-chromium) — `expect(locator).toBeVisible()` failed, element not found.
- 2026-09-15 · 332f237 · pipeline 1127 / smoke (job 13931, !918) · `v19-keyboard-pocket.spec.ts:262` "home (pocket): the account menu is light-dismiss by keyboard" (mobile-chromium) — `expect(locator).toHaveClass(/open/)` on the sheet. Passed on the retried job 13936 on the same commit, in 1.4s.

The 60-press cap is the same one the `v19-keyboard.spec.ts:432` heading above
records, and that entry's diagnosis — an unbounded sessions list eating the cap
on a reused stack — is the first thing to check here. `net::ERR_ABORTED` on a
navigation points elsewhere though: to specs sharing one Orbit instance, which
is #949. Grouped under one heading until a second sighting says whether these
are one cause or three; split it then.

The 2026-09-15 sighting is that second one, and it does not settle the split so
much as narrow it. It exhausted no Tab cap and aborted no navigation: the sheet
simply did not carry `open` when the assertion looked, and the same test passed
in 1.4s on a retry of the same commit. That is the shape of a sheet asserted on
before its transition has committed, which is a different fault from either the
60-press cap or the shared instance — and it is the second `v19-keyboard-pocket`
test to fail this way. Split the heading on the next sighting: the pocket sheet
timing looks like its own flake, not a member of this family.

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
