# #294 write-side port plan: configure/init/set-oidc-secret/set-deployment-profile

Status: proposed (implemented in one PR). This is a working note, not an
ADR — it records the design for issue #294's write-side port so the
decisions are traceable, following the same convention as
`docs/adr-notes/295-install-port-plan.md` and
`docs/adr-notes/296-backup-port-plan.md`. Update it as the design changes;
it is not meant to be a permanent record like `docs/adr/`.

## Why this shape

Issue #294's read side (`configure.sh --check`) was already ported to
`src/lib/config-contract.ts` / `src/lib/env-orbit-file.ts` and proven
output-identical by `src/lib/config-contract.parity.test.ts`. The issue's
acceptance criterion "Bash configure.sh delegates or is retired for this
flow" was not yet met: the write flows (`--init`, the bare/default flow,
`--set-oidc-secret`, `--set-deployment-profile`) still lived only in Bash.

By the time this slice started, issue #295's comments had settled the
engine-delivery architecture for the whole port (owner decisions,
2026-08-13): the TypeScript engine ships inside the app image and is
invoked by host scripts as a disposable `docker compose run --rm --no-deps`
one-off; the engine itself can never touch Docker, "not 'attempts and fails
for lack of a socket,' but structurally refuses before any such attempt";
host bash scripts remain the only thing that ever runs `docker`, explicitly
and occasionally. `scripts/engine-check.sh` (issue #295) already
demonstrated this pattern for `--check`'s own delegation, gated by an
opt-in environment variable (`ORBIT_ENGINE_CHECK=container`) that defaults
to a byte-identical bash passthrough. This slice generalizes that exact
pattern to `configure.sh`'s write flows, rather than inventing a new one.

## Scope

**Native engine (file work only, no `docker`, ever):**
`src/lib/configure-engine.ts` ports, function-for-function, every write
flow in `scripts/configure.sh` **except** `ensure_vapid_keys`:

- `ensureEnvironmentFile` / `buildMinimalEnvironmentContent` (guarantees
  #4-6)
- `updateManagedKeys` — the single reusable atomic writer (#7-8)
- `persistOrbitImage` (#9)
- `ensureSecretsDirectory` / `ensureSecretFile` (#15-17)
- `ensureOidcSecretPlaceholder` / `applySetOidcSecret` (#18-23)
- `applyGuidedInit` (#11-14)
- `setDeploymentProfile` (#10)
- `runConfigurePreflight` — the `configuration.sh --preflight` handoff (#2)
- The #297 machine-prompt grammar's **server** side (`collectMachine
  GuidedInit`, `collectMachineOidcSecret`) — previously only a *client*
  existed (`src/lib/guided-configuration.ts`, driving bash's own server);
  the containerized `orbit configure --init`/`--set-oidc-secret` commands
  have no controlling terminal of their own and now speak that grammar
  directly, reusing the exact validators `src/lib/config-contract.ts`
  already exports.

Wired onto `src/cli/orbit.ts` as a new `configure` command (bare,
`--init`, `--set-oidc-secret`, `--set-deployment-profile PRESET [MODEL]`),
following the file's existing conventions: explicit invocation, no default/
implied execution, secrets read only from stdin (never argv), value-free
output. Unlike `install`/`update`/`backup`/`restore`/etc., `configure`
never calls `refuseDockerInContainer` — it is exactly as safe to run inside
the disposable engine container as `check` is, and is the first `:rw`
in-container command (`docs/engine-events.md`, "Invocation contract").

**Delegation, with a safe fallback:** `scripts/configure.sh` gains
`ORBIT_CONFIGURE_ENGINE=container` — `ORBIT_ENGINE_CHECK`'s own sibling —
and, when set, an `engine_delegation_ready` gate plus a `run_engine`
one-off composer. Unset (the default, and every existing test's
environment), `engine_delegation_ready` always returns false, so every
`if engine_delegation_ready; then ... else <original bash> fi` call site
takes its `else` branch unconditionally: the fallback path is provably
byte-identical to the pre-#294 script, which is exactly why
`scripts/configure.test.mjs`'s 73 tests needed zero modification and stay
green.

**Schema-migration handoff:** `configure.sh`'s own `run_configuration_
preflight` drives `configuration.sh --preflight` as a subprocess. That
script is not shipped inside the app image (only the bundled `orbit` CLI
is — see the Dockerfile's `cli-builder`/`runner` stages), so a literal
in-container subprocess hand-off is not possible. `runConfigurePreflight`
instead reuses `src/lib/env-orbit-file.ts`'s `parseEnvOrbitContent` — the
existing parity-proven mirror of `configuration.sh`'s own `parse_file`,
established for the `--check` port — rather than re-deriving new parsing
logic. This is "mirror it, don't reimplement it" applied to the mirror
that already exists, not a fresh reimplementation of `configuration.sh`.

## Docker-dependency audit of configure.sh's write side

Walking every write flow function in `scripts/configure.sh`:

| Function | Needs `docker`? |
| --- | --- |
| `ensure_environment_file` | No |
| `update_managed_keys` | No |
| `persist_orbit_image` | No |
| `ensure_secrets_directory` | No |
| `ensure_secret_file` (session-secret, postgres-password, document-kek) | No (uses `openssl`/`/dev/urandom`, not Docker) |
| `ensure_oidc_secret_placeholder` | No |
| `set_oidc_secret` | No |
| `guided_init` | No |
| `set_deployment_profile` | No |
| `run_configuration_preflight` | No (subprocess to `configuration.sh`, itself Docker-free) |
| **`ensure_vapid_keys`** | **Yes** — `docker image inspect`/`docker pull`/`docker run` against the resolved `ORBIT_IMAGE` (fast path), or `docker build --target vapid-generator` + `docker run` against a freshly-built bootstrap image (slow/first-run path) |

`ensure_vapid_keys` is the **only** Docker-dependent sub-step, and it is
architecturally permanent, not a gap to close later: the containerized
engine can never run/build a Docker image itself (issue #295's hard
constraint). `scripts/configure.sh` always runs `ensure_vapid_keys` itself,
in bash, after delegating (or running locally) everything else — the exact
same call, in the exact same position, regardless of whether
`ORBIT_CONFIGURE_ENGINE=container` is set. The engine's own `runConfigure
Apply` never reaches this step at all; `src/lib/configure-engine.ts`'s
header comment documents the boundary in the same place a reader of that
module would look for it.

## Flags

- **The very first `.env-orbit` creation on a fresh checkout never
  delegates**, even with `ORBIT_CONFIGURE_ENGINE=container` set:
  `engine_delegation_ready` requires `.env-orbit` to already exist, because
  `docker compose --env-file <path>` requires the file to exist and a
  first-ever bootstrap has nothing to point it at yet. This is exactly the
  "bootstrap ordering: configure can run before any image exists" case the
  issue calls out — `install.sh`'s own call sites always resolve/pull
  `ORBIT_IMAGE` before ever invoking `configure.sh` (verified by reading
  `install.sh`'s sequential script body: `docker pull`/`docker image
  inspect` at what is textually the script's later top-level code, but
  executes before `prepare_configuration`/`stage_guided_install_
  configuration` are called), so in practice `ORBIT_IMAGE` is always valid
  and locally present by the time delegation is attempted — the remaining
  gate is squarely about `.env-orbit`'s own existence, i.e., true first-run
  bootstrapping. Once the first bash-only run creates `.env-orbit`, every
  subsequent invocation (re-run, `--init` again, `--set-oidc-secret`,
  `--set-deployment-profile`) is eligible to delegate.
- **A genuine human TTY session is never delegated for `--init` or
  `--set-oidc-secret`.** Delegation for these two commands is scoped to
  exactly the two shapes with no real controlling-terminal interaction: the
  fully-scripted `ORBIT_CONFIGURE_APP_URL`/`_OIDC_ISSUER`/`_OIDC_CLIENT_ID`
  environment triad, and `ORBIT_CONFIGURE_PROMPTS=machine` (the container
  speaks the #297 line grammar itself over `configure.sh`'s own inherited
  stdio — no redirection, no pty games). `ORBIT_CONFIGURE_TTY_INPUT=1` and
  an interactive `[[ -t 0 ]]` session always stay bash-only. This is a
  deliberate scope limit, not an oversight: proxying a raw, hidden-input
  terminal session through a `docker compose run` one-off reliably (correct
  pty allocation, `stty -echo` semantics preserved end-to-end) is
  meaningfully riskier to get right and to test deterministically than the
  two already-scripted shapes, and every *real* automated caller
  (`install.sh` via a future orchestrator, a CI pipeline, `orbit-launcher`)
  already goes through one of those two shapes rather than a raw terminal.
  If tighter TTY delegation is wanted later, it is additive on top of this
  slice, not a redesign of it.
- **The bare/default flow collapses any nonzero delegated exit code to 1
  via `fail()`**, matching every other bare-flow failure's own convention
  (every `fail()` call in `configure.sh` exits 1); `--set-deployment-
  profile` and `--init`/`--set-oidc-secret`, by contrast, propagate the
  engine's raw exit code unchanged (`orbit configure --set-deployment-
  profile`'s own usage errors exit 2, mirroring `configure.sh`'s own
  `usage; exit 2` sibling behavior for the same input shape). This is a
  faithful mirror of each dispatch branch's own pre-existing shape, not a
  new inconsistency introduced by delegation.
- **`configuration.sh` itself is never shipped inside the app image** (only
  the bundled `orbit` CLI is), so the preflight handoff reuses the existing
  `parseEnvOrbitContent` mirror instead of a literal subprocess call from
  inside the container — see "Schema-migration handoff" above.
- No behavioral discrepancy was found between the native engine port and
  the corresponding Bash functions during this work; the items above are
  characterization/scope notes, not correctness concerns.

## Test evidence

- `src/lib/configure-engine.test.ts` (60 tests): unit coverage of every
  ported function, citing `docs/installer-guarantees.md`'s `configure.sh`
  guarantee numbers (#2, #4-23, #33) in test names, including the #297
  machine-prompt grammar's accept/reject/retry/abort/end-of-input paths and
  a secret-never-leaked assertion.
- `src/lib/configure-engine.parity.test.ts` (8 tests): byte-for-byte content
  parity between real, unmodified `scripts/configure.sh` runs and the
  native engine functions — fresh `--init`, bare-flow re-run (idempotency),
  `--set-oidc-secret`, `--set-deployment-profile` (two presets), and an
  operator hand-edit surviving a re-run untouched. Freshly *generated*
  random secrets are compared structurally (valid 64-hex value, correct
  mode) rather than byte-for-byte against each other, since bash's real
  `openssl rand` and the engine's real `node:crypto.randomBytes` are two
  independent CSPRNGs — asserting equal *output* would be asserting a
  coincidence, not parity; every other byte the two implementations produce
  (including VAPID fields, normalized away since that step is bash-only)
  is compared exactly.
- `src/cli/orbit.configure.test.ts` (18 tests): the real CLI entry point,
  spawned end-to-end — bare flow, `--init` (env triad and machine-prompt
  mode, including reject/retry/abort), `--set-oidc-secret` (piped and
  machine-prompt mode), `--set-deployment-profile` (including its usage-
  exit-2 convention), and the in-container fail-closed guard being a no-op
  for `configure` exactly as it already is for `check`.
- `scripts/configure-engine-delegation.test.mjs` (12 tests): PATH-shimmed
  fake `docker`, proving the exact composed one-off argv for each delegated
  shape, the fallback firing when the image isn't present locally, the
  first-run-never-delegates rule, exit-code handling for both conventions
  above, and that a supplied OIDC secret never appears in the composed
  argv.
- `scripts/configure.test.mjs` (73 tests): unmodified, green on the
  fallback path (default environment, `ORBIT_CONFIGURE_ENGINE` unset).
- `src/lib/config-contract.parity.test.ts`, `scripts/engine-check.test.mjs`,
  `scripts/engine-events.test.mjs`, `scripts/engine-prompts.test.mjs`: all
  still green, unmodified.
