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

How they were captured: the parity tests' own bash halves were run with a
one-off capture switch, and two throwaway scripts drove the remaining cases
(`configure.sh` with a fake `docker`/`openssl` on PATH, and `configuration.sh`
with the inputs of the retired `scripts/configuration.test.mjs`). Generated
secret values are normalised to `<64-hex-char-secret>` and VAPID lines to an
empty value, because neither side's random output is comparable.
