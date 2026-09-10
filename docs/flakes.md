# Flakes

A flake is a check that failed and passed again on unchanged code. One heading
per flake, one line per sighting: `date · commit · pipeline/job · symptom`.
The third sighting under a heading gets an issue, linked from the heading;
fixing the cause deletes the heading in the same commit.

## document-lifecycle.test.ts:1335 "emits a bounded rejected lifecycle record when reconciliation finds an available document's ciphertext missing"

- 2026-09-09 · 11a68e8 (+ #911's uncommitted setup-mail work, none of it near documents) · local `pnpm test:integration` · the bounded reason came back `crypto_metadata_missing` where the test expects `storage_object_missing`. The same file passed on the run immediately before, on the same code, and the run's other 39 files were green both times — so reconciliation appears to reach the two missing-piece checks in a different order under load.

## v19-mail-collection.spec.ts "a spoofed PDF travels the real pipe" — #958

- 2026-09-09 · ed9497e · pipeline 813 / smoke (job 9079, `dev`) · failed then passed on retry; the two retry runs cost 45.6 s and 27.0 s. The spec is `test.describe.configure({ mode: "serial" })`, so the retry re-ran the group.
- 2026-09-09 · 9e27d38 · pipeline 822 / smoke (job 9269, !908) · same test, same shape, on a branch that touches nothing in the mail-in path.
- 2026-09-10 · cb9cbfd · pipeline 907 / smoke (job 10645, !911) · `sender verification link did not confirm: 200 http://127.0.0.1:3000/` at `v19-mail-collection.spec.ts:183`. Retried job 10651 passed on the same commit, all 282 green.

Three sightings across `dev` and two feature branches, none of which changed
the mail-in path, so the cause is in the check rather than the change. The
third one filed **#958**. Note what it took to surface: the first two were
absorbed by the second Playwright retry, and this branch spends only one, so a
flake that used to cost 45 s took the job down instead.

## v19-keyboard.spec.ts:432 "settings: reached via the account panel"

- 2026-09-08 · af13319 · local `scripts/test-e2e-local.sh`, kept stack, 10 repeat runs · failed 2 of 10. The settings sessions list renders one "sign out of <device>" button per session and is unbounded, so on a stack reused across runs (168 sessions by the tenth) `auditTabOrder`'s 60-stop cap is exhausted, and `readSessions()` resolving after `.cards` lets rows arrive after the visibility snapshot. Likely fix shape: the `.cand` exclusion the household test already uses.

## repair_journeys: credential-drift, `rotate-database-credential` never reported `result=done`

- 2026-09-08 · 251a2ec · pipeline 774 / repair_journeys (!897) · `repair --execute --dangerous` exited 0 about 3 s after `--check` had reported `database-credential-mismatch`, with no rotate line; the same job was green on 767 before and 778 after on the same harness code, and all 12 journeys pass locally. `scripts/test-repair-journeys.sh` now prints the batch output on this failure so the next sighting shows which finding repair actually made.

## repair_journeys: hostile-value-privacy-negatives, "could not start the labelled container vector"

- 2026-09-09 · 9e27d38 · pipeline 822 / repair_journeys (!908) · `docker run … busybox:stable sleep 600` failed after the four journeys before it passed; the job was green on 810–815 the same morning on unchanged harness code (M7 touches nothing in `scripts/test-repair-journeys.sh`). The `docker run` sends its own output to `/dev/null` (`test-repair-journeys.sh:955-960`), so the log cannot say whether it was a Docker Hub pull failure or something else; the next sighting should show that output first.

## Three keyboard/door specs exhaust the 60-stop Tab cap or lose their target — mobile-chromium and desktop-chromium

- 2026-09-10 · cb9cbfd · pipeline 907 / smoke (job 10645, !911) · four failures in one run, all passing on the retried job 10651 on the same commit:
  - `v19-keyboard.spec.ts:463` "inbox: reachable via the account panel, and keyboard-navigable" (desktop-chromium) — `home account panel: Tab never reached the requested control within 60 presses`.
  - `v19-keyboard-pocket.spec.ts:276` "home (pocket): the account menu's Inbox link is reachable by Tab and navigates on Enter" (mobile-chromium) — failed, and its one retry failed too, with `expect(locator).toHaveClass(expected)` and then `page.goto: net::ERR_ABORTED at http://127.0.0.1:3000/home`.
  - `v19-first-run-door.spec.ts:250` "a claimed local-only instance shows the sign-in card in the ring" (mobile-chromium) — `expect(locator).toBeVisible()` failed, element not found.

The 60-press cap is the same one the `v19-keyboard.spec.ts:432` heading above
records, and that entry's diagnosis — an unbounded sessions list eating the cap
on a reused stack — is the first thing to check here. `net::ERR_ABORTED` on a
navigation points elsewhere though: to specs sharing one Orbit instance, which
is #949. Grouped under one heading until a second sighting says whether these
are one cause or three; split it then.

## migrations.test.ts "migrates every current migration into a fresh PostgreSQL 18 database"

- 2026-09-10 · `feature/m8-tier2` · local `vitest run --project integration tests/integration/migrations.test.ts` against a disposable PostgreSQL 18 container · failed once, then passed on three consecutive re-runs of the same file on unchanged code. The failing run took 18.8 s against 1.4–1.8 s on each passing run, so it looks like contention with the containers the other migration scenarios in the same file create and drop, rather than a schema-contract mismatch. First sighting; no issue yet (an issue on the third, per the testing-and-ci skill). The next sighting should capture the assertion itself, which this one did not.
