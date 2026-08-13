# #296 slice plan: port backup, restore, and recovery-bundle flows to the orbit CLI

Status: proposed (slices 1-4 implemented). This is a working note, not an ADR —
it records the decomposition of issue #296 so each slice lands as an
independently reviewable pull request, following the same convention as
`docs/adr-notes/295-install-port-plan.md`. Update it as slices land or the
plan changes.

## Why slice, and why this order

`scripts/backup.sh`, `scripts/restore.sh`, `scripts/export-recovery-bundle.sh`,
`scripts/import-recovery-bundle.sh`, and their shared helper
`scripts/recovery-crypto.mjs` total roughly 1,900 lines with dozens of
catalogued guarantees (`docs/installer-guarantees.md`, Part 2). Issue #296
itself calls this out as the highest-blast-radius flow in the whole port —
"ported last, when the harness is most mature, because the blast radius is
user data" — so ADR-0011's guarantee-parity-proven-not-assumed discipline
applies with the least room for error of any flow ported so far.

The slices below are ordered the same way #295's were: the parts with no
Docker/Postgres dependency and the clearest standalone-entry-point parity
come first, so each slice is verifiable in isolation before the riskier
integration and data-mutation work.

1. **Bundle format core** (this slice) — the ORBKEK01 passphrase-envelope
   crypto, HMAC bundle authentication, document-KEK fingerprinting, and the
   manifest/tar-layout/checksum validation for both bundle shapes. Pure
   filesystem + `node:crypto` logic, no Docker, no Postgres, no interactive
   prompts. Implemented as `src/lib/recovery-bundle.ts`.
2. **Document-archive payload crypto and full bundle content verification** —
   the AES-256-CBC/PBKDF2-SHA256 document-archive encryption (byte-compatible
   with `openssl enc -pbkdf2`), completing `backup.sh`'s `validate_bundle`
   end-to-end (the `pg_restore --list` liveness check via a thin injected
   adapter, mirroring how `src/lib/config-contract.ts` keeps `docker` calls
   as thin edge adapters over pure decision logic), and `create_bundle`'s
   packaging orchestration (`pg_dump`/document-tar collection via the same
   adapter shape). Builds directly on slice 1's manifest/checksum/HMAC
   primitives.
3. **Transactional restore engine** — `restore.sh`'s checkpoint/journal/
   rollback state machine (`create_checkpoint`, `write_journal`,
   `rollback_checkpoint`, `recover_restore`, the `cleanup` EXIT trap) and
   `validate_correspondence`'s database-row-to-document-blob referential
   integrity checks. This is the single highest-blast-radius piece in the
   whole issue — it is the only flow that mutates the live database and
   document volume — and is the direct analogue of #295 slice 1's
   `InstallTransaction`, but with a durable, crash-recoverable journal on
   top (`restore.sh` already survives a hard `SIGKILL` via its own
   `--recover` path; the port must preserve that exactly, not just the
   commit/rollback shape `InstallTransaction` characterizes).
4. **Recovery-bundle orchestration, full CLI wiring, and the bootstrap
   flip** — `export-recovery-bundle.sh`/`import-recovery-bundle.sh`'s
   interactive passphrase/confirmation flows (candidates for a machine-prompt
   protocol analogous to `docs/engine-events.md`'s
   `ORBIT_CONFIGURE_PROMPTS=machine`, which today only covers
   `configure.sh`'s guided fields — extending that vocabulary is this
   slice's job, not slice 1's), the live document-KEK swap-with-automatic-
   rollback logic, real `orbit backup` / `orbit restore` /
   `orbit export-recovery-bundle` / `orbit import-recovery-bundle` CLI
   entry points wired onto slices 1-3, and the bootstrap flip. Gated on the
   full Phase 1 acceptance harness (`scripts/test-backup-restore.sh`) passing
   against the CLI entry point, plus the cross-implementation round-trip
   evidence the issue's test plan requires (a Bash-created bundle restored
   by the CLI, and vice versa).

Each slice lands as its own PR, keeps the Bash scripts unmodified and in
control of every shipped entry point until slice 4, and cites the guarantee
numbers from `docs/installer-guarantees.md` Part 2 it characterizes.

## Slice 1 — bundle format core (this PR)

**Scope.** `src/lib/recovery-bundle.ts`: the crypto and format layer shared
by every bundle the Bash scripts produce or consume —

- The **ORBKEK01 envelope** (`scripts/recovery-crypto.mjs`'s `encrypt`/
  `decrypt`): scrypt(N=131072, r=8, p=1)-derived AES-256-GCM, AAD-bound to
  the format magic, fresh salt/IV every call, ported 1:1 and proven against
  the real script by literal subprocess parity (`recovery-crypto.mjs` has a
  standalone `node` entrypoint — no Docker hop is needed to invoke it).
- **HMAC bundle authentication** and **document-KEK fingerprinting**
  (`recovery-crypto.mjs`'s `hmac`/`fingerprint` operations): the
  key-separated authentication sub-key derivation and `sha256(key)`
  fingerprint, likewise proven by subprocess parity.
- The **backup bundle** (`orbit-<timestamp>.tar`, `scripts/backup.sh`)
  manifest build/parse, the five-member tar-layout allow-list and
  link/special-file rejection, the document-archive internal path allow-list
  (`objects/xx/yy/<hash>.bin`, `staging/<hash>.bin`, directory scaffolding
  only), and the manifest/HMAC/checksum verification chain.
- The **recovery bundle** (`orbit-recovery-<timestamp>.tar`,
  `scripts/export-recovery-bundle.sh` / `import-recovery-bundle.sh`)
  manifest build/parse, four-member tar-layout allow-list and link/special
  rejection, and checksum verification.
- Permission semantics: the `0700` private-work-directory and `0600`
  secret-bearing-file modes both scripts enforce, plus a
  `writeSecretFile` helper mirroring `InstallTransaction.writeStagedFile`'s
  mode-forced-before-write discipline for any later slice that stages a
  document-KEK or manifest.hmac to disk.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 2): `backup.sh` #5-#17 (HMAC/fingerprint format checks, the manifest-
authentication chain, the five-member allow-list, the document-archive path
allow-list, format-version and wrong-key refusal, checksum verification);
`export-recovery-bundle.sh` #6-#9, #12-#14 (passphrase length/confirmation,
the ORBKEK01 magic check, checksums, the manifest's algorithm identifier);
`import-recovery-bundle.sh` #1-#10, #14, #16 (regular-file/archive/member/
format-version/checksum preflight, the decrypted-key format check, the
`0600` envelope mode); `recovery-crypto.mjs` #1-#9, #11-#16 (the full crypto
primitive set: passphrase-length defense-in-depth, key-format checks, fresh
salt/IV, AAD binding, buffer zeroing, generic wrong-passphrase reporting,
key-separated HMAC sub-key, fingerprint-only key exposure).

