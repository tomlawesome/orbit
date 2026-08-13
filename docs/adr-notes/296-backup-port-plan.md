# #296 slice plan: port backup, restore, and recovery-bundle flows to the orbit CLI

Status: proposed (slices 1-2 implemented). This is a working note, not an ADR —
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
