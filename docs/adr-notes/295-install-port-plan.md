# #295 slice plan: port the guided/unattended install flow to the orbit CLI

Status: proposed (slice 1 implemented). This is a working note, not an ADR —
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

## Flags (bash characterized, not changed)

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
