# #295 slice plan: port the guided/unattended install flow to the orbit CLI

Status: proposed (slices 1-3 implemented). This is a working note, not an ADR —
it records the decomposition of issue #295 so each slice lands as an
independently reviewable pull request. Update it as slices land or the plan
changes; it is not meant to be a permanent record like `docs/adr/`.

## Why slice, and why this order

`scripts/install.sh` is 1556 lines with 56 catalogued guarantees
(`docs/installer-guarantees.md`, Part 1). ADR-0011 requires guarantee parity
proven, not assumed, before any flow is ported, and the Phase 1 acceptance
harness (`scripts/test-install-acceptance.sh`) is the unmovable contract:
install, upgrade, and interrupted-recovery scenarios must keep passing
unmodified throughout the port, on the Bash entry point, until a deliberate
bootstrap flip.

The slices below are ordered by blast radius, not by reading order in the
script: the parts with no Docker/network dependency and the clearest
existing TypeScript precedent (`src/lib/config-contract.ts`,
`src/lib/env-orbit-file.ts`, their parity-test pattern) come first, so each
slice can be verified in isolation before the riskier integration work.

1. **Transactional core** (this slice) — staged, atomic `.env-orbit` +
   `.orbit-secrets` commit/rollback. Pure filesystem logic, no Docker, no
   network, no interactive prompts. Implemented as `src/lib/install-transaction.ts`.
2. **Target and identity validation** — `validate_target`,
   `is_preprovisioned_input`, `derive_compose_project_name`,
   `verify_database_volume_safety` / `volume_belongs_to_deployment`. All
   pure decision logic over injected filesystem/`docker` facts, same shape
   as `config-contract.ts`'s injected-facts pattern; the `docker` calls
   themselves stay as thin adapters at the edge.
3. **OIDC discovery and configuration migration** — the sandboxed-container
   discovery-document validator and the `configuration.sh --migrate
   --transaction` handoff, wired onto slice 1's transaction and slice 2's
   validated identity.
4. **Guided configuration driving** — `stage_guided_install_configuration`
   and `prepare_configuration`, driving `scripts/configure.sh` (including
   the `ORBIT_CONFIGURE_PROMPTS=machine` protocol from #297) from the CLI
   instead of a human terminal.
5. **Full orchestration and the bootstrap flip** — image/asset resolution,
   service pull, health-wait probes, and wiring slices 1-4 into a real
   `orbit install` / `orbit update` CLI entry point behind the bootstrap.
   Flipping `install.sh`'s dispatch (or `orbit-launcher`'s fetch target) to
   the CLI path is an explicit release decision per the issue, gated on the
   full Phase 1 harness passing against the CLI entry point.

Each slice lands as its own PR, keeps `install.sh` unmodified and in control
of the shipped entry point until slice 5, and cites the guarantee numbers
from `docs/installer-guarantees.md` it characterizes.

## Slice 1 — transactional core (this PR)

**Scope.** `src/lib/install-transaction.ts`: a class-based staging
transaction mirroring `preflight_final_paths`, `prepare_rollback_area`,
`rollback_transaction`, and the `cleanup` EXIT-trap logic in
`scripts/install.sh:1345-1439` and `scripts/install.sh:306-408`. No Docker,
no network, no OIDC, no `configure.sh` invocation — those are later slices.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 1 / install.sh): 5 (source-only sourcing, not in scope but the
preflight-before-mutate principle is shared), 6-7 (safe-type refusal,
narrowed to the transaction's own preflight), 8 (never follow a symlinked
parent during rollback), 9 (`cp -a`-equivalent same-filesystem restore), 10
(only remove directories this invocation created), 11 (EXIT-trap cleanup:
preserve staging evidence and report on incomplete rollback rather than
deleting it), 46 (`preflight_final_paths`), 47 (`prepare_rollback_area`,
0700 dirs, `cp -a` backup before any mutation), 48 (private 0700 staging
directory, validate-before-touch), 49 (transaction only begins after
preflight + backup both complete), 51 (TOCTOU re-check immediately before
each write), 52 (atomic `mv`, never copy, onto the final destination), 53-54
(mode-forced temp file, atomic rename, never edited in place), 56 (commit
flag is the sole authority for whether `dispose()` rolls back).

