# Flakes

A flake is a check that failed and passed again on unchanged code. One heading
per flake, one line per sighting: `date · commit · pipeline/job · symptom`.
The third sighting under a heading gets an issue, linked from the heading;
fixing the cause deletes the heading in the same commit.

## document-lifecycle.test.ts:1335 "emits a bounded rejected lifecycle record when reconciliation finds an available document's ciphertext missing"

- 2026-09-09 · 11a68e8 (+ #911's uncommitted setup-mail work, none of it near documents) · local `pnpm test:integration` · the bounded reason came back `crypto_metadata_missing` where the test expects `storage_object_missing`. The same file passed on the run immediately before, on the same code, and the run's other 39 files were green both times — so reconciliation appears to reach the two missing-piece checks in a different order under load.

## v19-keyboard.spec.ts:432 "settings: reached via the account panel"

- 2026-09-08 · af13319 · local `scripts/test-e2e-local.sh`, kept stack, 10 repeat runs · failed 2 of 10. The settings sessions list renders one "sign out of <device>" button per session and is unbounded, so on a stack reused across runs (168 sessions by the tenth) `auditTabOrder`'s 60-stop cap is exhausted, and `readSessions()` resolving after `.cards` lets rows arrive after the visibility snapshot. Likely fix shape: the `.cand` exclusion the household test already uses.

## repair_journeys: credential-drift, `rotate-database-credential` never reported `result=done`

- 2026-09-08 · 251a2ec · pipeline 774 / repair_journeys (!897) · `repair --execute --dangerous` exited 0 about 3 s after `--check` had reported `database-credential-mismatch`, with no rotate line; the same job was green on 767 before and 778 after on the same harness code, and all 12 journeys pass locally. `scripts/test-repair-journeys.sh` now prints the batch output on this failure so the next sighting shows which finding repair actually made.
