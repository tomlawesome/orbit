# ADR-0014: Repair mode — ratified architecture for diagnosis, planning and safe execution

**Status:** Accepted
**Date:** 2026-08-23
**Relates to:** issue #261 (safe diagnostic and repair mode);
[ADR-0004](0004-supported-upgrades-and-recoverable-restore.md) (recoverable
restore owns data-level rollback);
[ADR-0008](0008-installer-resolved-release-digests.md) (digest-pinned image
identity);
[ADR-0011](0011-operator-experience-as-product.md) (launcher owns
presentation; this repository owns the engine);
#383, #435, #436, #437 (shipped repair slices); #260 (superseded in-repo
command centre)

## Context

Issue #261 demands a repair mode that diagnoses a broken deployment read-only,
explains the bounded problem, and performs only explicitly approved recovery
with rollback protection. Its motivating failure is SQLSTATE `28P01`: a new
password file paired with a retained `orbit-db-data` volume. Repair must
recover that without deleting the volume, without printing the password, and
without resetting a password merely because authentication failed.

This is not a greenfield design. `scripts/repair.sh` and
`scripts/repair.test.mjs` are on `dev`, built in owner-decided slices
(2026-08-12/13, history through #383 and #435–#437) and catalogued in
`docs/installer-guarantees.md`. The script already implements: `--check`
(read-only diagnosis, 21 reason classes, enum-only deterministic output),
`--plan` (classified zero-mutation plan), `--execute --safe-only` (the fixed
safe set: fix-permissions, restore-transaction, restart-services, with
per-action self-restore), and `--execute --dangerous`
(rotate-database-credential behind a typed action word and a verified
passphrase-encrypted credential checkpoint). This ADR ratifies that
architecture, states the reasoning it embodies, and decides the remaining
delta: migration/identity diagnosis, configuration-migration recovery, the
`regenerate-secret` executor, support-diagnostics export, and live evidence.

Three surrounding facts shape the design. First, `install.sh` owns a
managed-file transaction whose on-disk evidence is a
`.orbit-install-staging.*` directory holding a `rollback/original/` mirror
tree and a zero-byte `committed` marker — evidence-based, no journal — with a
TypeScript mirror in `src/lib/install-transaction.ts` pinned by
awk-extraction parity tests. Second, ADR-0011 closed #260: the Go launcher
owns interactive presentation and "the launcher's Repair flow" is #261's
surface; the in-image TypeScript engine may never touch Docker (owner
constraint, #295). Third, `install.sh --repair` is today a stub that emits
`repair-unavailable` and returns 3.

## Decision

### 1. The shipped slices are the ratified architecture

The architecture already on `dev` is confirmed, not replaced. Every
acceptance criterion #261 lists for safe diagnosis, plan-before-mutation, the
credential-drift recovery path, the managed-file transaction, and privacy is
met by the shipped slices as catalogued. The criteria still open are:
failed-migration and image-identity diagnosis; configuration-migration
rollback recovery; execution of `regenerate-secret`; allowlisted diagnostics
export; and the live/exact-image test matrix. Those are scoped in the slices
at the end of this document. Implementation continues from the existing
script; nothing shipped is rewritten to match a cleaner-on-paper shape.

### 2. Entry point: standalone, source-less `scripts/repair.sh`

Repair is one script with three modes — `--check`, `--plan`,
`--execute --safe-only|--dangerous` — over one shared phase pipeline:
diagnose, plan, approve, execute, re-diagnose. Facts are collected once per
invocation and every later phase consumes the same findings, which is what
lets `--check` and the tests use identical facts with zero mutation.

`repair.sh` never sources `install.sh`, `configure.sh` or `installer-ui.sh`.
Its only cross-script interactions are subprocess calls:
`bash scripts/configure.sh --check` for configuration verdicts, and
disposable in-container one-offs of `recovery-crypto.mjs` for cryptography.
Reasoning: repair runs precisely when the deployment is broken; inheriting
another script's shell state, or its assumption of a healthy target, is the
failure mode. The cost is deliberate duplication of small recognition
primitives (`is_regular_non_symlink_file`, project-name derivation, the
managed-path allowlist), accepted and held in step by tests and the
guarantee catalogue.

`install.sh --repair` stays a non-executing signpost. Its message is updated
to name `bash scripts/repair.sh --check` instead of "unavailable"; it never
dispatches into repair, because the two scripts have colliding exit-code
vocabularies (install's 3 is "blocked", repair's 3 is "attention") and
because the launcher invokes the deployed `repair.sh` directly.

Presentation is decoupled by contract, not by styling code. Repair's stdout
is unconditionally plain, deterministic, ANSI-free, enum-only — `--plain` is
accepted and inert. The launcher renders the polished experience from that
stream plus the #297 machine-prompt grammar; a bare terminal gets the same
lines plus fixed stderr guidance. The repair line grammar (`finding`,
`diagnosis`, `plan`, `execute`, `execution`, `dangerous`, the prompt fields)
is a versioned machine interface documented in `docs/engine-events.md`;
vocabulary changes land in the same pull request. Named cost: the repository
carries two output grammars (installer-ui events and the repair stream)
until the engine convergence of ADR-0011 unifies them.

### 3. Diagnosis model and the automation contract

Diagnosis is a fixed, ordered probe sequence, read-only by construction: a
loose directory-recognition gate (any Orbit fingerprint; none at all forces
exit 5 with no further reasoning about a stranger's directory); managed-file
type/mode checks; secrets directory and secret files; configuration via the
`configure.sh --check` subprocess (`configuration-incomplete` vs
`configuration-invalid`, never reimplemented); leftover installer staging
evidence; one bounded Docker gate probe (`timeout 5s docker ps -a`, failure
degrades every Docker-backed check to `docker-unavailable`); Compose
interpolation; container and volume ownership; database reachability
(`pg_isready`) and authentication (a literal `SELECT 1`, password delivered
via `docker exec -e PGPASSWORD`, never argv); application container identity
and health, with an unhealthy container's own log classified into
`database-schema-mismatch` or `database-below-floor` (#437) because those are
not restartable and must not masquerade as `application-unhealthy`.

The reason classes cover every distinction #261 names: `secret-missing`,
`database-credential-mismatch`, `database-unreachable`,
`database-schema-mismatch`/`database-below-floor` (unsupported schema),
`application-unhealthy`, `stale-container`, `unrelated-resource-present` and
`container-foreign-owner`, plus `volume-retained-without-credentials` — the
28P01 precursor, detected from the retained volume name and the absent
password file alone, without opening a connection. The delta slice adds
`migration-failed` (a read-only comparison of the applied migration journal,
over the already-authenticated probe path, against the journal the pinned
image ships) and `image-identity-mismatch`; the reserved name
`unsupported-schema` is retired as covered by the two #437 classes.
`migration-failed` plans as `manual`: ADR-0004's update recovery point owns
that rollback boundary, and the migrator's idempotent retry already happens
on any restart — repair must not invent a competing path.

Exit codes are stable per mode and reflect that run's own outcome, never the
target's post-hoc health: `--check` 0 healthy / 3 attention / 4 failed;
`--plan` 0 empty / 3 plan-available / 4 unplannable; `--execute` 0
empty-complete-unactionable / 1 declined / 4 failed / 6 dangerous-batch
refused; 2 usage and 5 not-an-orbit-installation everywhere. Findings print
in a fixed class order so identical state yields byte-identical output. No
path, configured value, SQL text, raw error or secret ever reaches stdout,
argv, environment or logs; hostile labels, filenames and database errors are
bounds-checked untrusted data.

### 4. Ownership proof

Three layers, and "cannot prove" always means "do not touch". Directories:
loose fingerprints admit diagnosis; the strict install.sh recognition
contract governs action. Containers: the Compose project label plus a known
Orbit service label (`orbit-app`, `orbit-db`, `orbit-clamav`, `orbit-tika`,
`orbit-ollama`); a project-labelled container without a service label is
`container-foreign-owner`, planned `manual`, never touched. Volumes: the
`${project}_orbit-db-data` name and label discipline mirrored from
`install.sh`'s `volume_belongs_to_deployment` and
`src/lib/database-volume-safety.ts`; a matching volume under another project
is `unrelated-resource-present`, informational only. Every executor re-proves
ownership immediately before mutating — diagnosis-time identity is never
trusted across the confirmation gap, closing the TOCTOU window the same way
`fix-permissions` re-validates file type before its single chmod.

### 5. Mutation classes and the two-batch approval protocol

Every planned action carries exactly one mutation class — `none`,
`reversible`, `credential-rotation`, `service-restart` — and `backup=` is
explicit per action. There is no destructive class, and none will be added:
deleting a database or document volume lives outside ordinary repair in a
separate exact-target workflow. An unplannable finding degrades to
`action=manual` with one fixed stderr guidance line (fields, never values),
never to a guess.

Execution is two independently planned, approved and reported batches. The
safe batch is an enumerated allowlist — `fix-permissions`,
`restore-transaction`, `restart-services` — authoritative over the
`mutation=reversible` tag by design: `regenerate-secret` is
filesystem-reversible but mints live credential material, a materially
different risk, so it is excluded. Safe-batch approval is machine-prompt,
then interactive `y`, then non-interactive automation. The dangerous batch
(`rotate-database-credential`, and `regenerate-secret` when its slice lands)
is never automatable: no flag combination runs it unattended; it requires a
typed action word (`rotate`; `regenerate` for the new executor) so
muscle-memory Enter can never fire it, bounded at three attempts, refusal
exiting 6 with zero mutation. Ctrl-C, EOF or decline anywhere precedes all
mutation code. `regenerate-secret` additionally keeps its retention guards:
`postgres-password` is never regenerated while a database volume is retained
(already enforced in planning), and `document-kek` is never regenerated while
a document volume is retained — regeneration is only planned where it cannot
invalidate retained encrypted, session or database state.

### 6. The credential checkpoint and the 28P01 recovery path

The checkpoint for credential rotation is a credential checkpoint, not a data
dump. `ALTER ROLE` mutates only the role's password hash; the retained
volume's data is untouched; the one thing rotation can lose is the previous
credential, so preserving exactly that is the complete rollback point. A
`pg_dump` checkpoint here would cost time and space proportional to the
database while protecting nothing rotation can harm. Data-affecting repairs
(future migration recovery) must instead reuse `backup.sh`'s verified
`pg_dump` path under ADR-0004 — repair never grows a second data-backup
mechanism.

The checkpoint is created without the application credential: the current
`postgres-password` secret is read from the raw Compose secret mount inside a
disposable `--entrypoint node` one-off and encrypted by
`recovery-crypto.mjs` into the existing ORBKEK01 envelope (scrypt,
AES-256-GCM) under an operator passphrase collected twice, hidden, over stdin
only. The bundle is immediately decrypted back and compared byte-for-byte
before anything else runs; any failure refuses the whole batch
(`checkpoint-failed`, exit 4) with the database untouched. The bundle lives
in a mode-0700 `.orbit-repair-checkpoint.*` directory, is never deleted by
the script, and its path appears only as stderr guidance, never on stdout.

The 28P01 journey then runs as an ordered step iterator: checkpoint →
generate a fresh 64-hex credential and stage it at a fixed mode-600 path →
`ALTER ROLE` over the local-socket connection inside the proven `orbit-db`
container (no prior knowledge of the lost password needed; SQL piped over
stdin with `ON_ERROR_STOP`, both interpolants restricted-charset, nothing
printed) → rename the staged file onto `postgres-password` → restart only
`orbit-app` → full re-diagnosis. The volume is never deleted, and rotation
never happens merely because authentication failed: it runs only behind the
typed word, and when the matching original password file is recoverable from
transaction evidence, the planned path is `restore-transaction` in the safe
batch instead.

### 7. Managed-file transaction: consume install's evidence, do not share its code

Repair's own mutations use a per-run private recovery directory
(`.orbit-repair-recovery.*`, mode 0700, path never printed, removed at end of
run): the current live state of every path an action will touch is copied in
first; writes are staged and renamed same-filesystem, mode-preserving; a
failing action self-restores every path it touched before reporting `failed`.

The interface to the install machinery is `install.sh`'s on-disk evidence,
not its functions: `restore-transaction` recognizes the
`.orbit-install-staging.*` layout, restores only paths on the mirrored
literal managed-path allowlist (never paths enumerated from the staging
directory, so tampered staging cannot smuggle targets), refuses symlinked
parents on both sides, refuses outright when the `committed` marker is
present, and removes the staging directory only on full success. The delta
slice extends the same discipline to `configuration.sh`'s
`.orbit-config.rollback` boundary: restore it only when the live `.env-orbit`
fails validation and the rollback copy passes — deterministic, no guessing.
This mirrors rather than shares code because of decision 2's source-less
rule; the parity cost is real and is paid with tests and same-PR catalogue
updates, the same bargain `install-transaction.ts` already made.

### 8. Failure handling

Automatic rollback covers exactly the reversible file changes of a failing
safe action (self-restore from the recovery directory) and the guarantee that
declines and refusals precede all mutation (exits 1 and 6 mean provably
unchanged). A dangerous-step failure stops the iterator at the first failed
step; nothing later runs; every affected plan entry reports `failed`; exit is
4 with a fixed `reason` enum (`checkpoint-failed`/`step-failed`); and stderr
names the manual rollback evidence — the checkpoint bundle path, and the
staged new-credential path when the database may already expect it. Every
`--execute` run ends with a full re-diagnosis in `--check`'s own grammar, so
success is re-proven (configuration, Compose, database authentication,
application health), never declared from the mutation's own exit status.

### 9. Bash now; the engine port later

Repair does not get a TypeScript mirror inside #261. Nearly all of its
diagnosis and all of its execution touch Docker, and the owner's permanent
constraint (#295, baked into `src/cli/orbit.ts`) is that the in-image engine
structurally refuses to spawn `docker` — a port now would either violate that
boundary or mirror only fragments. Its pure-logic dependencies already run in
the right place: configuration verdicts via `configure.sh --check` (itself
engine-delegable) and cryptography via the bundled `recovery-crypto.mjs`.
Behaviour is pinned instead by `scripts/repair.test.mjs` — which spawns the
real script against scratch fixtures and a fake `docker` shim, never a live
daemon — and by the guarantee catalogue's same-PR rule. Named cost: repair's
guarantees stay in the least-testable medium until the catalogued engine port
(ADR-0011, `docs/adr-notes/29x-*-port-plan.md` series) reaches repair; the
catalogue is the portability boundary when it does.

### 10. Support-diagnostics export

Exported diagnostics are the deterministic stream and nothing else: the exact
`--check`/`--plan` output plus one identity line of already-safe metadata
(configuration schema version, applied version, image digest — public values
under ADR-0008). The full content is printed to the terminal and explicitly
confirmed before any file is written. Allowlisting is inherited from the
enum-only output contract rather than implemented as a second redaction layer
that could drift.

## Consequences

- Operators and the launcher get one stable contract: reason classes, action
  classes, exit codes 0–6, and the machine-prompt grammar. Automation reads
  `$?` and the terminal `diagnosis`/`execution`/`dangerous` lines; nothing
  parses prose.
- The safe path is genuinely safe: diagnosis and planning cannot mutate,
  declines and refusals are provably inert, and the dangerous batch cannot
  run unattended. The price is that a fully hands-off "repair everything"
  automation does not exist, by design.
- Recognition primitives exist twice (install.sh and repair.sh) and the
  repair stream exists beside the installer-ui event grammar. Both
  duplications are deliberate isolation with a named maintenance cost, held
  honest by tests and the catalogue until engine convergence.
- Checkpoint bundles accumulate until the operator deletes them; repair never
  deletes recovery material it created for the operator.
- Schema-class diagnosis depends on the application's stable
  `reason=database_mismatch`/`database_below_floor` log vocabulary — a
  cross-layer contract that now must be kept like any other.
- Credential rotation depends on local-socket trust inside the `orbit-db`
  container; a change to the Postgres image's auth model revisits decision 6.
- `install.sh --repair` and `repair.sh` keep different exit vocabularies; the
  launcher treats exit codes per script, never as one shared table.

## Alternatives rejected

- **`install.sh --repair` as the real entry point.** Repair must run when
  install-time assumptions are already broken, install.sh's flow expects a
  fetch-and-stage lifecycle, and the exit-code vocabularies collide.
- **Sourcing `installer-ui.sh` for presentation.** Couples recovery logic to
  terminal styling; ADR-0011 already moved presentation to the launcher; the
  deterministic stream is the boundary.
- **Sharing bash functions with install.sh by sourcing.** Inherited shell
  state from a script written for a healthy target is exactly the hazard;
  source-less construction is itself a catalogued guarantee.
- **A TypeScript repair mirror now.** The engine may never touch Docker;
  repair is Docker-shaped; the port is already scheduled with the catalogue
  as its contract.
- **A `pg_dump` data checkpoint before credential rotation.**
  Disproportionate cost for a metadata-only change; the preserved credential
  is the complete rollback point; data checkpoints belong to ADR-0004's
  machinery.
- **Automatic password reset on authentication failure.** Forbidden by #261;
  rotation exists only behind explicit typed-word approval with a verified
  checkpoint.
- **A destructive action class for retained volumes.** Forbidden; data
  deletion lives in a separate exact-target workflow, never in repair's
  table.
- **A transaction journal for repair.** The install machinery is
  evidence-based (mirror tree plus `committed` marker) with no journal to
  replay; repair consumes that evidence rather than inventing a second
  transaction format.
- **One combined confirmation for both batches.** A single yes must never
  cover both a chmod and a credential rotation; each batch keeps its own
  approval and outcome.

## Implementation slices, in order

Slices 1–5 (diagnosis, database/application probes, planning, safe-set
execution, credential rotation) are shipped on `dev`. Remaining:

1. **Migration and identity diagnosis** — `migration-failed` (read-only
   journal comparison over the authenticated probe path) and
   `image-identity-mismatch`; retire the `unsupported-schema` reserved name;
   fixed manual guidance citing the ADR-0004 recovery point.
2. **Configuration-migration recovery** — recognize the
   `.orbit-config.rollback` boundary and restore it under the
   restore-transaction discipline, only when the live file fails validation
   and the rollback copy passes.
3. **`regenerate-secret` executor** — dangerous batch, typed word
   `regenerate`, retention guards for `postgres-password` and `document-kek`,
   same enum and exit contract.
4. **Support-diagnostics export** — preview-then-confirm write of the exact
   deterministic stream plus the safe identity metadata line.
5. **Live evidence** — credential-drift (password A retained data, Orbit-side
   B, diagnose, approve, rotate, verify auth and data), retained volume plus
   new target, interrupted configuration migration, cancelled repair,
   idempotent re-run, signal cleanup and hostile-value privacy negatives in
   the acceptance harness; exact-image repair of a disposable
   supported-prior-version deployment with backup/restore compatibility.
6. **Surface** — the launcher Repair flow consumes the documented stream and
   prompts; `install.sh --repair` signposts `repair.sh`; the repair line
   grammar is fully recorded in `docs/engine-events.md`; catalogue entries
   land in the same pull requests throughout.