**Non-goals for slice 1**: asset fetching, image/digest resolution, Compose
project derivation, database-volume safety, OIDC discovery, and
`configure.sh` invocation are all out of scope — they're slices 2-4. The
module does not (yet) attempt to *resume* a transaction from a preserved
staging directory after a crash; neither does `install.sh` today (the
harness's documented recovery step is manual: inspect, then remove the
`.orbit-install-staging.*` evidence before rerunning). This is a
characterized, not silently changed, contract — see Flags below.

**Testing and parity strategy.**

- **Unit tests** (`src/lib/install-transaction.test.ts`): commit, rollback,
  partial-rollback-with-failures, interruption evidence (staging dir mode
  0700 persists when `dispose()` is never called), permission preservation
  (0600 file / 0700 dir) through backup and restore, and refusal on
  symlinked or wrong-typed managed paths, symlinked parents during rollback,
  and non-regular backup sources. Test names cite the guarantee numbers
  above.
- **Source-extraction parity** (`src/lib/install-transaction.parity.test.ts`):
  `install.sh` has no standalone entry point for just the transaction phase
  (unlike `configuration.sh --preflight`/`--migrate`, which
  `config-contract.parity.test.ts` can `spawnSync` directly), so byte-identical
  full-script parity isn't available for this slice. Instead the test
  mechanically extracts (via `awk`, by function name, not hand-copied) the
  exact current bodies of `is_regular_non_symlink_file`,
  `is_real_non_symlink_directory`, `remove_target_path`,
  `prepare_rollback_area`, and `rollback_transaction` from the real
  `scripts/install.sh`, wraps them in a minimal driver, and diffs the
  resulting directory tree (permissions and content, via the same
  recursive-snapshot approach `scripts/install.test.mjs` already uses) against
  `InstallTransaction` driven through the equivalent scenario. Extraction
  failing loudly (empty match) if a function is renamed is deliberate: it
  turns a silent-drift risk into a hard test failure. See Flags for the
  follow-up this implies.
- **Subprocess interruption test**: a hidden, undocumented CLI subcommand
  (`orbit __install-transaction-rehearse <scenario.json>`, wired in
  `src/cli/orbit.ts`, not part of the `check` usage line and not invoked by
  any shipped flow) drives a scenario to a paused midpoint and is then
  `SIGKILL`ed by the test, mirroring
  `scripts/test-install-acceptance.sh`'s own `kill -9 -- "-$pid"` interruption
  scenario. The test asserts the target directory is untouched for any
  managed path not yet committed and that the staging directory is left at
  mode 0700 — the same two assertions the Phase 1 harness makes.

## Slice 2 — target and identity validation (this PR)

**Scope.** Two modules, split along the same "pure filesystem logic" vs.
"pure logic over sequential, injected `docker` facts" line the slice plan
drew:

- `src/lib/target-identity.ts`: `isPreprovisionedInput`, `validateTarget`,
  `readEnvironmentValue`, and `deriveComposeProjectName`, mirroring
  `is_preprovisioned_input` (install.sh:282-304), `validate_target`
  (install.sh:410-429), `read_environment_value` (install.sh:605-615), and
  `derive_compose_project_name` (install.sh:431-462). Direct `node:fs` calls
  against a caller-supplied target directory, exactly like slice 1's
  `install-transaction.ts` — no Docker, no network.
