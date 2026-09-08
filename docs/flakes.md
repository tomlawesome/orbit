# Flakes

A check that failed and passed again on unchanged code. One heading per
flake, one line per sighting: `date · commit · pipeline/job · symptom`. The
third sighting files an issue, linked from the heading. Fixing the cause
deletes the heading in the same commit.

## repair_journeys: credential-drift, `rotate-database-credential` never reported `result=done`

- 2026-09-08 · 251a2ec · pipeline 774 / repair_journeys (!897) · `repair --execute --dangerous` exited 0 about 3 s after `--check` had reported `database-credential-mismatch`, with no rotate line; the same job was green on 767 before and 778 after on the same harness code, and all 12 journeys pass locally. `scripts/test-repair-journeys.sh` now prints the batch output on this failure so the next sighting shows which finding repair actually made.
