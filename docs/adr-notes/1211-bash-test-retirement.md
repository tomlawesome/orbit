# #1211: retiring the bash backup and restore test suites

#1211 moved backup, restore and the recovery-bundle flows into the
TypeScript engine, leaving `scripts/backup.sh`, `restore.sh`,
`export-recovery-bundle.sh` and `import-recovery-bundle.sh` as thin shells
around a `docker compose run` one-off. Six bash suites tested functions
those scripts no longer have. Build note D10 (#1210) lets a bash suite go
only once every test in it maps to an engine test, with any gap ported
first. The tables below are that mapping. What the scripts printed is still
compared against: it was captured from `6448f07e` (scripts unchanged since
`d6a365a3`) into `src/lib/__fixtures__/` (see its README).

Each row is a bash test title and the test that now proves the same
behaviour (`file › test title`), or `retired:` with the reason the
behaviour no longer exists. `deliberate:` marks a behaviour the engine
changes on purpose.

Test files named below:

- `src/lib/`: `in-container-adapter.test.ts` (new), `restore-engine.incomplete-correspondence.test.ts` (new),
  `backup-restore-cli.retired-bash.test.ts` (new: ports), `backup-restore-cli.test.ts`,
  `restore-engine.lifecycle.test.ts`, `recovery-bundle.backup.test.ts`, `restore-engine.parity.test.ts`
- `src/cli/`: `orbit.backup-restore.test.ts` (new)
- `scripts/`: `backup-restore-shell.test.mjs` (new), `test-backup-restore.test.mjs`

## scripts/restore.test.mjs

| bash test title | covered by |
|---|---|
| health_probe_url › no ORBIT_BIND_ADDRESS/ORBIT_PORT set (default deployment) | backup-restore-shell.test.mjs › restore.sh and import-recovery-bundle.sh health probe › no keys |
| health_probe_url › ORBIT_BIND_ADDRESS=0.0.0.0 explicit, default port | backup-restore-shell.test.mjs › … health probe › explicit default bind address |
| health_probe_url › ORBIT_PORT only, bind address defaults to 0.0.0.0 -> loopback | backup-restore-shell.test.mjs › … health probe › default bind address, custom port |
| health_probe_url › ORBIT_BIND_ADDRESS=127.0.0.1 and non-default ORBIT_PORT | backup-restore-shell.test.mjs › … health probe › custom bind address and port among unrelated lines |
| health_probe_url › a non-loopback ORBIT_BIND_ADDRESS is passed through unchanged | backup-restore-shell.test.mjs › … health probe › custom bind address, default port |
| pins the exact pre-fix hardcoded literal this fix replaced, and shows the fixed output now differs for a non-default port | test-backup-restore.test.mjs › derives the probe the same way scripts/restore.sh does (restore.sh keeps the drill's own function, word for word) |
| wait_for_health › reaches a deployment's health endpoint on a non-default ORBIT_PORT | backup-restore-shell.test.mjs › … health probe › default bind address, custom port |
| wait_for_health › does not reach a health endpoint bound on a different port than the one .env-orbit configures | backup-restore-shell.test.mjs › … health probe › an exported value wins over the file, as for compose (#1241) |
| query_report / query_active_report › accepts a report that ends with the terminator, and strips it before parsing | in-container-adapter.test.ts › queryReport asks psql for the report and the terminator as two commands, and strips the terminator |
| … › accepts a legitimate zero-row report, leaving the parsed report empty | in-container-adapter.test.ts › queryReport accepts a legitimate zero-row report |
| … › refuses a failed query as an incomplete check, not a correspondence violation | in-container-adapter.test.ts › queryReport refuses a failed query as a report that did not run to completion (#678) |
| … › refuses a report truncated mid-stream even though psql exited 0 | in-container-adapter.test.ts › queryReport refuses a report truncated mid-stream even though psql exited 0 … |
| … › refuses an empty report that exited 0 | in-container-adapter.test.ts › queryReport refuses an empty report that exited 0 … |
| … › asks psql to stop on error and to run the report and the terminator as two separate commands | in-container-adapter.test.ts › queryReport asks psql for the report and the terminator as two commands, and strips the terminator |
| pre-fix, a failed query returned 1 -- the same status a correspondence violation returns | restore-engine.incomplete-correspondence.test.ts › tells the operator which check could not be completed, and does not call their backup corrupt |
| pre-fix, a query that produced nothing and exited 0 was accepted as an empty report; it is now refused | in-container-adapter.test.ts › queryReport refuses an empty report that exited 0 … |
| fail_correspondence › tells the operator which check could not be completed, and does not call their backup corrupt | restore-engine.incomplete-correspondence.test.ts › (same title) |
| fail_correspondence › still reports a genuine correspondence violation with its original message | restore-engine.incomplete-correspondence.test.ts › (same title) |
| fail_correspondence › fails closed: an incomplete check refuses the restore rather than proceeding | restore-engine.incomplete-correspondence.test.ts › tells the operator which check could not be completed … |
| fail_correspondence › passes a healthy correspondence check through without failing | restore-engine.incomplete-correspondence.test.ts › (same title) |
| correspondence call sites › covers every report query in both the staged and the live path | restore-engine.incomplete-correspondence.test.ts › names the %s report as the %s check (six cases); restore-engine.parity.test.ts › restore.sh ran each query against both the staged and the live database |
| correspondence call sites › names a check and propagates the incomplete status at every call site | restore-engine.incomplete-correspondence.test.ts › every correspondence call site names its stage and check (checkpoint, recovery, cutover) and the preflight cases |
| sweep_orphaned_checkpoints › removes an abandoned checkpoint directory when no journal exists | backup-restore-cli.retired-bash.test.ts › removes an abandoned checkpoint directory when no journal exists |
| sweep_orphaned_checkpoints › preserves the checkpoint directory the current journal names, and removes every other one | deliberate: with a journal present the engine sweeps nothing (a restore refuses, `--recover` touches only the journal's checkpoint); backup-restore-cli.retired-bash.test.ts › leaves every checkpoint alone when a journal exists; restore-engine.lifecycle.test.ts › O2-R10: a checkpoint that does get journaled is never reported or removed as an orphan |
| sweep_orphaned_checkpoints › leaves every checkpoint alone when a journal exists but names no readable restore_id | backup-restore-cli.retired-bash.test.ts › leaves every checkpoint alone when a journal exists (the restore refuses instead) |
| sweep_orphaned_checkpoints › leaves every checkpoint alone when the journal path is a symlink | backup-restore-cli.retired-bash.test.ts › leaves every checkpoint alone when the journal path is a symlink, which counts as an unfinished restore |
| sweep_orphaned_checkpoints › does nothing when the restore root does not exist yet | backup-restore-cli.retired-bash.test.ts › does nothing when the restore root does not exist yet |
| refuse_if_rotation_open › returns cleanly when no rotation is open | restore-engine.lifecycle.test.ts › proceeds normally once the rotation marker is gone |
| refuse_if_rotation_open › refuses when a document-KEK rotation is open (DOCUMENT_KEK_NEXT exists) | backup-restore-cli.retired-bash.test.ts › refuses before reading the key or staging the bundle; restore-engine.lifecycle.test.ts › refuses to prepare a restore while a rotation is open |
| refuse_if_rotation_open › does not treat a symlinked document-kek-next as an open rotation | backup-restore-cli.retired-bash.test.ts › does not treat a symlinked document-kek-next as an open rotation |
| refuse_if_rotation_open › calls refuse_if_rotation_open before read_document_kek in the plain restore path, and inside recover_restore | backup-restore-cli.retired-bash.test.ts › refuses before reading the key or staging the bundle; restore-engine.lifecycle.test.ts › refuses --recover while a rotation is open … |
| refuse_if_rotation_open › re-checks after the RESTORE confirmation and before create_checkpoint | restore-engine.lifecycle.test.ts › refuses to prepare a restore while a rotation is open (RestoreRun.prepare runs after the confirmation) |

## scripts/import-recovery-bundle.test.mjs

| bash test title | covered by |
|---|---|
| baseline › completes successfully: live key replaced, old key cleaned up, staging removed | backup-restore-cli.test.ts › completes: swaps the live KEK, restores the bundle's content, and removes the previous KEK |
| baseline › reverts the live key and reports failure when the inner restore fails with no durable evidence | backup-restore-cli.test.ts › reverts the live KEK and restarts the app when the inner restore fails before leaving journal evidence |
| SS1-S3 › refuses outright when .orbit-secrets/document-kek-next is present, before touching anything | backup-restore-cli.retired-bash.test.ts › (same title) |
| SS1-S3 › proceeds normally once the rotation evidence is gone | backup-restore-cli.test.ts › completes: swaps the live KEK, restores the bundle's content, and removes the previous KEK |
| O2-R1 › SIGTERM between the two renames still restores the live key, and never deletes its only remaining copy | retired: there is no such window. The two renames run in one synchronous step and Node runs a SIGTERM handler only between event-loop turns; the old key is staged beside the live one, never in scratch space, so it always survives: backup-restore-cli.test.ts › O2-S3 › when the revert itself fails, the previous KEK is preserved … |

## scripts/backup-restore-lock.test.mjs

| bash test title | covered by |
|---|---|
| a restore waits for a backup already holding the lock, never running concurrently | deliberate: the engine refuses at once instead of waiting (exit 75) and the shell leaves orbit-app to the run holding the lock: backup-restore-cli.test.ts › runRestore cross-process lock › refuses while another process holds the shared flock …; backup-restore-shell.test.mjs › %s leaves the app to the run that holds the backup/restore lock (engine exit 75) |
| a backup waits for a restore already holding the lock, never running concurrently | deliberate, as above: backup-restore-cli.test.ts › refuses while another process holds the shared flock, and runs once it is released; orbit.backup-restore.test.ts › restore --recover exits 75 while another backup or restore holds the lock … |
| acquire_backup_restore_lock is called before read_document_kek in the bare (no-argument) dispatch path | backup-restore-cli.retired-bash.test.ts › a backup reads the live key only once it holds the lock |
| --verify still reads the document KEK (it needs it to decrypt the bundle) without taking the backup/restore lock | orbit.backup-restore.test.ts › takes no backup/restore lock and creates no backup directory: it only reads a bundle |

## scripts/backup-publish-race.test.mjs

| bash test title | covered by |
|---|---|
| publishes a fresh bundle and removes the temporary file | recovery-bundle.backup.test.ts › publishBundleAtomically › moves the temp file into place when the destination does not exist |
| refuses rather than silently reporting success when a bundle already exists at the final path | recovery-bundle.backup.test.ts › refuses to clobber an existing same-named backup, race-free (#32); publishBundleAtomically › refuses race-free when the destination already exists … |

## scripts/export-recovery-bundle-publish-race.test.mjs

| bash test title | covered by |
|---|---|
| publishes a fresh recovery bundle and removes the temporary file | recovery-bundle.backup.test.ts › publishBundleAtomically › moves the temp file into place … (runExportRecoveryBundle publishes through the same function) |
| refuses rather than silently reporting success when a recovery bundle already exists at the final path | recovery-bundle.backup.test.ts › publishBundleAtomically › refuses race-free when the destination already exists … |

## scripts/document-kek-direct-value.test.mjs

| bash test title | covered by |
|---|---|
| backup.sh / restore.sh › materializes the expected secrets file from a direct DOCUMENT_KEK value when no file exists yet | retired: docker-compose.yml mounts the key as a `file:` secret, and compose cannot create orbit-app, or the one-off, without that file. A deployment with only a direct value cannot run orbit-app at all, so no backup ever met one; the shells refuse it before stopping anything |
| backup.sh / restore.sh › still refuses when neither a file nor a valid direct value is present | backup-restore-shell.test.mjs › %s refuses a missing document key before stopping the app, which could not start again without it |
| backup.sh / restore.sh › leaves an existing file-backed key untouched, never overwriting it from .env-orbit | retired: nothing reads DOCUMENT_KEK from .env-orbit any more; only an import writes the live key |

## Parity tests rewritten against the golden files

- `restore-engine.parity.test.ts`: the correspondence queries, the scan-lease
  statement, `checkpoint_sha256`, the journal rules and `check_capacity` come
  from `__fixtures__/restore-sh/` instead of awk extraction from restore.sh.
- `recovery-bundle.parity.test.ts` sections 2 and 3 (whole-script
  import-recovery-bundle.sh and backup.sh --verify runs) moved to
  `orbit.backup-restore.test.ts`, against `__fixtures__/import-recovery-bundle-sh/`
  and `__fixtures__/backup-sh-verify/`. The open-rotation refusal keeps its
  category; the engine's wording differs from the script's.
- `backup-restore-cli.parity.test.ts`: the import-recovery-bundle.sh run
  became the engine's own import preflight accepting the exported bundle.

## Amendment E3a: validate before stopping Orbit

Build note E3 stopped Orbit for the whole restore, preflight included.
Amendment E3a (2026-10-06, on #1211) restores the bash-era order instead:
`restore.sh <bundle>` and `import-recovery-bundle.sh` first run the engine
with `--preflight` while Orbit is up, and stop it only once that passes, so
a bundle Orbit cannot restore costs the running instance nothing. Asserted
by backup-restore-shell.test.mjs › validate the bundle before stopping
Orbit (E3a); the two `preflightOnly` blocks in backup-restore-cli.test.ts
(under runRestore and runImportRecoveryBundle); and orbit.test.ts ›
restore %s %s is a usage error.
