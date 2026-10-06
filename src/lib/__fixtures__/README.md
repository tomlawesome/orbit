# Golden files for the retired bash twins

#1210 (build note D10) deleted `scripts/configure.sh`'s write flows,
`scripts/configuration.sh` and `scripts/engine-check.sh`. Before deleting
them, their behaviour was captured here, once, from commit `b0ee5929`
(`dev`, 2026-10-06), so the engine is still compared against what the bash
did rather than against itself. Pattern: golden-file characterization tests.

Do not regenerate these from the engine: that would turn the comparison into
a tautology. A deliberate behaviour change edits the golden file by hand in
the same commit and says why.

| Directory | What bash produced | Read by |
|---|---|---|
| `configure-check/` | `configure.sh --check` for the readiness fixtures | `config-contract.parity.test.ts` |
| `configure-check-edge/` | `--check`/`--check-rollback` edge cases: no file, unknown key, loose mode, usage errors | `config-contract.parity.test.ts` |
| `configure-write/` | `.env-orbit` and secret files (mode and content) written by the bare flow, `--init`, `--set-oidc-secret`, `--set-deployment-profile`, plus their stdout/stderr and refusals | `configure-engine.parity.test.ts` |
| `configure-machine-prompts/` | `ORBIT_CONFIGURE_PROMPTS=machine` transcripts for `--init` and `--set-oidc-secret` | `guided-configuration.parity.test.ts` |
| `configuration-migration/matrix.json` | `configuration.sh --check/--preflight/--migrate` over 94 inputs: exit status, stdout, stderr, the file, rollback copy and lock afterwards | `configuration-migration.parity.test.ts` |
| `configuration-migration-parity/` | install.sh's preflight/migrate hand-off (`runConfigurationMigration`) | `configuration-migration.parity.test.ts` |
| `session-secret-configure/` | `configure.sh` accepting or refusing each session-secret candidate | `session-secret.contract.test.ts` |
| `restore-sh/` | restore.sh's correspondence queries and scan-lease statement as passed to psql, `checkpoint_sha256` on a fixed file, `load_recovery_journal`'s format rules, `check_capacity` at each threshold (#1211) | `restore-engine.parity.test.ts` |
| `import-recovery-bundle-sh/` | `import-recovery-bundle.sh`'s refusals before its first Docker call: archive, member set, checksum, format, prior journal, open rotation (#1211) | `src/cli/orbit.backup-restore.test.ts` |
| `backup-sh-verify/` | `backup.sh --verify`'s layout and format refusals (#1211) | `src/cli/orbit.backup-restore.test.ts` |
| `database-volume-safety/` | install.sh's `volume_belongs_to_deployment` / `verify_database_volume_safety` against a stub `docker`: the scenario, target setup, status, globals and refusal message (13 cases) | `database-volume-safety.parity.test.ts` |
| `target-identity/` | install.sh's `is_preprovisioned_input`, `validate_target`, `derive_compose_project_name`: the target setup and bash's result (15 cases) | `target-identity.parity.test.ts` |
| `deployment-profile/` | install.sh's `is_valid_local_model` (8 candidates) and `current_deployment_profile` (9 `.env-orbit` fixtures) | `deployment-profile.parity.test.ts` |
| `oidc-discovery/` | install.sh's embedded `oidc_discovery_parser` exit code per document (10), and `verify_oidc_discovery` per stub `curl`/`docker` scenario: URLs requested, reason, action, message (9). `verify-oidc-issuer-missing.json` has no engine assertion yet; the others' orchestration outcome is kept for when `verifyOidcDiscovery` is compared again | `oidc-discovery.parity.test.ts` |
| `install-transaction/` | install.sh's `prepare_rollback_area` / `rollback_transaction`: the rollback/original backup tree, rollback status and restored entries (2 cases) | `install-transaction.parity.test.ts` |
| `install-guided-configuration/` | install.sh's `missing_required/guided/configuration_fields` over 4 readiness fixtures, and `print_noninteractive_configuration_guidance` | `guided-configuration.parity.test.ts` |

#1211 captured its three directories from `6448f07e` (the scripts unchanged since
`d6a365a3`), before backup.sh, restore.sh and the recovery-bundle scripts
became thin shells, with a throwaway script that ran each bash half the
retired parity tests ran.

#1212 then deleted most of `scripts/install.sh`'s functions. The six
install.sh directories above were captured the same way, once, from commit
`9757e42f` (2026-10-06), by the parity tests' own bash halves (functions
extracted from install.sh with awk, run under bash against stub `docker` and
`curl` where needed) behind a one-off `ORBIT_CAPTURE_GOLDEN=1` switch, since
removed. Target directories were given fixed names (`parity-target`,
`_Parity.Target`) so bash's basename fallback is deterministic; oversized
inputs are stored as a length, not the bytes.

How the #1210 ones were captured: the parity tests' own bash halves were run with a
one-off capture switch, and two throwaway scripts drove the remaining cases
(`configure.sh` with a fake `docker`/`openssl` on PATH, and `configuration.sh`
with the inputs of the retired `scripts/configuration.test.mjs`). Generated
secret values are normalised to `<64-hex-char-secret>` and VAPID lines to an
empty value, because neither side's random output is comparable.