- `src/lib/database-volume-safety.ts`: `evaluateVolumeOwnership` and
  `verifyDatabaseVolumeSafety`, mirroring `volume_belongs_to_deployment`
  (install.sh:464-520) and `verify_database_volume_safety`
  (install.sh:522-586). These two bash functions decide from a *sequence*
  of `docker` command outputs, several conditional on what an earlier call
  returned (which container's image gets inspected depends on which
  container an earlier `docker ps` call turned up as the sole match) — closer
  to config-contract.ts's injected-facts shape than to slice 1's direct-fs
  shape, but a single flat facts bundle isn't enough to express the
  sequencing without duplicating install.sh's own branching a second time to
  decide which facts are even needed. Instead each individual `docker`
  invocation is one method on a caller-supplied adapter interface
  (`VolumeOwnershipAdapter` / `DatabaseVolumeSafetyAdapter`) — the "thin
  adapter at the edge" the slice plan calls for — while all sequencing,
  bounds-checking and decision logic is pure, synchronous TypeScript. No
  adapter implementation that actually shells out to `docker` ships in this
  slice; that belongs to the slice-5 orchestration work. A reference
  implementation exists only inside the parity test (see below), clearly
  commented as not shipped.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 1 / install.sh): 6 (`is_preprovisioned_input`'s strict unattended
pre-provisioning contract), 7 (`validate_target`'s refusal of an
unrecognizable non-empty target), 12 (`derive_compose_project_name`'s
project-name format and configured/requested-mismatch refusals), 13-14
(`volume_belongs_to_deployment`'s multi-check ownership proof and
docker-output bounds-checking), 15-16 (refuse an existing volume against an
empty target; refuse if more than one candidate volume exists), 17 (the
`database_volume_checked` TOCTOU re-verification of a single already-seen
volume), 18 (attaching to a proven volume requires the preserved
`postgres-password` secret at exactly mode 600).

