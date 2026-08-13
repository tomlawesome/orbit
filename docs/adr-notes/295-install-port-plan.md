# #295 slice plan: port the guided/unattended install flow to the orbit CLI

Status: proposed (slices 1-5 implemented; the bootstrap flip itself — issue
#295's own release decision to switch `install.sh`'s dispatch or
`orbit-launcher`'s fetch target to the CLI path — has not happened). This is
a working note, not an ADR —
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

## Slice 4 — guided configuration driving (this PR)

**Scope.** `src/lib/guided-configuration.ts`: `stageGuidedInstallConfiguration`
and `prepareConfiguration`, mirroring `stage_guided_install_configuration`
(install.sh:1031-1077) and `prepare_configuration` (install.sh:947-1008),
plus the small decision helpers they call directly —
`missingRequiredFields`, `missingGuidedFields`, `missingConfigurationFields`
(install.sh:843-877) and `noninteractiveConfigurationGuidance`
(install.sh:879-885).

install.sh itself always hands the real controlling terminal to
`scripts/configure.sh` for these flows (`bash scripts/configure.sh --init`,
with `ORBIT_CONFIGURE_PROMPTS` never set — docs/engine-events.md's own
"Machine prompts (v0)" section says so explicitly: "install.sh never sets
this variable"). The CLI port has no `/dev/tty` to hand a child process, so
per the top-level plan this slice always drives configure.sh's guided
fields (`APP_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`)
through the #297 `ORBIT_CONFIGURE_PROMPTS=machine` line grammar instead of
TTY prompting — the same grammar
`scripts/engine-prompt-renderer.fixture.mjs` already demonstrates driving
generically as the schema-blind reference consumer. `parseMachinePromptLine`
reimplements that grammar (the same four line shapes and field/kind/reason
vocabulary, not a new variant of it) as a pure, typed parser with no adapter
of its own.

Every `configure.sh` invocation the two ported functions make — `--init`,
the bare default invocation, `--set-oidc-secret`, `--set-deployment-profile`,
and `--check` — is one method on a caller-supplied
`GuidedConfigurationAdapter`, the same "thin adapter at the edge, nothing
shipped yet" shape slice 2's `database-volume-safety.ts` and slice 3's
`configuration-migration.ts`/`oidc-discovery.ts` established; no production
implementation ships in this slice. Unlike every adapter shipped so far
(each models one blocking `$(cmd ...)` call as a synchronous method), the
two machine-prompt methods (`runInit`, `runSetOidcSecret`) model a live,
multi-round stdin/stdout exchange with a real child process and are
declared `async` — see Flags. Deciding the actual answer values that feed
a `MachinePromptAnswerProvider` (from CLI flags, environment, or a future
interactive UI) and the final apply/cancel review decision
(`GuidedConfigurationAdapter.confirmApply`) are both out of scope for this
slice — collecting those is explicitly deferred to slice 5's
orchestration/wiring work, per the plan's own slice boundary.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 1 / install.sh): 24 (`prepare_configuration`'s non-interactive refusal
with install.sh's exact remediation guidance when required fields are
missing and no controlling terminal is available), 28 (re-verifying
`.env-orbit`/`.orbit-secrets` are still a regular non-symlink file and a
real non-symlink directory after every configure.sh invocation that mutates
configuration), 30 (`stage_guided_install_configuration` only activates for
a fresh, wizard-mode install with no pre-existing `.env-orbit`/
`.orbit-secrets`, not even as a symlink), 31 (every step of guided-install
configuration runs against the staged copy, and the returned outcome
carries install.sh's own "the target remains unchanged" framing on every
failure path), 32 (a final "apply" decision is required before the caller
may treat the result as staged/committable).

**Non-goals for slice 4**: no production `GuidedConfigurationAdapter`
implementation that actually spawns `bash scripts/configure.sh` ships in
this slice — by design, the same non-goal slices 2-3 established for
`docker`/`curl`/`configuration.sh`. Deciding *where* `configureScript`
points (the staging directory for `stage_guided_install_configuration`, the
target's own tree for `prepare_configuration` — both accepted as a plain
path parameter, exactly like `configuration-migration.ts`'s
`configurationScript` argument), sourcing real answer values for a
`MachinePromptAnswerProvider`, implementing `confirmApply` as an actual
CLI prompt, and wiring both functions onto slice 1's `InstallTransaction`
staging area are all explicitly deferred to slice 5's full orchestration
work, per the top-level plan. `resolve_installer_action` and
`choose_deployment_profile` (install.sh:684-841 — the profile-selection
wizard that decides `profileChange`/`selectedProfile`/`selectedModel`
*before* either ported function runs) are out of scope: this slice accepts
their outputs as caller-supplied context fields, the same "accept the
already-decided fact" stance `configuration-migration.ts` takes toward
`target-identity.ts`'s `deriveComposeProjectName`. `has_controlling_terminal`
(install.sh:597-603) is likewise accepted as an injected boolean fact rather
than independently probed — this module has no `/dev/tty` of its own to
open, the same injected-facts convention `target-identity.ts` and
`database-volume-safety.ts` already established for filesystem/docker
facts.

**Testing and parity strategy.**

- **Unit tests** (`src/lib/guided-configuration.test.ts`): exhaustive branch
  coverage over a fake `GuidedConfigurationAdapter` and real temporary
  directories for the filesystem re-verification checks, test names citing
  the guarantee numbers above — every skip condition, every failure
  message, the ai/full-only model argument, and every branch of
  `prepareConfiguration`'s two-stage readiness/guided-fallback/final-refusal
  structure.
- **Source-extraction parity** (`missing_required_fields`,
  `missing_guided_fields`, `missing_configuration_fields`,
  `print_noninteractive_configuration_guidance`): the same awk-by-function-
  name extraction and bash-driver pattern slice 1's
  `install-transaction.parity.test.ts` and slice 2's
  `target-identity.parity.test.ts` established, since install.sh has no
  standalone entry point for these helpers either. Compared byte-for-byte
  against this module's pure functions across readiness fixtures covering
  every field category (required, guided-only, optional-service, and
  empty).
- **Real machine-prompt-exchange parity**: unlike install.sh's transaction
  phase, `scripts/configure.sh` already has real, independently-invocable
  `--init` and `--set-oidc-secret` entry points, so — the same strategy
  slice 3's `configuration-migration.parity.test.ts` uses for
  `configuration.sh --preflight`/`--migrate` — this test spawns the real,
  unmodified script directly with `ORBIT_CONFIGURE_PROMPTS=machine`, driven
  through a reference adapter local to the test file (not shipped) built
  only from this module's exported `parseMachinePromptLine`. This proves
  the exported grammar parser actually drives the live script to a
  completed guided configuration, not just a hand-rolled stub: a successful
  three-field `--init` run (asserting the resulting `.env-orbit` content
  and that no prompt line or captured stdout ever contains an answer
  value), a reject-then-accept retry (`not-https` reason, `attempt=2`), a
  third-rejection abort (`empty` reason, exactly three prompts then
  `prompt-abort`, no `.env-orbit` written — guarantee configure.sh #14),
  and `--set-oidc-secret` success/`empty`/`too-large` scenarios (asserting
  the persisted secret file's content while asserting the secret value
  itself never appears in the child process's stdout or stderr).

## Slice 5 — full orchestration and explicit CLI entry points (this PR)

**Scope.** `src/lib/install-orchestrator.ts`: `runInstall`, the single
function that drives slices 1-4's pure modules plus this slice's own new
pure modules through install.sh's exact main-flow sequencing
(install.sh:1259-1556) against caller-injected adapters. Four supporting
pure modules new to this slice:

- `src/lib/image-resolution.ts`: `resolveImageIdentity`, mirroring
  install.sh's inline digest/revision/version/banner resolution
  (install.sh:1264-1310 — this sequence has no named bash function of its
  own, unlike everything ported by slices 1-4).
- `src/lib/deployment-assets.ts`: the `deployment_assets`/`deployment_scripts`
  array literals and their directory/managed-path derivation
  (install.sh:1313-1342), transcribed and extraction-parity-tested rather
  than behaviourally ported (there is no decision logic here, just fixed
  data).
- `src/lib/deployment-profile.ts`: `isValidLocalModel`, `currentDeploymentProfile`
  (install.sh:617-661), and `resolveNonInteractiveProfileSelection` — the
  *only* branch of `resolve_installer_action`/`choose_deployment_profile`
  this slice drives (see Non-goals).
- `src/lib/health-wait.ts`: `waitForComponentHealth`, mirroring
  `wait_for_component_health`'s outer wall-clock wait loop
  (install.sh:1107-1123) against an injected `Clock` so it needs no real
  sleeping in tests.
- `src/lib/engine-event.ts`: the plain-mode `phase=... component=...
  state=... reason=... action=... elapsed=Ns` line format and vocabulary
  (docs/engine-events.md), ported from `installer-ui.sh`'s `installer_ui_emit`
  (installer-ui.sh guarantee #1) — this is how `runInstall`'s `onEvent`
  callback satisfies issue #295's own acceptance criterion ("Uses the #260
  semantic-event vocabulary for all user-facing progress").

This slice also ships the production adapters every earlier slice
deliberately left as an interface with no implementation (see "Deferral
accounting" below): `src/lib/install-docker-adapter.ts`,
`src/lib/install-curl-adapter.ts`, and `src/lib/install-script-adapters.ts`.
Every adapter method spawns a fixed argv array via `spawnSync`/`spawn` —
never a shell string — mirroring issue #296's own
`createDockerCompose*Adapter` convention.

Finally, `src/cli/orbit.ts` gains two explicit commands: `orbit install --dir
<deployment>` and `orbit update --dir <deployment>`, wiring the real
adapters and `runInstall` together, gathering and validating
`ORBIT_REPOSITORY`/`ORBIT_REGISTRY`/`ORBIT_CHANNEL`/`COMPOSE_PROJECT_NAME`/
`ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS`/`ORBIT_INSTALLER_POLL_INTERVAL_SECONDS`
from the environment exactly as install.sh's own top-of-script checks do
(install.sh:13-20,123-145), and printing the `engine-event.ts`-formatted
event stream plus install.sh's own failure/guidance text to stdout/stderr.
Unlike `check`, which defaults an omitted `--dir` to the current directory,
`install`/`update` refuse outright without one — see Flags.

**Guarantees characterized** (catalogue numbers, `docs/installer-guarantees.md`
Part 1 / install.sh): 19 (`verify_database_password_preserved` — deferred by
slice 2, now ported as `verifyDatabasePasswordPreserved` in
install-orchestrator.ts, driven against `InstallTransaction.originalDir` and
the second `verifyDatabaseVolumeSafety` call site together, exactly the
combination slice 2 said this required), 21 (install/update target-action
guard), 23 (`current_deployment_profile`), 24 (non-interactive configuration
guidance — now actually surfaced to the caller; see Flags for the bug this
fixed), 25-29 (OIDC discovery and configuration migration, now driven by
shipped adapters instead of only a parity test's local reference adapter),
30-32 (guided configuration, likewise), 33 (bounded health probes — Node's
own `spawnSync` timeout, not GNU `timeout`; see Flags), 34 (embedded
`app_readiness_probe` JS, byte-parity-tested), 35 (`wait_for_component_health`'s
outer wait loop), 36 (per-profile service-image skip), 37 (`compose down`
only on a failed fresh install, never a failed update), 38 (liveness-probe
disambiguation), 40 (docker/curl availability — GNU `timeout` dropped, see
Flags), 41-44 (image identity resolution), 45 (fixed asset allowlist +
`bash -n` syntax check — see Flags for a real bug this slice found and
fixed), 46-51 (transaction preflight/backup/TOCTOU-recheck, reused unchanged
from slice 1 via `InstallTransaction`), 50 (preflight+migrate before any
asset is installed, both call sites' `configuration_migration_completed`-
guarded sequencing — the one piece slice 3 explicitly deferred to this
slice), 52-54 (atomic staged writes, reused from slice 1), 55-56 (Compose
config validation gating commit; commit as the sole rollback authority,
service startup outside the file transaction's scope).

**Non-goals for slice 5**: 20/39 (the `ai`/`full` profile's separate,
explicitly-confirmed model-download step) — this CLI never collects a
requested-model-to-pull value at all (`context` has no such field), so
`prepare_service_images`'s model-pull branch is simply never reached; not a
narrowed guarantee (nothing *incorrectly* downloads a model), but a real
capability gap relative to install.sh's interactive path, tracked here for
visibility. 22 (the `repair` action) is not wired into this CLI at all —
`InstallOrchestratorContext.requestedAction` only accepts `"install"` and
`"update"`; issue #261's repair execution work is a separate track per the
top-level plan's own citation of it. The interactive profile-selection
wizard (`choose_deployment_profile`) and a real, answer-collecting
`GuidedConfigurationAdapter.confirmApply`/`MachinePromptAnswerProvider`
surface remain unimplemented from the CLI's side: `src/cli/orbit.ts` always
passes `hasControllingTerminal: false` and an adapter whose `answer()`
throws (documented as unreachable, since guided configuration self-skips
entirely and `prepareConfiguration`'s guided-fallback branch is likewise
never taken when there is no controlling terminal) — collecting real answer
values from CLI flags/environment/a future interactive UI, and distinguishing
a declined review from an input-channel failure again (slice 4's own
`confirmApply` collapsing, still unresolved), are deferred beyond this
5-slice plan entirely. The bootstrap flip itself — switching `install.sh`'s
dispatch or `orbit-launcher`'s fetch target to this CLI path — is
unattempted here, per the top-level plan's own explicit release-decision
gating on the full Phase 1 acceptance harness passing against the CLI entry
point.

**Testing and parity strategy.**

- **Unit tests** for each new pure module (`deployment-assets.test.ts`,
  `deployment-profile.parity.test.ts`, `engine-event.test.ts`,
  `health-wait.test.ts`, `image-resolution.test.ts`) — extraction parity for
  the two modules with a direct bash counterpart to awk-extract
  (`deployment-assets.ts`'s array literals, `deployment-profile.ts`'s
  `is_valid_local_model`/`current_deployment_profile`), byte-parity against
  `docs/engine-events.md`'s own vocabulary lists for `engine-event.ts`, and
  fixture/fake-clock unit coverage for the two with no bash counterpart to
  extract (`image-resolution.ts`'s inline resolution sequence,
  `health-wait.ts`'s wait loop).
- **Shipped-adapter argv coverage**
  (`install-docker-adapter.docker-adapter.test.ts`,
  `install-curl-adapter.test.ts`): a fake `docker`/`curl` binary (a bash
  script, not Node — `docker compose --env-file <path>` collides with
  Node 20.6+'s own `--env-file` CLI-flag interception, so the fake must be
  bash) put first on `PATH` logs every invocation's exact argv, asserted
  against install.sh's own cited call sites for every method — including
  `install-docker-adapter.ts`'s reuse of slice 2's own
  `VolumeOwnershipAdapter`/`DatabaseVolumeSafetyAdapter` argv shapes, so the
  now-shipped adapter is checked against the exact interface slice 2's
  parity test already proved correct.
- **Shipped-adapter byte parity**
  (`install-docker-adapter.parity.test.ts`): the three embedded Node source
  strings this adapter ships (`app_readiness_probe`, `tika_readiness_probe`,
  `oidc_discovery_parser`) are awk-extracted verbatim from the live
  install.sh and compared byte-for-byte — these are the exact bytes the
  resolved Orbit image's own container runs, so a literal byte-compare is
  the correct strategy rather than a behavioural comparison.
  `deployment-assets.test.ts` uses the same awk-extraction technique for the
  `deployment_assets`/`deployment_scripts` array literals.
- **Shipped-adapter whole-script coverage**
  (`install-script-adapters.test.ts`): unlike the docker/curl adapters
  above (PATH-shimmed fakes), `configuration.sh` and `configure.sh` already
  have real, independently-invocable entry points, so this test spawns the
  *real, unmodified* scripts directly through the shipped adapters — not a
  parity test's own local, unshipped reference adapter — including a real
  `ORBIT_CONFIGURE_PROMPTS=machine` exchange for the guided-install path,
  proving the shipped `runMachinePromptSession` driving loop actually
  completes a live, multi-round subprocess exchange correctly, not just a
  hand-rolled stub. A real (not fake) `docker build --target vapid-generator`
  fixture image lets `configure.sh`'s own VAPID-key generation step run
  without a registry pull or `git rev-parse`.
- **Orchestrator driven-flow coverage**
  (`install-orchestrator.test.ts`): install.sh's main flow has no
  standalone entry point at all (it *is* the whole script), so there is
  nothing to awk-extract or spawn for `runInstall` itself the way every
  other parity test in this port works — this suite instead proves
  `runInstall` *sequences and wires* slices 1-4's already-proven pure
  modules correctly, against fully synchronous/immediate fake adapters (a
  fake `Clock` drives `health-wait.ts` deterministically, matching
  `health-wait.test.ts`'s own pattern — no real sleeping or subprocess I/O
  anywhere in this suite): a full success path for both a pre-provisioned
  fresh install and an update against a recognized existing deployment, a
  full guided-install success path with a controlling terminal, and one
  test per major fail-closed short-circuit (target/action guards, host-tool
  availability, database-volume-safety wiring — including that a genuine
  adapter bug propagates as a rejected promise rather than being swallowed
  into a graceful failure — image identity, asset fetch/syntax-check,
  guided-configuration cancellation/failure, non-interactive configuration
  guidance, OIDC discovery, transactional rollback-on-failure and
  no-rollback-after-commit, service-start teardown-on-fresh-install-only,
  and health-probe timeout/liveness-disambiguation). One test directly
  proves the Compose-project-name live-reassignment fix (see Flags): an
  update against a target whose fallback basename differs from a
  pre-existing volume's own proven Compose project label ends up issuing
  every `compose pull`/`compose up` call with the *discovered* name, not the
  stale fallback the adapter was originally constructed with.
- **CLI wiring coverage** (`src/cli/orbit.install.test.ts`): spawns the real
  `orbit install`/`orbit update` commands as a subprocess (the same
  `node <tsx> src/cli/orbit.ts <command>` technique
  `config-contract.parity.test.ts` already established for `check`), with an
  explicit `timeout` on every spawn. This suite does not re-prove
  `install-orchestrator.ts`'s own logic or any single adapter's argv shape
  (already covered above) — only that the CLI layer itself is wired
  correctly: `--dir` is required (refuses without it, unlike `check`),
  every environment variable is validated with install.sh's own exact
  messages, an absent target directory is created, and a real `runInstall()`
  actually runs end-to-end as a subprocess against a fake `docker` on `PATH`,
  observable via documented exit codes and the plain-mode event stream on
  stdout.

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

### Slice 4

- **Deliberate protocol substitution, not a characterization of unchanged
  behavior**: install.sh's own `stage_guided_install_configuration` and
  `prepare_configuration` hand the real controlling terminal to
  `scripts/configure.sh` (`--init`/`--set-oidc-secret` with no
  `ORBIT_CONFIGURE_PROMPTS` set) — install.sh never uses machine-prompt mode
  itself. This port always drives those two calls with
  `ORBIT_CONFIGURE_PROMPTS=machine` instead, per the top-level plan's own
  wording ("driving `scripts/configure.sh` ... from the CLI instead of a
  human terminal"). The underlying validators configure.sh calls are
  identical either way (docs/engine-events.md "Machine prompts (v0)"
  §Validation: "exactly the same validator functions the TTY prompts call
  today"), so this is a substitution of the *transport*, not a change to
  what is accepted — but it is a real, intentional divergence from
  install.sh's own literal call shape at these two sites, flagged here for
  owner visibility rather than buried in the Scope section.
- **`confirmApply` collapses two distinct bash outcomes into one**:
  install.sh's final review menu (install.sh:1064-1071) distinguishes a
  clean "cancel" choice (fixed exit 130) from a non-zero `$status` returned
  by `installer_ui_select` itself (e.g. a read error on `/dev/tty`) and
  propagates that status verbatim. Since `confirmApply` is an injected,
  unshipped adapter method with no real interactive implementation in this
  slice, `stageGuidedInstallConfiguration` collapses both into a single
  `{status: "cancelled"}` outcome. A future slice-5 implementation of
  `confirmApply` may want to distinguish "operator declined" from "input
  channel failed" again; revisit then.
- **Async adapter methods, a first for this port**: `runInit` and
  `runSetOidcSecret` are declared `Promise`-returning, unlike every adapter
  method shipped in slices 2-3 (each modeled as a synchronous method
  mirroring bash's own blocking `$(cmd ...)` substitution). A live,
  multi-round machine-prompt exchange has no synchronous Node equivalent of
  a single blocking subprocess call, so this slice breaks with the prior
  convention rather than force an artificial synchronous shape onto a
  fundamentally interactive protocol. The other four adapter methods
  (`runDefault`, `runSetDeploymentProfile`, `runCheck`, and `confirmApply`)
  keep the established synchronous-or-simple-async shape consistent with
  their bash originals.
- **`has_controlling_terminal` and the profile-selection wizard are
  injected facts, not ported logic**: `has_controlling_terminal`
  (install.sh:597-603) is accepted as a caller-supplied boolean, and
  `profileChange`/`selectedProfile`/`selectedModel` are accepted as
  already-decided context fields rather than this slice porting
  `resolve_installer_action`/`choose_deployment_profile`
  (install.sh:684-841) itself — see Non-goals above. Both are consistent
  with this port's own established injected-facts convention, not new
  simplifications invented for this slice.
- No production `GuidedConfigurationAdapter` implementation ships in this
  slice — by design, the same non-goal slices 2-3 established for
  `docker`/`curl`/`configuration.sh`. The parity test's reference adapter
  (spawning the real script and driving it via this module's own
  `parseMachinePromptLine`) is a reasonable template for the slice-5
  orchestration work but is deliberately not exported from the module.
- No behavioral discrepancy was found in `missing_required_fields`,
  `missing_guided_fields`, `missing_configuration_fields`, or
  `print_noninteractive_configuration_guidance`'s ported logic during this
  port; all four are confirmed byte-for-byte against the extracted,
  unmodified install.sh source.

### Slice 5

**Deferral accounting** (every "no production adapter ships" / "reasonable
template, not exported" note from slices 2-4, resolved by name):

- Slice 2's `database-volume-safety.ts` docker adapters
  (`VolumeOwnershipAdapter`/`DatabaseVolumeSafetyAdapter`): shipped as part
  of `install-docker-adapter.ts`, using the exact argv shapes documented in
  `database-volume-safety.ts`'s own method comments —
  `install-docker-adapter.docker-adapter.test.ts` asserts this directly
  against slice 2's own documented format strings.
- Slice 2's `verify_database_password_preserved` (guarantee #19): shipped as
  `verifyDatabasePasswordPreserved` in `install-orchestrator.ts`, driven
  against `InstallTransaction.originalDir` and the second
  `verifyDatabaseVolumeSafety` call site together — exactly the combination
  slice 2 said this guarantee needed and which neither module alone could
  provide.
- Slice 3's `OidcDiscoveryFetchAdapter` (curl half): shipped as
  `createInstallOidcFetchAdapter` in `install-curl-adapter.ts`.
- Slice 3's `OidcDiscoverySandboxAdapter` (sandboxed-container half):
  shipped as `validateOidcDiscoverySandbox` in `install-docker-adapter.ts`.
  Its second, separate open of `documentPath` deliberately does not add its
  own `O_NOFOLLOW` re-check on top of `oidc-discovery.ts`'s own
  `verifyDiscoveryFileSafety` — per that module's own doc, this mirrors
  install.sh's own two-open sequence exactly, a documented boundary, not an
  oversight.
- Slice 3's `ConfigurationScriptAdapter`: shipped as
  `createInstallConfigurationScriptAdapter` in `install-script-adapters.ts`,
  driven entirely through `configuration-migration.ts`'s own
  `buildPreflightArgv`/`buildMigrateArgv` — `install-script-adapters.test.ts`
  spawns the real, unmodified `configuration.sh` through it.
- Slice 3's own deferred sequencing non-goal ("does not encode install.sh's
  own sequencing of *when* preflight/migration run relative to asset
  staging"): now owned by `install-orchestrator.ts`, which reproduces
  install.sh's exact `configuration_migration_completed`-guarded
  two-call-site logic (install.sh:1443-1448/1484-1487) — the first call site
  runs only for an *existing* `.env-orbit`, before any fetched asset is
  moved into place; the second runs only if the first never did.
- Slice 4's `GuidedConfigurationAdapter`: shipped as
  `createInstallGuidedConfigurationAdapter` in `install-script-adapters.ts`.
  `runInit`/`runSetOidcSecret` drive a real `ORBIT_CONFIGURE_PROMPTS=machine`
  exchange via the shipped `runMachinePromptSession`, proven against the
  real, unmodified `configure.sh` in `install-script-adapters.test.ts` —
  not just the parity test's own local, unshipped reference adapter.
- Slice 4's "where `configureScript` points" non-goal: resolved by
  `install-orchestrator.ts` — the staging directory's own copy
  (`scratchDir/scripts/configure.sh`) for `stageGuidedInstallConfiguration`,
  the target's own just-installed tree
  (`<targetDir>/scripts/configure.sh`) for `prepareConfiguration`, exactly
  as slice 4's own module comment anticipated.
- Slice 4's "sourcing real answer values for a `MachinePromptAnswerProvider`",
  "implementing `confirmApply` as an actual CLI prompt", and "the
  interactive profile-selection wizard" (`choose_deployment_profile`):
  **not** resolved by this slice — see Non-goals above. `src/cli/orbit.ts`
  hardcodes `hasControllingTerminal: false` and an answer provider that
  throws if ever reached (confirmed unreachable by
  `install-orchestrator.test.ts`'s own guided-configuration tests, which
  only exercise the machine-prompt path with `hasControllingTerminal: true`
  supplied directly to `runInstall`, not through the CLI). A future slice
  beyond this 5-slice plan owns adding a real interactive/CLI-flag answer
  surface.
- Slice 4's `confirmApply` two-outcomes-collapsed-into-one simplification:
  unchanged and still unresolved, for the same reason — the shipped
  adapter's `confirmApply` always resolves `"apply"` and is unreachable from
  this CLI today, so there is nothing yet to distinguish "operator declined"
  from "input channel failed" for.

**Real discrepancies found and fixed during this slice** (not process/tooling
notes, unlike most items above — see the git history for the exact diffs):

- **Missing scratch-directory `mkdir -p` before nested asset fetches.** The
  inherited `install-orchestrator.ts` fetched every `deployment_assets`
  entry into `scratchDir` without first creating the asset's own parent
  directory the way install.sh does unconditionally before every fetch
  (install.sh:1406-1407, guarantee #45). Since `config/tika-config.xml` and
  every `scripts/*` entry live in a subdirectory that does not otherwise
  exist yet, a real `curl --output` into that path fails immediately with
  exit 23 (confirmed by direct reproduction against the real `curl`
  binary) — every real install/update run would have failed at the very
  first nested asset, before ever reaching `docker`. Fixed by adding the
  same unconditional per-asset `mkdirSync(dirname(destination), {recursive:
  true})` install.sh itself performs; `install-orchestrator.test.ts`'s own
  success-path tests use a fake `fetchAsset` that (like the real adapter)
  never creates its own destination directory, so they now serve as
  regression coverage for this fix.
- **Stale Compose project name in the shipped docker adapter.**
  `createInstallDockerAdapter` captured `composeProjectName` once at
  construction time; install.sh's own `compose()` helper
  (install.sh:258-260) instead reads the bash global `$compose_project_name`
  fresh on every call, so a later reassignment
  (`verify_database_volume_safety`'s own `compose_project_name =
  $discovered_project`, install.sh:573, when a pre-existing volume's proven
  owner differs from the name a fallback derivation would have produced) is
  observed by every subsequent `compose` call in bash but would have been
  silently ignored by the TS adapter, constructed before that resolution
  could possibly be known. Fixed by making `composeProjectName` mutable
  inside `createInstallDockerAdapter` and adding a
  `setComposeProjectName(name)` method to `InstallDockerAdapter`;
  `install-orchestrator.ts` calls it immediately after the first
  `verifyDatabaseVolumeSafety` call resolves the final name and before any
  `compose`-wrapped method is ever invoked (the ordering install.sh itself
  guarantees, since `derive_compose_project_name` only ever runs once, at
  the very top of `verify_database_volume_safety`, itself the first `docker`
  call site in the whole script). `install-orchestrator.test.ts` and
  `install-docker-adapter.docker-adapter.test.ts` both cover this directly.
- **`ComposeProjectNameRefusal` uncaught inside `install-orchestrator.ts`'s
  first `verifyDatabaseVolumeSafety` call.** `deriveComposeProjectName`
  (called from inside `verifyDatabaseVolumeSafety`'s own first-call branch,
  per slice 2's own design) throws `ComposeProjectNameRefusal` directly,
  never wrapped in a `DatabaseVolumeSafetyRefusal` — a gap the inherited
  orchestrator's original blanket `catch (error) { return fail(...,
  (error as DatabaseVolumeSafetyRefusal).message) }` happened to paper over
  by reading `.message` off *any* thrown value, refusal or not (see the next
  item). Once that blanket catch was tightened, this became a real
  unhandled-rejection risk: fixed by catching both refusal types at that one
  call site, since bash's own `derive_compose_project_name` failing there is
  exactly as fatal, at exactly the same phase, as any other
  `verify_database_volume_safety` refusal.
- **Overly broad `catch (error)` blocks that would have swallowed genuine
  programming errors into graceful `{status:"failed"}` outcomes.** Four call
  sites in the inherited `install-orchestrator.ts` caught *any* thrown value
  from `validateTarget`/`verifyDatabaseVolumeSafety`/`InstallTransaction.begin`
  and blindly cast it to the one documented refusal type before reading
  `.message` — contradicting this module's own header comment ("Never
  throws for an expected refusal ... only a genuine programming error
  propagates"). A real bug in an injected adapter (a null dereference, for
  example) would have been silently reported as an ordinary installer
  failure instead of surfacing as the loud, distinguishable crash it should
  be. Fixed with explicit `instanceof` checks that rethrow anything not a
  documented refusal class; `install-orchestrator.test.ts` asserts a
  simulated adapter bug now rejects the returned promise rather than
  resolving to `"failed"`.
- **Lost non-interactive configuration remediation guidance (guarantee
  #24).** The inherited orchestrator computed `prepared.guidance` (the four
  lines `noninteractiveConfigurationGuidance` produces) and then discarded
  it — emitting one redundant `blocked` event per guidance line (with no
  free-text field to actually carry the guidance itself; engine events are
  fixed-vocabulary only, per `engine-event.ts`'s own module comment) instead
  of surfacing the text anywhere the caller could print it, unlike
  install.sh's own direct `printf ... >&2` calls. Fixed by adding an
  optional `guidance?: string[]` field to `InstallOutcomeFailed`, threading
  `prepared.guidance` through to it, and having `src/cli/orbit.ts` print
  each line to stderr on a `"failed"` outcome — the same information
  install.sh's own remediation text conveys, now actually reachable.
  `install-orchestrator.test.ts` and `orbit.install.test.ts` both assert on
  the surfaced guidance text.

**Other flags (process/tooling notes and deliberate narrowings, not
correctness bugs):**

- **GNU `timeout` dropped from the host-tool preflight (guarantee #40's
  `timeout` half).** `install-docker-adapter.ts`'s bounded health probes use
  `spawnSync`'s own `timeout`/`killSignal` options rather than shelling out
  to GNU `timeout` (install.sh's own `bounded_compose_probe`, guarantee
  #33) — the probe is still force-killed within a bounded window, but the
  two-stage TERM-then-KILL grace period install.sh's `--kill-after=1s` gives
  a probe process is not independently reproduced, and this CLI's own host
  preflight (`checkDockerAvailable`/`checkCurlAvailable`) never checks for a
  `timeout` binary at all. A deliberate adapter-level implementation
  difference (documented in `install-docker-adapter.ts`'s own header
  comment since slice 5's first draft), not a new finding, restated here
  for the plan doc's own completeness.
- **`.orbit-install-scratch.*` has no `repair.sh` recognition.**
  `install-orchestrator.ts` uses a second, separate scratch directory
  (`.orbit-install-scratch.*`, cleaned up in a `finally` block) for asset
  download/validation and guided-configuration staging, distinct from
  `InstallTransaction`'s own `.orbit-install-staging.*` recovery area — a
  deliberate two-directory design already flagged when this slice's own
  modules were first drafted (see that module's header comment). A hard
  `SIGKILL` during the scratch-directory phase (before the file transaction
  begins) leaves that directory behind with no equivalent operator-facing
  recognition: `scripts/repair.sh`'s `staging-evidence-present` finding
  (issue #261) only knows about the `.orbit-install-staging.*` prefix.
  Flagging for owner awareness — extending `repair.sh` to recognize both
  prefixes, or unifying the two directories the way install.sh's own single
  `staging_dir` does, is a reasonable follow-up but out of scope for this
  slice.
- **Image-identity progress events collapsed relative to install.sh's own
  interstitial timing.** install.sh emits `identity image running
  image-identity inspect` *between* resolving the digest and running the
  banner-verification container (install.sh:1306), so a banner failure
  still shows a `running` event before the eventual `failed` one.
  `install-orchestrator.ts` instead emits `running` and `completed` back to
  back only after `resolveImageIdentity` (which performs the banner check
  internally) has already fully succeeded — a banner failure therefore
  never reaches a `running` event at all in this port. Not a guarantee
  violation (the fixed-vocabulary event stream's own guarantee is about
  value validation, not exact interstitial timing), but a real, minor
  divergence from install.sh's own event sequence; restructuring
  `image-resolution.ts` to accept a progress callback would fix it at the
  cost of the module's current from-fakes purity, judged not worth it for
  this slice.
- **Transaction-begin failures are always labeled phase `compose`.**
  `InstallTransaction.begin()` failures (an extremely rare TOCTOU-shaped
  race — a managed path became unsafe between `validateTarget` and here)
  are reported via `fail("compose", "compose", ...)` regardless of what
  install.sh's own `installer_ui_phase` would actually have been at the
  equivalent point (`assets`, or `configuration` if guided-install staging
  ran) — a simplification, not a rearchitecting of install.sh's own
  context-dependent phase tracking at that one rare call site. The
  resulting default reason/action (`configuration-failure`/`retry`) is
  still a reasonable characterization of the failure; flagging the label
  imprecision for owner visibility rather than reproducing install.sh's own
  phase-state machine exactly for one rare path.
- **20/39's model-pull-after-confirmation guarantee is never exercised, not
  violated.** Since this CLI never collects a requested-model value, the
  `ai`/`full` profile's separate confirmed-download branch
  (`prepare_service_images`'s `model_pull_requested` check) is simply always
  skipped — see Non-goals above.
- **22 (the `repair` action) remains entirely unwired.** `orbit repair` is
  not a recognized command; issue #261's repair execution work is a
  separate track, unchanged by this slice.
- No behavioral discrepancy was found in `deployment-assets.ts`,
  `deployment-profile.ts`'s two extracted functions, `image-resolution.ts`'s
  regex/sequencing, `health-wait.ts`'s wait loop, or `engine-event.ts`'s
  vocabulary lists during this slice's audit of the inherited code — the
  five items above (three real bugs, two swallowed-exception risks) were
  all found in `install-orchestrator.ts` and `install-docker-adapter.ts`
  specifically.