**Non-goals for slice 1**: the AES-256-CBC document-archive
encrypt/decrypt (`backup.sh` #19-#20, #27-#28), the `pg_restore --list`
liveness check (`backup.sh` #18), and any bundle *creation* that requires a
live Postgres/document volume (`create_bundle`'s `pg_dump`/document-tar
collection) are all out of scope — they need a live deployment (or, for the
CBC decrypt specifically, could theoretically be ported Docker-free, but is
deliberately deferred to slice 2 alongside the other payload-verification
steps rather than split across two slices; see Flags below). Restore's
checkpoint/journal/rollback engine and the database/document correspondence
checks are slice 3, not this one. This module does not (yet) build a
complete backup or recovery bundle from scratch — `createTar`/manifest/
checksum/HMAC building blocks are exposed for a later slice to compose, but
no orchestration function exists yet.

**Testing and parity strategy.**

- **Unit tests** (`src/lib/recovery-bundle.test.ts`, 53 tests): every crypto
  primitive, refusal class, manifest/layout/checksum check, and the
  permission-mode helper, citing guarantee numbers in test names/comments —
  including every negative fixture shape `scripts/test-backup-restore.sh`'s
  `make_corrupt_{manifest,hmac,checksum}_bundle` helpers construct
  (corrupt-manifest, corrupt-hmac, corrupt-checksum, wrong-key, unsupported
  format-version, misplaced-object, unexpected/missing member, link/special
  entry).
- **Subprocess parity** (`src/lib/recovery-bundle.parity.test.ts`, 12 tests):
  stronger than #295 slice 1's function-extraction fallback, because two of
  slice 1's three sources genuinely support literal whole-artifact spawning
  without Docker:
  - `recovery-crypto.mjs` is spawned directly (`node scripts/recovery-crypto.mjs
    <op> <path>`) for `hmac`, `fingerprint`, `encrypt`, and `decrypt`, and
    its output is compared byte-for-byte against `recovery-bundle.ts`'s
    output (and vice versa: an envelope built by one implementation is
    decrypted by the other).
  - `scripts/import-recovery-bundle.sh` and `scripts/backup.sh --verify` are
    each spawned as the *whole, unmodified script* against fixtures crafted
    to be rejected at or before their first Docker call — verified both by
    reading the scripts (the archive/checksum/format-version preflight in
    both runs entirely before any `docker compose run`) and by these tests
    actually executing with no Docker daemon reachable. This is genuine
    `config-contract.parity.test.ts`-style whole-script parity, not
    function extraction, for the paths it covers.
- **Determinism and secrets-hygiene** (`src/lib/recovery-bundle.
  determinism.test.ts`, 10 tests): the manifest/HMAC/fingerprint primitives
  are asserted pure and repeat-call-identical; the ORBKEK envelope is
  asserted *non*-deterministic on purpose (fresh salt/IV) as an explicit
  contrast case, so a future regression toward determinism there is caught
  rather than looking like an improvement; a sweep asserts no thrown
  `RecoveryBundleRefusal`'s message (or `util.inspect`/`String()` rendering)
  ever contains a passphrase, a raw document KEK, an HMAC value, or an
  attacker-controlled member/path name, matching
  `test_recovery_bundle_diagnostics`'s own no-leak assertions in the Bash
  harness.
- No hidden CLI rehearsal subcommand was needed for this slice — unlike
  #295 slice 1, there is no staged multi-step transaction to interrupt yet
  (that begins in slice 3); every characterization here is achievable
  through the module's pure functions and the two forms of parity above.

## Slice 2 — document-archive payload crypto and full bundle content verification (this PR)

**Scope.** Extends `src/lib/recovery-bundle.ts` with everything slice 1
deliberately deferred:

- The **AES-256-CBC/PBKDF2-SHA256 document-archive envelope**
  (`encryptDocumentArchive`/`decryptDocumentArchive`), byte-compatible with
  `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -pass
  file:<document-kek-file>` (backup.sh:128-130,156-157). `-pass file:PATH`
  reads PATH's first line verbatim as the passphrase, so the
  already-validated `documentKekHex` string doubles as that passphrase;
  `-pbkdf2` derives key‖IV (48 bytes) in one PBKDF2-HMAC-SHA256 call over the
  envelope's own 8-byte salt, matching OpenSSL's own `Salted__` + salt
  header format exactly (guarantees #19-20, #27-28).
- **`validateBackupBundleContents`**, completing backup.sh's `validate_bundle`
  end-to-end on top of slice 1's `validateBackupManifestAndAuth`: the
  `pg_restore --list` liveness check on the embedded database dump (#18) and
  decrypting + re-validating the document archive against slice 1's own path
  allow-list (#19-20).
- **`BackupDockerAdapter`**, the thin injected interface over the operations
  that genuinely need a live Docker/Postgres deployment (`pg_restore --list`,
  `pg_dump`, the document-tar collection, and stopping/starting `orbit-app`),
  mirroring the plan's "thin injected adapter" framing. `validateBackupBundleContents`
  and `createBackupBundle` depend only on this interface, never on `docker`
  directly.
- **`createDockerComposeBackupAdapter`**, the real adapter: spawns the exact
  `docker compose ...` argument lists backup.sh uses, over a fixed
  `spawnSync` argv array (no shell interpolation). Its `env` option is the
  PATH-shim test seam (`recovery-bundle.docker-adapter.test.ts`), following
  the same fake-executable-ahead-on-PATH technique as
  `scripts/configure.test.mjs`'s `fakeDockerScript`/`fakeOpensslScript` — no
  test in this slice requires a live Docker daemon.
- **`createBackupBundle`**, porting `create_bundle`'s packaging orchestration
  end-to-end (#21-34): stop the app for a cross-resource point-in-time
  backup, dump the database and collect the document archive via the
  adapter, encrypt the documents and delete the plaintext copy immediately,
  build and HMAC-sign the manifest+checksums, package and validate the
  five-member tar, and publish it — always restarting the app on the way out
  (success or failure) via `finally`, the TypeScript equivalent of
  backup.sh's `EXIT` trap.
- **`publishBundleAtomically`**, the `.installing`-temp-name-then-publish
  step (#32-33) — see Flags below for why this is `link`+`unlink` rather
  than a literal port of `mv --no-clobber`.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 2): `backup.sh` #18-28, #31-34 (the `pg_restore --list` liveness check,
the document-archive AES-256-CBC decrypt/re-validation, the app-stop/dump/
collect/encrypt/publish/app-restart orchestration of `create_bundle`, and the
completed-bundle/atomic-publish checks).

**Testing and parity strategy.**

- **Unit tests** (`src/lib/recovery-bundle.test.ts`): the CBC envelope's
  round-trip, header format, non-determinism, and generic-failure-message
  refusal, extending slice 1's existing describe blocks.
- **Subprocess parity** (`src/lib/recovery-bundle.parity.test.ts`): the
  document-archive envelope is not a Bash script but a direct `openssl enc`
  invocation, so the real, unmodified `openssl` binary is spawned with
  backup.sh's exact argument lists, both directions — an envelope produced
  by `encryptDocumentArchive` decrypted by real `openssl`, and one produced
  by real `openssl` decrypted by `decryptDocumentArchive` — plus a
  wrong-key case showing both implementations refuse it.
- **Adapter tests** (`src/lib/recovery-bundle.docker-adapter.test.ts`, new
  file): three layers —
  1. `createBackupBundle`/`validateBackupBundleContents`/
     `publishBundleAtomically` exercised against a trivial in-memory fake
     `BackupDockerAdapter` — no process spawning, covering every refusal
     path (empty/invalid dump, collection failure, wrong key,
     already-exists) and the always-restart-the-app invariant.
  2. `createDockerComposeBackupAdapter` exercised through a PATH-shim fake
     `docker` executable that logs its exact argv and lets each test control
     its exit code/stdout — proving the real adapter sends backup.sh's exact
     command shape and threads stdout/exit-status correctly, still with no
     real daemon.
  3. An end-to-end test running `createBackupBundle` against the real
     adapter through the same PATH shim, then verifying the result with
     `validateBackupBundleContents` — the full round trip this slice adds,
     Docker-free.
- **Determinism and secrets-hygiene** (`src/lib/recovery-bundle.
  determinism.test.ts`): the document-archive envelope is asserted
  non-deterministic on purpose (fresh salt), mirroring slice 1's ORBKEK
  contrast case; a decryption-failure refusal is swept for the document KEK,
  the wrong key, and the plaintext document bytes, none of which may appear.

## Slice 3 — transactional restore engine (this PR)

**Scope.** `src/lib/restore-engine.ts`: `restore.sh`'s checkpoint/journal/
rollback state machine and its database-row-to-document-blob referential
integrity checks — the single highest-blast-radius piece of issue #296 (the
only flow that mutates the live database and document volume), and the
direct analogue of #295 slice 1's `InstallTransaction`, but with a durable,
crash-recoverable journal on top:

- **`writeRestoreJournal`/`loadRestoreJournal`** (`write_journal`/
  `load_recovery_journal`, restore.sh:467-506,772-796): the pid-suffixed-
  temp-file-then-fsync-then-atomic-rename-then-fsync-directory write, with
  the previous journal backed up first and restored on a late (post-rename)
  sync failure; read-back re-validates format version, `restore_id`/`state`
  enum, all three checkpoint digests, and that the referenced checkpoint
  directory and its three artifacts still exist as regular, non-symlink
  files — never trusting the journal's own claims. `RestoreDurabilityHooks`
  is the fault-injection seam for both, called immediately before each real
  fsync attempt and may throw to simulate that sync failing — the DI
  analogue of `restore.sh`'s `ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE` env
  var, with no env var and no Bash change needed.
- **`computeCheckpointDigests`/`validateCheckpointIntegrity`/
  `syncCheckpointArtifacts`** (`checkpoint_sha256`/
  `validate_checkpoint_integrity`/`sync_checkpoint_artifacts`,
  restore.sh:399-428,454-465): SHA-256 digests of the three checkpoint
  artifacts, computed, durably synced (artifacts then directory), and
  re-verified on demand.
- **`checkCorrespondence`** (`validate_correspondence`/
  `validate_correspondence_reports`, restore.sh:205-332,658-736):
  consolidates restore.sh's own two near-duplicate copies of the same
  database-row-to-on-disk-blob cross-check into one canonical function (see
  Flags) — every document/attachment/staging-object row is checked against
  the actual blob (existence, non-symlink, exact byte size, no duplicate
  storage-key reuse, no orphaned on-disk object), and any in-flight
  ("transient") document lifecycle row refuses the whole check, since a
  point-in-time backup/checkpoint cannot safely represent one.
  `CORRESPONDENCE_QUERIES` are the six `psql` report queries, transcribed
  and proven byte-for-byte (`restore-engine.parity.test.ts`).
- **`RestoreDockerAdapter`**, extending `BackupDockerAdapter`'s three
  reused operations (`dumpDatabase`, `pgRestoreListOk`,
  `collectDocumentsArchive` — restore.sh's checkpoint capture uses the
  identical command shapes `backup.sh`'s `create_bundle` does) with the
  restore-specific Docker/Postgres edge: private stage database create/
  drop/restore, live database/document replacement, scan-lease reset, and
  the two report-query shapes. `createDockerComposeRestoreAdapter` is the
  real implementation, spawning restore.sh's exact `docker compose ...`
  argument lists over a fixed `spawnSync` argv array.
- **`RestoreRun`**: the state machine itself —
  `createCheckpoint` (`create_checkpoint`, restore.sh:516-566: stop app,
  capture+validate the DB dump and document archive, checkpoint the current
  document key, self-verify the whole checkpoint against a private stage
  database, durably sync and journal it — `checkpointVerified` is set true
  only once every one of those has succeeded, establishing the same strict
  "point of no return" ordering restore.sh itself has);
  `cutoverDocuments`/`cutoverDatabase` (restore.sh:919-926: each live
  mutation is immediately followed by its own durable journal write);
  `finalize` (restore.sh:927-932: re-validates active correspondence, waits
  for health, and only then marks the restore complete and purges the
  journal/checkpoint); `rollback` (`rollback_checkpoint`,
  restore.sh:764-770); and **`dispose`** — the `cleanup` `EXIT`-trap
  equivalent (restore.sh:833-860): if a checkpoint was verified but the
  restore never completed, it either preserves recovery evidence
  (mid-`--recover`) or attempts an automatic rollback, durably recording
  `rollback-failed` and leaving Orbit stopped if that itself fails rather
  than guessing further — idempotent, exactly like
  `InstallTransaction.dispose()`.
- **`recoverRestore`** (`recover_restore`, restore.sh:798-831): the
  `bash scripts/restore.sh --recover` entry point equivalent — loads and
  re-validates the journal, re-verifies checkpoint digest integrity and key
  validity from scratch (never trusting the journal's claims alone),
  re-runs the full checkpoint self-verification, and only then reapplies
  it. Recovery is unconditional on the journal's recorded state (matching
  restore.sh's own behavior — `recover_restore` never branches on
  `checkpointed` vs. `documents-replaced` vs. `database-restored`; it always
  fully reapplies the checkpoint), so it is safely retriable from any
  partial failure, including a failure inside `recoverRestore` itself.
- **`preflightValidateBundle`** (`prepare_staged_bundle`'s correspondence
  check, restore.sh:334-353, guarantees #7-10): validates a newly staged
  bundle's database dump and document tree correspond inside a throwaway
  private database, entirely before a checkpoint is ever created — reuses
  `checkCorrespondence` and the same private-stage-database pattern
  `createCheckpoint`'s self-verification does.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 2 / restore.sh): #2-10 (document-KEK/bundle preflight chain reused from
slice 1-2, plus the private-staging correspondence check), #13-30
(checkpoint capture, durability, self-verification, cutover, rollback),
#31-41,43,45-48 (`--recover` mode and the global `EXIT`-trap/top-level
guards). `check_capacity` (#11-12) is explicitly **out of scope** for this
slice — see Flags.

**No shipped entry point.** Nothing in this slice is reachable from any
real `orbit` command; `RestoreRun`/`recoverRestore` are wired only to the
hidden `orbit __restore-engine-rehearse` subcommand
(`src/cli/orbit.ts`), used exclusively by
`restore-engine.interruption.test.ts` to drive a real, self-delivered
SIGKILL. No Bash script is modified.

**Testing and parity strategy.**

- **Unit tests** (`restore-engine.test.ts`, 30 tests): journal write/read
  round-trips and every refusal class (symlinked journal path, invalid
  digests, mode/format/enum violations, missing/incomplete checkpoint),
  checkpoint digest compute/validate/sync, and `checkCorrespondence`'s full
  refusal matrix (transient rows, missing/mismatched/duplicate/orphaned/
  misplaced objects, crypto-incomplete visible documents, the
  pending-staging-ledger present/absent distinction, `document_staging_objects`
  rows against `staging/`, not `objects/`).
- **State-machine / interruption-matrix tests**
  (`restore-engine.docker-adapter.test.ts`, 11 tests): a trivial in-memory
  `FakeRestoreAdapter` (no process spawning) proves the full
  checkpoint→cutover→finalize lifecycle, and — the core evidence for "every
  mutating step has a journal entry before it and a rollback path" — a
  dedicated matrix interrupts (via a thrown error) immediately after each of
  create_checkpoint, cutoverDocuments, cutoverDatabase, and a failed
  finalize, asserting `dispose()` always leaves either a fully rolled-back,
  healthy app with no journal/checkpoint, or (when rollback itself cannot
  succeed) a durable `rollback-failed` journal plus an intact checkpoint
  that a subsequent `recoverRestore()` call completes successfully.
  `recoverRestore` and `preflightValidateBundle` are covered directly too
  (tamper detection, idempotent re-recovery, preflight never touching live
  state).
- **Real-process interruption test** (`restore-engine.interruption.test.ts`,
  4 tests): drives the hidden CLI rehearsal subcommand as a genuine child
  process and has it deliver `SIGKILL` to *itself* immediately after each of
  the three journaled states (`checkpointed`, `documents-replaced`,
  `database-restored`) — mirroring restore.sh's own
  `ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE`/`kill -KILL "$$"` test harness
  exactly, rather than install-transaction.interruption.test.ts's
  pause-then-external-kill pattern (unnecessary here since restore.sh's own
  harness already establishes the "kill itself at a coded point" idiom).
  Asserts the journal and self-verified checkpoint survive the kill with
  the expected state, and that a second, fresh rehearsal process in
  `--recover` mode always restores the *original* checkpointed state
  afterward, regardless of which live mutation had or hadn't completed.
- **Parity** (`restore-engine.parity.test.ts`, 11 tests): the six
  `CORRESPONDENCE_QUERIES` and `SCAN_RECOVERY_LEASES_SQL` are `awk`-extracted
  from the real, unmodified `restore.sh` (locating the literal line by
  plain-substring anchor, then undoing Bash's `'\''`-embedded-quote escaping
  — the same transform `sh -c '...'` itself performs at parse time) and
  compared byte-for-byte against this module's constants, including a check
  that each query appears at both its `query_report` and
  `query_active_report` call sites in the real script;
  `checkpoint_sha256` — genuinely Docker-free on its own — is extracted via
  `awk` (the same function-extraction technique
  `install-transaction.parity.test.ts` established) and *executed as a real
  Bash subprocess* against a real file, compared to `sha256File`'s output;
  `load_recovery_journal`'s `restore_id`/`state`-enum regex text and its
  mode-600 check are asserted present verbatim in the extracted function
  body. Full live-Docker whole-script parity (`restore.sh` end-to-end
  against a real deployment) is out of reach in this slice's sandbox, same
  as it was for slice 2's Docker-adapter argv shape — the SQL/regex text
  and the pure state-machine logic are what's characterized here; the
  argv shapes `createDockerComposeRestoreAdapter` sends are visible by
  direct code inspection against restore.sh's own `compose(...)` calls,
  following the same convention slice 2's `createDockerComposeBackupAdapter`
  already established.

**Non-goals for slice 3**: real `orbit backup`/`orbit restore` CLI entry
points, `export-recovery-bundle.sh`/`import-recovery-bundle.sh`'s
interactive passphrase/confirmation flows and the live document-KEK swap
(`ORBIT_RESTORE_ROLLBACK_KEK_FILE`'s *caller*, i.e. `import-recovery-bundle.sh`'s
own orchestration — `RestoreRun`'s `rollbackDocumentKekFile` option is the
callee-side seam that future slice already needs, ported now since it's
free), and `check_capacity`'s disk-space preflight arithmetic — all slice 4.

## Slice 4 — recovery-bundle orchestration and CLI wiring (this PR)

**Scope.** The plan's own slice 4 line item names five things: a
machine-prompt protocol extension, the live document-KEK swap-with-
rollback, and four real CLI entry points, "gated on" the full Phase 1
acceptance harness plus live cross-implementation round-trip evidence. This
sandbox has no live Docker/Postgres deployment (the same constraint slices
2-3 already hit — see their own Flags), so that gate is unreachable here;
the narrowest faithful reading taken for this slice is *the orchestration
that ties slices 1-3 together into the backup/restore flows, wired onto
real, explicit-invocation-only CLI commands, characterized as thoroughly as
a Docker-free sandbox allows* — not a live-Docker-gated release decision
(see Flags for how "the bootstrap flip" specifically was narrowed). Slices
1-3 already ported every crypto/format primitive and the full checkpoint/
journal/rollback state machine; this slice's own new code is genuinely just
orchestration plus the two pieces slice 3 explicitly deferred:

- **`checkRestoreCapacity`** (`src/lib/restore-engine.ts`) — `check_capacity`
  (restore.sh:355-397), explicitly deferred by slice 3's own Flags. Pure
  arithmetic over an injected `RestoreCapacityFacts` (guarantee #12's
  numeric-measurement gate applies to every field before the three space
  checks in #11 run); `directoryUsageKib`/`filesystemAvailableKib` are new
  host-side `du -sk`/`df -Pk`-Avail-column reimplementations (the same
  "reimplement in Node rather than shell out" discipline `sha256File`
  already established over `sha256sum`), and `RestoreDockerAdapter` gained
  three new container-measurement methods
  (`measureLiveDatabaseSizeBytes`/`measureLiveDocumentTreeKib`/
  `measureDocumentVolumeAvailableKib`), implemented for real in
  `createDockerComposeRestoreAdapter` with restore.sh's exact `psql`/`du`/
  `df` command shapes.
- **`src/lib/recovery-prompts.ts`** — the machine-prompt protocol extension
  the plan calls out as "this slice's job, not slice 1's": four new fields
  (`RECOVERY_PASSPHRASE`, `RECOVERY_PASSPHRASE_CONFIRM`,
  `IMPORT_CONFIRMATION`, `RESTORE_CONFIRMATION`) added to
  `docs/engine-events.md`'s existing "Machine prompts (v0)" line grammar,
  reusing the identical `prompt`/`prompt-reject`/`prompt-accept`/
  `prompt-abort` shape and bounded-3-attempt protocol `configure.sh`'s own
  `ORBIT_CONFIGURE_PROMPTS=machine` mode established — pure, injected-I/O
  logic (`MachinePromptDriver`), no process/stdio access itself.
- **`src/lib/backup-restore-cli.ts`** — the orchestration module the slice
  is named for, composing recovery-bundle.ts + restore-engine.ts only
  (no new crypto, no new mutation primitive):
  - `verifyBackupBundle` — `backup.sh`'s `validate_bundle` end-to-end
    (regular-file check, layout, extraction, `validateBackupBundleContents`),
    the one piece slice 1-2 left as separate building blocks; reused by
    `orbit backup --verify`, restore's own bundle load, and
    export-recovery-bundle.sh's guarantee #4 (source bundle must verify
    before a recovery bundle is made from it).
  - `runBackup` — `create_bundle`'s outer wrapper (timestamp + private
    work-directory setup) around slice 2's already-complete
    `createBackupBundle`.
  - `stageAndPreflightRestoreBundle` — `prepare_staged_bundle`
    (restore.sh:334-353, guarantees #7-10): `verifyBackupBundle` + staging
    the document tree + slice 3's `preflightValidateBundle`.
  - `runRestore` — restore.sh's actual main flow (:897-933): private-backup-
    directory setup and symlink refusal (guarantee #44, restore.sh:886-889
    — discovered missing during this slice's own test-writing and folded in
    as `ensureBackupDirectorySafe`, not a late patch to a shipped path),
    the unfinished-restore journal refusal (#45), `stageAndPreflightRestoreBundle`,
    `checkRestoreCapacity` (#11-12), a `confirm: () => boolean` callback
    invoked **exactly once, at restore.sh's own confirmation point** — after
    preflight/capacity pass, immediately before the checkpoint (guarantee
    #46) — and then `RestoreRun`'s `createCheckpoint`/`cutoverDocuments`/
    `cutoverDatabase`/`finalize`, with `dispose()` always run in a `finally`
    (restore.sh's `trap cleanup EXIT` equivalent, matching #47-48). Every
    mutating step is still exactly the journaled `RestoreRun` sequence
    slice 3 characterized — this function adds no new mutation path, only
    the preflight/capacity/confirmation steps around it.
  - `runExportRecoveryBundle` — `export-recovery-bundle.sh`'s orchestration:
    `verifyBackupBundle` on the source (#4), passphrase length/confirmation
    (#6-7), `encryptDocumentKek`, manifest/checksums, four-member tar,
    `publishBundleAtomically`.
  - `runImportRecoveryBundle` — `import-recovery-bundle.sh`'s orchestration,
    including the live document-KEK swap-with-automatic-rollback: layout/
    manifest/checksum validation, `decryptDocumentKek` (its own
    invalid-recovered-key check covers guarantee #14 without a second
    check here), the "IMPORT RECOVERY" confirmation gate, the current-KEK
    regular-file check, `stopApp` + rename-swap the live KEK file (never a
    copy — matching `mv`'s atomicity), then `runRestore` on the inner
    bundle with `rollbackDocumentKekFile` pointed at the preserved previous
    key (wiring slice 3's already-built callee-side seam to its real
    caller for the first time) and a **second, independent** `confirmRestore`
    callback (see Flags for why this is deliberately not the same gate as
    `importConfirmed`). On success the previous key is removed; on failure
    with no restore-journal evidence the key swap is reverted and the app
    restarted (matching `import-recovery-bundle.sh:21-30`); on failure with
    journal evidence present, the swap is left in place and the caller is
    told to run `orbit restore --recover` (matching :114-119) — no
    additional guessing.
- **Real CLI entry points** (`src/cli/orbit.ts`): `orbit backup [--verify
  <backup.tar>]`, `orbit restore [--yes] <backup.tar> | orbit restore
  --recover`, `orbit export-recovery-bundle <backup.tar>`, `orbit
  import-recovery-bundle <recovery.tar>` — every one explicit-invocation
  only (reachable only by typing its exact command name; `main()`'s
  dispatch has no default/fallthrough case that runs any of them), and every
  one refuses cleanly without its required argument(s) before touching the
  filesystem (`src/cli/orbit.test.ts`). Passphrase/confirmation collection
  supports both a real interactive terminal (masked synchronous raw-mode
  read for secrets, matching `read -s`) and `ORBIT_RECOVERY_PROMPTS=machine`
  (this slice's new env var, mirroring `ORBIT_CONFIGURE_PROMPTS=machine`).
  `--dir` is the CLI's own existing path-resolution mechanism (established
  by `check` in issue #294), reused rather than the Bash scripts'
  `ORBIT_ENV_FILE`/`ORBIT_BACKUP_DIR`/`ORBIT_SECRETS_DIR` — see Flags.
  **No Bash script is invoked, modified, or wired as a fallback by any of
  this** — `scripts/backup.sh`, `scripts/restore.sh`,
  `scripts/export-recovery-bundle.sh`, and `scripts/import-recovery-bundle.sh`
  remain byte-identical to develop and are not on any path this slice adds.

**The hidden `__restore-engine-rehearse` interruption rehearsal now drives
the orchestrated flow, not just `RestoreRun` directly.** Per this slice's
brief, the SIGKILL rehearsal matrix (`restore-engine.interruption.test.ts`,
unchanged, still 4 tests) is extended by rewriting
`commandRestoreEngineRehearse`'s forward branch to call `runRestore` itself
— the exact function `orbit restore` calls — against a real backup bundle
built via `runBackup` (not a hand-assembled tar), so the staged-bundle
preflight and `checkRestoreCapacity` genuinely run ahead of the checkpoint
under a real, self-delivered `SIGKILL`, for the first time. All four
existing interruption tests (three hard-kill stages plus the no-journal
`--recover` case) pass unchanged against this rewritten, more complete code
path — the observable journal/checkpoint contract slice 3 characterized did
not change, only the harness that exercises it now goes further.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 2): `restore.sh` #11-12 (`check_capacity`, this slice's own headline
deferred item), #43-48 (usage validation, the backup-directory/restore-root
symlink guard, the unfinished-restore journal refusal, the confirmation
gate, the strictly-ordered journaled phases, and completed-only-after-every-
step-succeeds); `export-recovery-bundle.sh` #1-14 (the full export flow,
already-proven primitives now actually wired end-to-end); `import-recovery-
bundle.sh` #1-25 (the full import flow including the live-KEK-swap-with-
rollback and the unfinished-restore-evidence refusal, :114-119).

**Non-goals for slice 4**: the Phase 1 acceptance harness
(`scripts/test-backup-restore.sh`) run against the CLI entry point, and
live cross-implementation round-trip evidence (a Bash-created bundle
restored by the CLI, and vice versa) — both explicitly require a live
Docker/Postgres deployment this sandbox does not have, the same constraint
slices 2-3's own Flags already recorded for their own Docker-adapter argv
shapes. What *is* provided instead, Docker-free, per Flags below: a whole
orchestration-produced recovery bundle's wrapped key decrypted by the real,
unmodified `recovery-crypto.mjs`, and `import-recovery-bundle.sh`'s own
unmodified archive/checksum/manifest preflight (which runs entirely before
its first Docker call) accepting a bundle this slice's `runExportRecoveryBundle`
produced. Any actual "bootstrap flip" — flipping a Bash script's own
dispatch, or making any of these CLI commands reachable by default — is out
of scope; see Flags.

**Testing and parity strategy.**

- **Unit tests**: `src/lib/restore-engine.capacity.test.ts` (23 tests) —
  `checkRestoreCapacity`'s exact boundary thresholds for all three space
  checks, the numeric-measurement gate (#12), and `directoryUsageKib`/
  `filesystemAvailableKib` against real temporary filesystems.
  `src/lib/recovery-prompts.test.ts` (20 tests) — every validator/
  classifier, the line-grammar's attempt-bounded retry/abort behavior, and
  a sweep asserting a secret-kind field's prompted value never appears in
  any protocol line. `src/lib/backup-restore-cli.test.ts` (19 tests) —
  every orchestration function against a trivial in-memory
  `RestoreDockerAdapter`/`BackupDockerAdapter` fake (no process spawning),
  covering: bundle verification success/corruption/wrong-key,
  `runRestore`'s journal-exists/capacity/confirmation refusal ordering
  (including asserting `confirm()` is never called until preflight and
  capacity both already passed), the full checkpoint→cutover→finalize
  lifecycle via the orchestration entry point, and
  `runImportRecoveryBundle`'s complete refusal matrix — unconfirmed import
  (KEK untouched), inner-restore failure with no journal evidence (KEK
  reverted, app restarted), inner-restore failure *with* journal evidence
  (KEK left in place, `rollback-failed` journal asserted present), a
  pre-existing unfinished restore (refused before any decryption), and a
  wrong passphrase. `src/cli/orbit.test.ts` (16 tests) — every command
  spawned as a real subprocess: no default/implied execution, refusal
  without required arguments before any filesystem mutation, machine-prompt
  mode reached correctly, and a sweep asserting a supplied passphrase never
  appears in the CLI's own stdout/stderr.
- **Parity**: `check_capacity`'s exact arithmetic (headroom constants and
  all three thresholds) is `awk`-extracted from the real, unmodified
  `restore.sh` and *executed as a real Bash subprocess* against PATH-shim
  fake `du`/`stat`/`df` executables and an inline fake `compose` shell
  function (extending `restore-engine.parity.test.ts`, 4 new describe
  blocks / boundary-value comparisons, same technique
  `checkpoint_sha256`'s own parity test already established) — both
  implementations are proven to accept/refuse at the identical KiB
  boundary for all three space checks.
  `src/lib/backup-restore-cli.parity.test.ts` (3 tests) provides the
  Docker-free cross-implementation evidence available in this sandbox (see
  Non-goals above): the real `recovery-crypto.mjs decrypt`, spawned
  directly, decrypts a `document-kek.enc` this slice's own
  `runExportRecoveryBundle` produced (both directions of key correctness:
  right passphrase succeeds, wrong passphrase is refused identically), and
  the real, unmodified `import-recovery-bundle.sh` is spawned against a
  bundle `runExportRecoveryBundle` produced, asserting its own archive/
  manifest/checksum preflight (which runs entirely before its first Docker
  call) never reports a structural failure against it — proving the
  orchestration's bundle shape is byte-for-byte what the Bash script
  expects, up to the boundary a live daemon is required to cross.

## Flags (bash characterized, not changed)

- The recovery bundle's own `checksums.sha256` is **not** HMAC-signed or
  otherwise authenticated at that layer — it only detects accidental
  corruption. Real tamper-evidence for the wrapped document KEK comes from
  the ORBKEK envelope's own AES-GCM authentication tag, and for the inner
  backup bundle from *its* HMAC (verified downstream, once slice 2/3 wire up
  `orbit-backup.tar`'s own validation). This is `export-recovery-bundle.sh`/
  `import-recovery-bundle.sh`'s existing contract, not a slice 1 regression —
  `recovery-bundle.ts` characterizes it as-is (see the comment on
  `verifyRecoveryBundleChecksums`) rather than silently adding an outer HMAC
  the Bash format doesn't have. Flagging for owner awareness in case a wider
  authentication boundary is wanted before slice 4 ships this as a real
  entry point.
- `backup.sh`'s `validate_bundle` and `restore.sh`'s `validate_bundle_layout`
  + `validate_bundle` are two independently maintained near-duplicates of
  the same tar-layout/manifest/HMAC/checksum logic (structured slightly
  differently: `backup.sh` does layout, extraction, and auth in one
  function; `restore.sh` splits the layout check out separately). Slice 1's
  port treats them as one canonical shape (`validateBackupBundleLayout` +
  `validateBackupManifestAndAuth`), which both scripts' *observable
  behavior* agrees with, but the duplication in Bash itself is worth the
  owner knowing about as a latent drift risk independent of this port.
- `write_hmac`/`document_kek_fingerprint` invoke `recovery-crypto.mjs`
  inside the `orbit-app` container purely so the app image stays the single
  place that touches key material — but the document-KEK file is equally
  host-readable at `$ORBIT_SECRETS_DIR/document-kek`, which every Bash
  script *also* reads directly on the host for its own format checks
  (`read_document_kek`). Slice 1 computes the identical primitives directly
  on the host in TypeScript (proven correct via the subprocess parity
  above), which is a legitimate simplification of *mechanism*, not a change
  in *behavior* — but it does mean that from slice 4 onward the CLI will
  read the document KEK straight off the host filesystem rather than
  shelling into the app container the way every Bash script does today.
  Flagging this intentional divergence for owner awareness before it lands
  in a shipped path.
- Passphrase-length enforcement (`>= 12` characters) is already duplicated
  twice in Bash (`export-recovery-bundle.sh`'s own check and
  `recovery-crypto.mjs`'s independent defense-in-depth check, guarantee #1).
  `recovery-bundle.ts` adds a third independent copy of the same constant
  rather than centralizing it, to keep this slice dependency-free of any
  later slice's shared-constants module. Not a defect — matches the Bash
  side's own defense-in-depth stance — but noting the constant now exists in
  three places across the two languages.
- No behavioral discrepancy was found between `recovery-bundle.ts` and the
  Bash scripts for anything in slice 1's scope during this port; the items
  above are characterization/process notes, not correctness concerns.
- **(slice 2)** `publishBundleAtomically` implements backup.sh's
  `.installing`-temp-name + `mv --no-clobber` publish step (#32) as
  `link`+`unlink` instead of a literal port. `mv --no-clobber`'s own
  never-overwrite check is not itself race-free (GNU `mv` stats the
  destination, then renames); `link` refuses atomically with `EEXIST` if the
  destination already exists, with no window between the check and the
  action. Same never-clobber *behavior*, a race-free *mechanism* — flagging
  per the CodeQL js/file-system-race discipline this port was asked to hold
  to, and because it is a deliberate, explainable improvement over the Bash
  original rather than a literal port, matching the class of divergence
  slice 1 already flagged for `document_kek_fingerprint`/`write_hmac`.
- **(slice 2)** `createDockerComposeBackupAdapter`'s `stopApp`/`startApp`/
  `dumpDatabase`/`collectDocumentsArchive` inherit the child process's
  stderr (`stdio: [..., "inherit"]`) rather than the Bash original's mix of
  fully-suppressed (`create_bundle`'s `compose stop/start orbit-app
  >/dev/null`, stderr not redirected either) and fully-discarded
  (`validate_bundle`'s `pg_restore --list ... 2>/dev/null`) — this slice
  standardizes on "never suppress stderr for an operator-facing Docker
  failure," which is a superset of what backup.sh already does for
  `stop`/`start`/`pg_dump`/the tar collection (none of those redirect
  stderr in the Bash original either); only `pg_restore --list`'s own
  stderr, which Bash discards, is likewise discarded here
  (`pgRestoreListOk`'s `stdio` has no `"inherit"` slot). No behavioral
  regression — RecoveryBundleRefusal messages this module throws remain
  static strings regardless, per the existing no-secret-leak sweep.
- **(slice 2)** No behavioral discrepancy was found against `openssl enc
  -pbkdf2` for anything in this slice's document-archive-crypto scope; the
  wrong-key/short-envelope refusal parity, and both encrypt/decrypt
  directions, are proven byte-for-byte in
  `recovery-bundle.parity.test.ts`.
- **(slice 3)** `checkCorrespondence` consolidates `restore.sh`'s own two
  independently-maintained near-duplicate copies of the same
  database-row-to-on-disk-blob logic (`validate_correspondence`, run
  against a private stage database in three call sites — preflight,
  checkpoint self-verify, and `--recover` re-verify — and
  `validate_correspondence_reports`, run against the live database via
  `query_active_report`) into one canonical function. Both Bash functions'
  *observable behavior* is identical (same field order, same regex checks,
  same object-enumeration logic — confirmed by direct comparison of
  restore.sh:205-332 against :658-736), so this is the same category of
  simplification slice 1 already flagged for `backup.sh`'s/`restore.sh`'s
  duplicated bundle validators, not a behavior change.
- **(slice 3)** `check_capacity` (restore.sh:355-397, guarantees #11-12 —
  the `df`/`du`/live-database-size arithmetic proving enough free space
  exists in the backup directory, temp filesystem, and document volume
  simultaneously before a restore proceeds) is out of scope for this slice.
  It sits structurally between `prepare_staged_bundle` and
  `create_checkpoint` in restore.sh's control flow but does not itself
  touch the checkpoint/journal/rollback state machine or correspondence
  checking this slice was scoped to (see Slice 3's own scope note above);
  flagging for the owner in case it's wanted as an explicit follow-up
  characterization before slice 4 wires a real `orbit restore` entry point
  on top of this engine — a shipped restore command must not skip it.
- **(slice 3)** `loadRestoreJournal`'s regular-file/mode-600 check
  (restore.sh:773-776) is a single `O_NOFOLLOW` `open`+`fstat` (one
  descriptor, no window between the safety check and the content read)
  rather than restore.sh's own separate `[[ -f && ! -L ]]` + `stat -c '%a'`
  + `cat` sequence — the same CodeQL js/file-system-race discipline slice
  1's `readRegularFileNoFollow` and slice 2's `link`+`unlink` publish
  already established, applied here to the journal read path; likewise
  `checkCorrespondence`'s on-disk blob checks (`regularFileSizeNoFollow`)
  replace restore.sh's own separate `[[ -f && ! -L ]]` + `stat -c '%s'`
  pair with one `open(O_NOFOLLOW)`+`fstat` call. Same behavior, a
  race-free mechanism.
- **(slice 3)** The real-process interruption test
  (`restore-engine.interruption.test.ts`) has the rehearsal subprocess
  deliver `SIGKILL` to itself once a target step completes, rather than
  pausing for an external kill the way
  `install-transaction.interruption.test.ts` does — this mirrors
  restore.sh's *own* test harness convention
  (`ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE` + `kill -KILL "$$"`) exactly,
  and sidesteps any race between "the step genuinely completed" and "the
  kill lands," which the pause-based approach needs external synchronization
  for. Under this sandbox's process supervision, a self-delivered SIGKILL is
  sometimes reported as the POSIX wait-status exit code 137 (128+SIGKILL)
  rather than Node's usual `signal="SIGKILL"`/`code=null` shape; the test
  accepts either, since both represent the identical kill.
- No behavioral discrepancy was found between `restore-engine.ts` and
  `restore.sh` for anything in this slice's scope during this port; the
  items above are characterization/process notes and one explicitly
  deferred non-goal (`check_capacity`), not correctness concerns.
- **(slice 4) "The bootstrap flip" was deliberately narrowed, not
  implemented.** The plan's slice 4 line item (written before slice 3
  landed) names "the bootstrap flip" alongside the CLI entry points, and
  frames the whole slice as "gated on the full Phase 1 acceptance harness
  ... passing against the CLI entry point." Neither is reachable in this
  sandbox (no live Docker/Postgres), and — independent of the sandbox
  limit — the task this slice was implemented under holds a stricter
  safety bar than the plan's own wording: any shipped CLI entry point "must
  be explicit-invocation only (no default/implied execution)." A literal
  "bootstrap flip" (making `orbit restore` etc. reachable by default, or
  changing what a Bash script itself dispatches to) is the opposite of
  that. The narrowest faithful reading taken here: ship the four real,
  independently-invokable CLI commands with full orchestration behind them,
  characterize everything Docker-free reach allows, and leave the live-
  Docker acceptance-harness gate and any actual default-execution flip as
  an explicit, separate, future release decision — exactly the shape
  issue #295's own slice 5 (`docs/adr-notes/295-install-port-plan.md`)
  describes for the install flow's own bootstrap flip, which likewise has
  not landed yet. Flagging for owner awareness since this is a narrower
  scope than the plan's literal words, not a smaller one than the safety
  bar this port has held to throughout.
- **(slice 4)** The TS CLI's path resolution (`resolveBackupRestorePaths`)
  uses only `--dir` (`check`'s own existing convention from issue #294),
  not the Bash scripts' `ORBIT_ENV_FILE`/`ORBIT_BACKUP_DIR`/
  `ORBIT_SECRETS_DIR` environment-variable overrides. This is a
  deliberate simplification for internal consistency within the CLI
  (`check` already established `--dir` as the one mechanism, before this
  slice existed) rather than a newly discovered constraint — flagging in
  case the env-var override mechanism is wanted for CLI parity with the
  Bash scripts' own operator-facing surface before these commands are
  promoted beyond explicit invocation.
- **(slice 4)** `readTtyMaskedLine`/`readTtyLine` read directly from `fd 0`
  (requiring `process.stdin.isTTY`) rather than reopening `/dev/tty`
  independently of stdin's own redirection state, unlike every relevant
  Bash prompt (`export-recovery-bundle.sh`/`import-recovery-bundle.sh`/
  `restore.sh` all explicitly `</dev/tty` their prompts). This is safe
  specifically because none of this slice's orchestration pipes a secret
  into a subprocess's stdin the way `export-recovery-bundle.sh`/
  `import-recovery-bundle.sh` pipe the passphrase into
  `recovery-crypto.mjs`'s container invocation (`printf '%s' "$x" |
  compose run ...`) — the document-KEK envelope crypto is pure host-side
  TypeScript now (slice 1's own already-flagged divergence), so nothing
  here needs stdin reserved for a downstream pipe. Same "an interactive
  terminal is required" refusal behavior for a non-terminal, a simpler
  mechanism.
- **(slice 4)** `runRestore`'s `confirm` parameter is a callback invoked
  exactly once, immediately before the checkpoint — not a precomputed
  boolean — specifically so a caller (the CLI) never has to ask an operator
  to confirm a restore that the staged-bundle preflight or
  `checkRestoreCapacity` would have refused anyway, matching restore.sh's
  own control-flow order (`prepare_staged_bundle` → `check_capacity` →
  the `Type RESTORE to continue` prompt → `create_checkpoint`) exactly.
  Asserted directly in `backup-restore-cli.test.ts` (`confirm()` is never
  called when the journal-exists or capacity checks fail first).
- **(slice 4)** `runImportRecoveryBundle`'s `confirmRestore` is a genuinely
  **separate** confirmation from `importConfirmed`, not a simplification
  down to one gate. `import-recovery-bundle.sh:105` invokes the inner
  `bash scripts/restore.sh "$temporary_directory/orbit-backup.tar"` with
  neither `--yes` nor `ORBIT_NONINTERACTIVE_RESTORE` set, so the inner
  script's own "Type RESTORE to continue" prompt (guarantee #46) fires a
  *second* time on top of the outer "Type IMPORT RECOVERY to continue"
  prompt — two distinct confirmations for one operator action in the real
  Bash flow today, faithfully preserved rather than collapsed for a
  smoother CLI UX. Flagging in case a single combined confirmation is
  wanted as a deliberate, tracked UX improvement in a later change — this
  port characterizes current behavior, it doesn't improve on it silently.
- **(slice 4)** `runRestore` (via `ensureBackupDirectorySafe`) now performs
  restore.sh's own `mkdir -p "$backup_directory"; chmod 700 ...` plus the
  backup-directory/restore-root symlink refusal (guarantee #44,
  restore.sh:886-889) as its own first step, rather than leaving it to each
  caller. This was discovered missing while writing this slice's own
  `runImportRecoveryBundle` tests — the earliest version of `runRestore`
  assumed the caller had already done this (matching slice 3's own
  `RestoreRun.prepare`, which reasonably leaves `restoreRoot` setup to its
  direct caller) — and was folded in before any test exercised the gap in
  a way that would have hidden it, not discovered via a shipped-path bug.
- **(slice 4)** `checkRestoreCapacity`'s host-side `directoryUsageKib`/
  `filesystemAvailableKib` reimplement `du -sk`/`df -Pk`'s Avail column in
  Node (`st_blocks`/`statfsSync`'s `bavail`) rather than shelling out to
  `du`/`df`, the same "reimplement rather than shell out" precedent
  `sha256File` already set over `sha256sum` (slice 1's own Flags). Unlike
  `tar`/`openssl`, there is no fixed byte-for-byte output format these two
  utilities need to match — the value is an inherently host/filesystem-
  dependent measurement feeding a `>=` comparison — so the parity evidence
  for this slice is the *arithmetic formula* (headroom constants,
  thresholds), proven via real-Bash-subprocess execution against
  PATH-shimmed fake `du`/`stat`/`df`, not byte-identical real-utility
  output.
- No behavioral discrepancy was found between `backup-restore-cli.ts`'s
  orchestration and the corresponding Bash scripts for anything in this
  slice's scope during this port; the items above are characterization/
  process notes and the two explicitly deferred non-goals (the live-Docker
  acceptance harness and any actual bootstrap flip), not correctness
  concerns.