**Non-goals for slice 2**: `verify_database_password_preserved`
(install.sh:588-595, guarantee #19) is intentionally out of scope — it
compares the live `postgres-password` secret against the *slice-1
transaction's own backup* (`InstallTransaction.originalDir`), so porting it
now would mean either reaching into slice 1's transaction from an
identity-validation module (wrong layering) or duplicating its backup
bookkeeping here. It belongs with the orchestration slice that actually
drives `InstallTransaction` and this slice's checks together. OIDC
discovery, `configure.sh` invocation, and asset fetching remain out of
scope, as before (slices 3-4).

**Testing and parity strategy.**

- **Unit tests** (`src/lib/target-identity.test.ts`,
  `src/lib/database-volume-safety.test.ts`): exhaustive branch coverage over
  fake adapters/fixtures, test names citing the guarantee numbers above.
- **Filesystem parity** (`src/lib/target-identity.parity.test.ts`): the same
  awk-by-function-name extraction and bash-driver pattern slice 1's
  `install-transaction.parity.test.ts` established, for
  `is_preprovisioned_input`, `validate_target`, and
  `derive_compose_project_name` plus their small dependencies
  (`is_regular_non_symlink_file`, `is_real_non_symlink_directory`,
  `target_is_empty`, `has_mode`, `read_environment_value`).
- **Docker-decision parity** (`src/lib/database-volume-safety.parity.test.ts`):
  since these two functions' decisions come from `docker` output rather than
  the filesystem, byte-for-byte state diffing doesn't apply the way it does
  for slice 1. Instead the test puts a single stub `docker` executable (a
  small Node script reading a JSON "docker world" scenario file) first on
  `PATH`, then drives *both* implementations against the identical stub: the
  real `volume_belongs_to_deployment` / `verify_database_volume_safety`
  bodies, extracted via the same awk pattern and run as bash; and this
  module's production decision logic, driven through a reference adapter
  (local to the test file, not shipped) whose methods issue the exact same
  `docker` argv install.sh itself uses. Both must reach the identical
  decision from the identical raw docker responses. This test caught a real
  bug during development: an early draft of `verifyDatabaseVolumeSafety` set
  `composeProjectNameExplicit=true` after discovering a pre-existing
  volume's Compose project label, but the real `install.sh:573` only
  assigns `compose_project_name` there and deliberately never touches
  `compose_project_name_explicit` — the parity test's comparison of bash's
  post-run globals against the TS module's returned state caught the
  discrepancy immediately.

## Slice 3 — OIDC discovery and configuration migration (this PR)

**Scope.** Two modules, split along the network/subprocess boundary each
crosses:

- `src/lib/oidc-discovery.ts`: `buildDiscoveryUrl`, `validateDiscoveryDocument`,
  `classifyOidcFetchResult`, and the `verifyOidcDiscovery` orchestrator,
  mirroring `verify_oidc_discovery` (install.sh:887-945). Unlike every module
  ported so far, this is not filesystem-only: fetching the discovery
  document is a network call (`curl`), and — deliberately, per guarantee
  #27 — the document's own untrusted JSON is *never* parsed by install.sh's
  own host process at all; it is parsed only inside a throwaway,
  network-isolated, capability-dropped Docker container. Both the curl call
  and the sandboxed-container call are injected adapters
  (`OidcDiscoveryFetchAdapter`, `OidcDiscoverySandboxAdapter`) with no
  production implementation shipped in this slice — the same "thin adapter
  at the edge, nothing shipped yet" shape slice 2's `database-volume-safety.ts`
  established for `docker`. `validateDiscoveryDocument` is a faithful port
  of the JS install.sh runs *inside* that sandboxed container
  (`oidc_discovery_parser`, install.sh:23-47) — it exists to prove semantic
  parity against the live script and to give the real adapter slice 5
  eventually ships something to call, but `verifyOidcDiscovery` itself never
  calls it directly against live network content; it only ever trusts the
  injected sandbox adapter's decision, exactly as install.sh only trusts the
  container's exit code.
- `src/lib/configuration-migration.ts`: `buildPreflightArgv`,
  `buildMigrateArgv`, `runConfigurationPreflight`, and
  `runConfigurationMigration`, mirroring `run_configuration_migration`
  (install.sh:1010-1029) and its `--preflight` companion call
  (install.sh:1441-1448). `scripts/configuration.sh` already has its own
  standalone, independently-tested `--preflight`/`--migrate --transaction`
  entry points (unlike install.sh's own transaction phase in slice 1), so
  this module deliberately does *not* reimplement `migrate_file`'s
  atomic-write/rollback-backup/provenance logic in TypeScript — that would
  duplicate a contract configuration.sh already proves, for no safety
  benefit and real drift risk. It ports only install.sh's own decision
  logic *around* the handoff: exactly which arguments to pass, and which of
  configuration.sh's two known-good stdout strings are accepted as success
  (guarantee #29) — anything else, including a plausible-looking but
  different string, is treated as failure. The subprocess call itself is a
  caller-supplied `ConfigurationScriptAdapter` with no shipped production
  implementation — a "handoff", not a port.

Both modules "wire onto slice 1's transaction and slice 2's validated
identity" as building blocks rather than deep imports:
`verifyOidcDiscovery` reuses `target-identity.ts`'s `readEnvironmentValue`
directly to read `OIDC_ISSUER`, and accepts a caller-supplied
`discoveryFilePath` so a future orchestrator can place it under an active
`InstallTransaction`'s own `stagingPathFor` staging area;
`ConfigurationMigrationTarget.composeProjectName` is documented as coming
from `target-identity.ts`'s `deriveComposeProjectName`, and both
configuration-migration calls are documented as needing to run inside an
active `InstallTransaction` so a preflight or migration failure rolls back
cleanly (part of guarantee #50). Neither module imports the other slices'
code directly — same deliberate decoupling slice 2's
`database-volume-safety.ts` chose over `install-transaction.ts`.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 1 / install.sh unless noted): 25 (OIDC discovery HTTP request pinned to
HTTPS-only, timeouts, and a size cap), 26 (discovery document only trusted
after independently re-confirming it landed as a regular non-symlink file,
forcing 600, and re-checking size — defense in depth beyond curl's own
limit), 27 (the discovery JSON itself is validated only inside the
sandboxed, network-isolated container, never by install.sh's own host
process), 29 (`run_configuration_migration` invokes migration only with
already-verified arguments and accepts only the two known-good output
strings). Also configuration.sh's own list (`docs/installer-guarantees.md`,
configuration.sh #18, #24): #18 (migration's idempotent "already current"
message, one of the two strings this slice's classifier accepts), #24
(`--transaction` is only accepted together with `--migrate`, which is why
`buildMigrateArgv` always emits both flags together). Part of guarantee #50
(preflight and migrate both run before any asset is installed, still
covered by the outer file-transaction rollback) is characterized by
`runConfigurationPreflight`/`runConfigurationMigration` existing as
composable calls meant to run inside an active `InstallTransaction`; the
"before any asset is installed" sequencing itself is orchestration that
belongs to slice 5, per the Non-goals below.

**Non-goals for slice 3**: no production adapter that actually shells
`curl` or `docker`, or that actually invokes `bash scripts/configuration.sh`,
ships in this slice — all three remain interfaces only, exercised in tests
via PATH-shimmed stub binaries or (for configuration.sh, which already has
real entry points) direct `spawnSync` of the unmodified script. Wiring real
adapters together with slice 1's transaction and slice 2's identity/volume
checks into the actual sequencing install.sh performs (when to fetch
discovery vs. run migration, staging-dir placement, and the
`configuration_migration_completed`-guarded double-call-site logic at
install.sh:1443-1448/1484-1487) is explicitly deferred to slice 5's full
orchestration work. `stage_guided_install_configuration` and
`prepare_configuration` (driving `scripts/configure.sh` itself, including
the `ORBIT_CONFIGURE_PROMPTS=machine` protocol from #297) remain slice 4,
unchanged from the top-level plan.

**Testing and parity strategy.**

- **Unit tests** (`src/lib/oidc-discovery.test.ts`,
  `src/lib/configuration-migration.test.ts`): exhaustive branch coverage
  over fake adapters/fixtures (including real temporary files and a real
  symlink for the discovery-file safety checks), test names citing the
  guarantee numbers above.
- **OIDC discovery parity** (`src/lib/oidc-discovery.parity.test.ts`), two
  parts: (1) `oidc_discovery_parser`'s exact JS is awk-extracted verbatim
  from the live install.sh and executed for real via
  `node --input-type=commonjs -e`, compared against
  `validateDiscoveryDocument` for identical raw stdin across ~10 fixtures
  (issuer mismatch, malformed JSON, non-object/array/null document, missing
  or non-string endpoint fields, non-https/credentialed/fragment-bearing
  endpoints, oversized input); (2) `verify_oidc_discovery` itself is
  awk-extracted along with its `is_regular_non_symlink_file`/
  `read_environment_value` dependencies and run as bash, with a single stub
  `curl`/`docker` pair (Node scripts reading a JSON scenario file) put
  first on `PATH` — the same PATH-shim seam slice 2's stub `docker`
  established — so both the real script and `verifyOidcDiscovery`'s
  production orchestration observe identical fetch/sandbox responses across
  8 scenarios (success; missing `OIDC_ISSUER`; curl exit 63 and 7;
  HTTP 500; a symlinked destination; an oversized on-disk file; sandbox
  rejection) and are asserted to reach the identical `{reason, action,
  message}`, not just the identical pass/fail.
- **Configuration migration parity** (`src/lib/configuration-migration.
  parity.test.ts`): unlike install.sh's transaction phase, configuration.sh
  already has real `--preflight`/`--migrate --transaction` entry points, so
  this test spawns the real, unmodified script directly (stronger than
  function extraction — the same technique `config-contract.parity.test.ts`
  uses for `configure.sh --check`) through a reference adapter local to the
  test file (not shipped), driven entirely through this module's own
  `buildPreflightArgv`/`buildMigrateArgv`. Four scenarios: an
  already-current file (idempotent message), a legacy unversioned file
  (migration message with `schema v0`/`legacy/unknown` provenance text), a
  structurally invalid file (preflight fails closed), and a Compose project
  mismatch (migration fails closed) — each asserted against this module's
  exact output, not just exit-code parity.

## Flags (bash characterized, not changed)

### Slice 1

- `install.sh`'s transaction phase (`preflight_final_paths` /
  `prepare_rollback_area` / `rollback_transaction`) has no standalone
  `--preflight`-style entry point the way `configuration.sh` does. This
  weakens slice 1's parity test to function-level source extraction rather
  than whole-script `spawnSync` comparison (the pattern
  `config-contract.parity.test.ts` uses). Not a defect — the transaction was
  never designed to run standalone — but if tighter script-level parity is
  wanted before the slice-5 bootstrap flip, consider adding an internal
  self-test flag to `install.sh` as a follow-up. Flagging for owner
  awareness rather than changing `install.sh`.
- `SIGKILL` cannot be trapped by either Bash or Node, so neither
  implementation can guarantee automatic rollback after a hard kill; both
  rely on the same operator-driven recovery step (inspect the preserved
  `.orbit-install-staging.*` evidence, then remove it before rerunning,
  exactly as `scripts/repair.sh`'s `staging-evidence-present` finding and
  the #261 comment on this issue describe). Slice 1 characterizes this as
  the existing contract rather than attempting to add crash-resume, which
  `install.sh` does not have either.
- No behavioral discrepancy in the transaction logic itself was found
  during this read; the two items above are process/tooling notes, not
  correctness concerns.

### Slice 2

- `derive_compose_project_name` reads and writes `compose_project_name` /
  `compose_project_name_explicit` as bash globals that, in principle, could
  persist across multiple calls within one script run (an `elif
  "$compose_project_name_explicit" == 1: return` early-exit exists for
  exactly that case). `install.sh` has exactly one call site for this
  function (inside `verify_database_volume_safety`), so that branch is dead
  code today. `deriveComposeProjectName` therefore models a single,
  self-contained call and does not accept or return prior-call state. If a
  future slice ever calls it a second time within one run, this
  simplification needs revisiting.
- No shipped `docker` adapter exists yet for `database-volume-safety.ts` —
  by design, per the scope note above. The parity test's reference adapter
  (shelling out via `execFileSync`, matching bash's own blocking
  `$(docker ...)` calls) is a reasonable template for the slice-5
  orchestration work but is deliberately not exported from the module.
- One real discrepancy was found and fixed during this port (not merely a
  process/tooling note, unlike slice 1's two items above):
  `verifyDatabaseVolumeSafety`'s first draft set
  `composeProjectNameExplicit=true` after a successful ownership proof;
  `install.sh:573` does not do this. Fixed before landing; see the code
  comment at the fix site and the parity-test note above.
- `verify_database_password_preserved` (guarantee #19) remains unported —
  see Non-goals above. Flagging again here since it is the one guarantee in
  install.sh's target/identity/volume-safety neighborhood (#6-19) that this
  slice does not characterize at all.

### Slice 3

- No production adapter that shells `curl`, `docker`, or
  `bash scripts/configuration.sh` ships in this slice — by design, the same
  "handoff/adapter, not a shipped call" non-goal slice 2 established for
  `docker`. The parity tests' reference/stub implementations are reasonable
  templates for the slice-5 orchestration work but are deliberately not
  exported from either module.
- `verifyOidcDiscovery`'s on-disk file-safety check (guarantee #26) is
  ported through a single file descriptor (open with `O_NOFOLLOW`, then
  `fstat`/`fchmod`/`fstat` on that descriptor) rather than install.sh's own
  three separate path-based operations (`is_regular_non_symlink_file`,
  `chmod`, `stat`) — a strict tightening (no stat-then-use window) rather
  than a behavioral difference for any fixture where nothing races the
  installer between checks; install.sh itself has this TOCTOU window and
  this port deliberately closes it rather than reproducing it, per this
  slice's CodeQL "no stat-then-use pattern" requirement. The final
  "sandbox adapter reads `documentPath` fresh" step still mirrors
  install.sh's own two-open sequence exactly (a second, separate open of the
  same path) since that boundary is documented as belonging to a real
  adapter's implementation, which does not exist yet in this slice.
- `run_configuration_migration`'s output classification
  (`runConfigurationMigration`) explicitly strips trailing newlines from the
  adapter's raw stdout before matching, mirroring bash's own
  `migration_output="$(...)"` command-substitution semantics (which strips
  *all* trailing newlines, not just one) — a caller-supplied adapter that
  returns raw, un-stripped subprocess stdout still classifies correctly.
- `configuration-migration.ts` intentionally does not encode install.sh's
  own sequencing of *when* preflight/migration run relative to asset
  staging and the guided-configuration path (the
  `configuration_migration_completed`-guarded two-call-site logic at
  install.sh:1443-1448/1484-1487) — see Non-goals above. A future slice-5
  orchestrator owns that state machine; this slice only proves the two
  calls it does make are individually correct.
- No behavioral discrepancy in either ported function's own decision logic
  was found during this port; the items above are process/tooling notes and
  one deliberate strengthening (the file-descriptor TOCTOU closure), not
  correctness concerns.
