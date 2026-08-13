# Engine event stream v0

The operational engine's plain-mode status lines are a versioned machine
interface. `orbit-launcher` renders its mission console from this stream
(orbit-launcher#73), and the Phase 2 engine CLI must keep emitting it
unchanged across the runtime port (ADR-0011, #297). The emitter is
`installer_ui_emit` in `scripts/installer-ui.sh`; `scripts/install.sh`
routes every operator-relevant progress transition through it.

## Line format

One event per line on stdout, in plain mode only:

```
phase=<phase> component=<component> state=<state> reason=<reason> action=<action> elapsed=<seconds>s
```

- `elapsed` is a non-negative integer number of seconds followed by `s`;
  malformed inputs are rendered as `0s`.
- Simulation runs append ` simulation=true` as a trailing field. Consumers
  must tolerate unknown trailing `key=value` fields.
- Every field value is validated against the fixed vocabulary below before
  emission; an unrecognised value is rendered as the literal `unknown`,
  never echoed verbatim. Events carry enums only — never configuration
  values, secrets, paths, or free text.

## Mode selection

Plain mode (and therefore this stream) is selected when stdout is not a
terminal, `NO_COLOR` is set, `TERM=dumb`, `ORBIT_INSTALLER_PLAIN=1`, or
`--plain` is passed. A consumer that runs the engine with stdout as a pipe
gets this stream with no flags. TTY mode renders the same events as human
formatting and is not a machine interface.

## Non-interactive contract

The engine never prompts without a controlling terminal. In a
non-interactive run with incomplete configuration it refuses before
starting Compose, prints guidance naming only the missing field names, and
emits a terminal `state=failed` event (`reason=configuration-failure` for
the configuration phase). A consumer that receives this outcome should
re-run configuration interactively (for `orbit-launcher`: the terminal
handoff stretch), then retry.

## Vocabulary

Additions to a field's vocabulary are allowed within v0 and must update
this document in the same pull request (enforced by
`scripts/engine-events.test.mjs`). Renaming or removing a value is a
breaking change requiring a version bump and coordination with consumers.

### phase

```
bootstrap
host
identity
assets
configuration
oidc
compose
preparation
database
application
optional
complete
rollback
```

### component

```
installer
host
image
assets
configuration
oidc
compose
database
application
clamav
tika
ollama
```

### state

```
waiting
starting
running
healthy
skipped
completed
blocked
failed
```

Terminal outcomes: `failed` and `blocked` are refusals or failures;
`completed` on the `complete` phase is success. `skipped` records an
explicitly bypassed step.

### reason

```
initial
target
channel
digest
source-revision
semantic-version
revision
configuration
configuration-required
discovery
compose-config
database-image
service-start
status-verified
installed
host-tools
image-identity
assets-verified
configuration-migration
provider-discovery
compose-validation
service-preparation
database-health
application-health
optional-status
deployment-ready
docker-host
image-registry
configuration-failure
provider-unavailable
database-auth-migration
application-startup
health-timeout
optional-unavailable
failure
rollback
repair-unavailable
unknown
```

### action

```
begin
validate
pull
inspect
fetch
configure
verify
check
start
wait
health
skip
status
complete
retry
rollback
repair
continue
display
```

## Consumer guidance

- Parse `key=value` tokens; ignore unknown keys; treat unknown enum values
  as renderable-but-unstyled.
- Key success and failure handling off events plus the process exit code,
  never off human-readable prose (which is unstable by design).
- The stream is pinned by the operational guarantee catalogue
  (`docs/installer-guarantees.md`) and exercised by the Phase 1 acceptance
  harness.

## Machine prompts (v0)

The guided configuration flow (`scripts/configure.sh --init` and
`--set-oidc-secret`) normally prompts on the controlling terminal, exactly as
today (`docs/engine-events.md`'s non-interactive contract above, and the
Phase 1 acceptance harness, are unaffected). Setting
`ORBIT_CONFIGURE_PROMPTS=machine` in `configure.sh`'s environment switches
the *same* guided flow to a machine-readable protocol instead: prompt lines
on stdout, one answer line read from stdin per prompt. `install.sh` never
sets this variable, so its contract with the Phase 1 acceptance harness is
byte-identical whether or not this section exists; a consumer that wants
machine-driven configuration runs `scripts/configure.sh` directly with
`ORBIT_CONFIGURE_PROMPTS=machine` rather than through `install.sh`.

This is a second, independent line grammar layered under the `configuration`
phase; it does not use `installer_ui_emit` and does not appear unless machine
prompt mode is active.

### Line grammar

One line per exchange, `key=value` tokens only, in the order below:

```
prompt field=<FIELD> kind=<KIND> required=true attempt=<n>
prompt-reject field=<FIELD> reason=<REASON>
prompt-accept field=<FIELD>
prompt-abort field=<FIELD>
```

- `prompt` is written first; the engine then blocks reading exactly one
  answer line from stdin.
- If the answer validates, the engine writes `prompt-accept` and moves to
  the next field (or finishes).
- If the answer fails validation, the engine writes `prompt-reject` with a
  `reason` naming the failure class, then writes another `prompt` line for
  the same field with `attempt` incremented by one.
- `attempt` starts at `1` and is bounded at `3`: after a third rejected
  answer for the same field the engine writes `prompt-abort` instead of a
  fourth `prompt`, then fails through the existing refusal path (a
  descriptive message on stderr and a non-zero exit) — the same outcome as
  today's TTY prompt being cancelled.
- `required` is always the literal `true` in v0; there is no optional
  machine prompt yet.
- End-of-input (stdin closed with no answer line available) is treated the
  same as `prompt-abort`: the engine fails through the same refusal path
  without a fourth `prompt`.

### field

```
APP_URL
OIDC_ISSUER
OIDC_CALLBACK_URL
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET
```

`OIDC_CALLBACK_URL` is derived from an accepted `APP_URL`
(`<APP_URL>/api/auth/callback`) and is never itself prompted for; it is
listed here because it shares `APP_URL` and `OIDC_ISSUER`'s `kind`.

### kind

```
url
text
secret
```

`APP_URL`, `OIDC_ISSUER` and `OIDC_CALLBACK_URL` are `kind=url`;
`OIDC_CLIENT_ID` is `kind=text`; `OIDC_CLIENT_SECRET` (collected only via
`--set-oidc-secret`) is `kind=secret`.

### reason-class

```
empty
invalid-characters
not-https
not-absolute-url
forbidden-host
too-large
```

These are exactly the refusal classes the existing validators in
`scripts/configure.sh` distinguish for the guided fields:

- `empty` — the answer line was blank.
- `invalid-characters` — the answer contains a control character, leading
  or trailing whitespace, or (for `OIDC_CLIENT_ID`) any whitespace/control
  character at all.
- `not-https` — a URL-kind answer does not start with `https://`.
- `not-absolute-url` — a URL-kind answer starts with `https://` but is not
  a bare origin/issuer authority: it carries embedded credentials, a query
  or fragment, an unexpected path (`APP_URL` only — `OIDC_ISSUER` permits a
  path), an empty host, or a host that does not parse as a valid hostname
  or port.
- `forbidden-host` — the URL's host is a loopback address or the
  documented `example.com` placeholder.
- `too-large` — the `OIDC_CLIENT_SECRET` answer exceeds the existing
  65,536-byte maximum.

### Security

An `OIDC_CLIENT_SECRET` answer is read from stdin exactly like any other
answer, but its value is never echoed, never logged and never appears in
any `prompt`, `prompt-reject`, `prompt-accept` or `prompt-abort` line —
only the fixed field name `OIDC_CLIENT_SECRET` does. No prompt line, for
any field, ever carries a configuration value: only the fixed `field`,
`kind`, `reason` and `attempt` vocabulary above. Machine mode never
manipulates terminal echo state; it is designed for a piped, programmatic
caller (see `scripts/engine-prompt-renderer.fixture.mjs`), not direct
interactive keyboard entry.

### Validation

Every answer is accepted or rejected by exactly the same validator
functions the TTY prompts call today (`normalize_public_origin`,
`validate_oidc_issuer`, `is_valid_client_id`, and the OIDC client secret's
existing non-empty/size checks). The `reason` classification is a
diagnostic-only second pass over a rejected answer using the same
underlying primitives (`contains_forbidden_characters`, `is_forbidden_host`);
it never itself decides acceptance.

Additions to `field`, `kind` or `reason-class` are allowed within v0 and must
update this document in the same pull request (enforced by
`scripts/engine-prompts.test.mjs`, mirroring
`scripts/engine-events.test.mjs` above). Renaming or removing a value is a
breaking change requiring a version bump and coordination with consumers.

## Machine prompts: backup/restore/recovery (v0)

The backup/restore/recovery-bundle family
(`orbit backup`/`orbit restore`/`orbit export-recovery-bundle`/
`orbit import-recovery-bundle`, `src/cli/orbit.ts`, issue #296 slice 4) has
its own interactive passphrase and confirmation prompts, ported from
`export-recovery-bundle.sh`/`import-recovery-bundle.sh`/`restore.sh`'s own
`read -s`/`read -p` prompts. This is the vocabulary extension the #296
slice plan (`docs/adr-notes/296-backup-port-plan.md`) calls "extending that
vocabulary is this slice's job" — a second, independent instance of the
"Machine prompts (v0)" section above's exact line grammar, scoped to this
CLI family rather than `configure.sh`'s guided fields (which remain exactly
as documented above, unaffected).

Setting `ORBIT_RECOVERY_PROMPTS=machine` in the CLI's own environment
switches these commands' passphrase/confirmation prompts to the same
machine-readable line grammar `ORBIT_CONFIGURE_PROMPTS=machine` uses for
`configure.sh`: prompt lines on stdout, one answer line read from stdin per
prompt, bounded at three attempts, `prompt-abort` (or end-of-input) routing
into the same refusal path a cancelled interactive prompt takes. Without
this variable set, these commands prompt on the real controlling terminal
instead (masked input for `kind=secret` fields, matching `read -s`) and
refuse if stdin is not a terminal — this variable and its TTY-mode
default do not change anything about `configure.sh`'s own
`ORBIT_CONFIGURE_PROMPTS=machine` contract above, and vice versa.

### Line grammar

Identical grammar to the "Machine prompts (v0)" section above:

```
prompt field=<FIELD> kind=<KIND> required=true attempt=<n>
prompt-reject field=<FIELD> reason=<REASON>
prompt-accept field=<FIELD>
prompt-abort field=<FIELD>
```

The same `attempt` bounds (starts at `1`, bounded at `3`, `prompt-abort` on
the third rejection or end-of-input) and `required=true`-only-in-v0 rule
apply, implemented by `src/lib/recovery-prompts.ts`'s
`collectMachinePromptField`.

### recovery field

```
RECOVERY_PASSPHRASE
RECOVERY_PASSPHRASE_CONFIRM
IMPORT_CONFIRMATION
RESTORE_CONFIRMATION
```

`RECOVERY_PASSPHRASE_CONFIRM` is only collected by
`orbit export-recovery-bundle` (matching `export-recovery-bundle.sh`'s own
read-then-confirm entry); `orbit import-recovery-bundle`'s own passphrase
entry has no confirmation step (matching `import-recovery-bundle.sh`, which
reads the recovery passphrase once). `IMPORT_CONFIRMATION` is
`orbit import-recovery-bundle`'s literal `IMPORT RECOVERY` phrase
(`import-recovery-bundle.sh` guarantee #19). `RESTORE_CONFIRMATION` is
`orbit restore`'s literal `RESTORE` phrase (`restore.sh` guarantee #46) —
also collected a second time, independently, inside
`orbit import-recovery-bundle` itself, because `import-recovery-bundle.sh`
invokes its own inner `restore.sh` without `--yes`/
`ORBIT_NONINTERACTIVE_RESTORE`, so the inner script's confirmation prompt
genuinely fires again (see Flags, `docs/adr-notes/296-backup-port-plan.md`,
Slice 4).

### recovery kind

```
secret
text
```

`RECOVERY_PASSPHRASE` and `RECOVERY_PASSPHRASE_CONFIRM` are `kind=secret`;
`IMPORT_CONFIRMATION` and `RESTORE_CONFIRMATION` are `kind=text` (a typed
literal phrase, not itself sensitive, but still never echoed back in any
protocol line — see Security below).

### recovery reason-class

```
empty
too-short
mismatch
no-match
```

- `empty` — the answer line was blank (any field).
- `too-short` — `RECOVERY_PASSPHRASE` was under the existing 12-character
  minimum (`recovery-bundle.ts`'s `MIN_RECOVERY_PASSPHRASE_LENGTH`,
  matching `export-recovery-bundle.sh`/`recovery-crypto.mjs`'s own
  defense-in-depth check).
- `mismatch` — `RECOVERY_PASSPHRASE_CONFIRM` did not exactly equal the
  already-accepted `RECOVERY_PASSPHRASE`.
- `no-match` — `IMPORT_CONFIRMATION`/`RESTORE_CONFIRMATION` was not exactly
  the required literal phrase.

### Security

Identical contract to the "Machine prompts (v0)" section above: no prompt
line, for any field, ever carries the prompted value itself — only the
fixed field/kind/reason vocabulary. `RECOVERY_PASSPHRASE`/
`RECOVERY_PASSPHRASE_CONFIRM` are never echoed, logged, or passed to any
subprocess's argument list or environment; `src/lib/recovery-prompts.test.ts`
and `src/cli/orbit.test.ts` both assert a supplied passphrase never appears
in any protocol line or in the CLI's own stdout/stderr.

### Validation

Every answer is accepted or rejected by the same validators
`src/lib/backup-restore-cli.ts`'s orchestration itself enforces a second
time as defense-in-depth (`requireValidPassphrase`,
`requireMatchingPassphrase`, and the literal-phrase equality checks) — the
`reason` classification is a diagnostic-only second pass, exactly as the
"Machine prompts (v0)" section above already establishes for
`configure.sh`'s own fields.

Additions to this section's `recovery field`, `recovery kind` or
`recovery reason-class` are allowed within v0 and must update this document
in the same pull request. Renaming or removing a value is a breaking change
requiring a version bump and coordination with consumers.

## In-container engine invocation (v0)

Engine-delivery architecture (owner decision, 2026-08-13, recorded across
comments on issue #295): host bash scripts remain the only thing that ever
runs `docker` commands — a handful of explicit invocations, at operator
request, never continuous or backgrounded. The TypeScript engine (this
repository's `src/cli/orbit.ts`) ships INSIDE the app image, bundled to a
single dependency-free file at `/opt/orbit/cli/orbit.js`
(`scripts/bundle-orbit-cli.mjs`, wired into the Dockerfile's `cli-builder`
stage), and is invoked by host scripts as a disposable
`docker compose run --rm --no-deps` one-off — the exact pattern
`scripts/repair.sh` already uses to call `scripts/recovery-crypto.mjs`
(see that script's "Passphrase — the checkpoint" section), generalized to
the engine CLI. The engine container is never handed the Docker socket,
never starts/stops/inspects other containers, and no host in this
architecture is ever required to have Node installed outside the image.

### Invocation contract

```
docker compose --project-name "$project" --env-file "$environment_file" \
  run --rm --no-deps -T --entrypoint node \
  --volume "<host-deployment-dir>:/orbit-deploy:<ro|rw>" \
  orbit-app /opt/orbit/cli/orbit.js <command> --dir /orbit-deploy
```

- `--rm --no-deps` — a throwaway container, and only the named service's own
  image is used; no dependent service (`orbit-db`, etc.) is started for a
  one-off that does not need one, mirroring `recovery-crypto.mjs`'s own call
  sites in `scripts/repair.sh`.
- `-T` — disables pseudo-TTY allocation, the same choice `repair.sh`'s own
  `recovery-crypto.mjs` invocations make, so stdio behaves predictably for a
  scripted caller (machine prompts, if any, flow over stdio exactly as the
  "Machine prompts (v0)" grammar above already defines — no new protocol).
- `--entrypoint node` — bypasses `container-entrypoint.sh` (the secret
  bootstrap/privilege-drop entrypoint the normal `orbit-app` service uses)
  entirely, the same substitution `recovery-crypto.mjs`'s call sites make;
  the process runs as the image's own declared `USER` (`root`), same as
  every other `--entrypoint`-overridden one-off already shipped.
- The deployment directory is bind-mounted at the fixed in-container path
  `/orbit-deploy`, `:ro` for a read-only command (`check`) and `:rw` only for
  a command that legitimately needs to write host files. `configure` (issue
  #294 — `scripts/configure.sh`'s write flows: the bare/default flow minus
  `ensure_vapid_keys`, `--init`, `--set-oidc-secret`, `--set-deployment-
  profile`) is the first `:rw` command: pure file work against the mounted
  deployment directory, never Docker (see "Fail-closed guard" below —
  `configure`, like `check`, never calls `refuseDockerInContainer` and is
  unaffected by container mode). Every other command that would otherwise
  need to mutate a live deployment is Docker-backed and therefore refuses
  before touching the mount either way.
- `$project`/`$environment_file` resolve exactly as `repair.sh`'s own
  "Compose project name derivation" step does, so the one-off targets the
  same Compose project and `.env-orbit` the rest of the deployment's Docker
  operations already use.

### Fail-closed guard: no Docker access from inside the engine container

Owner's hard constraint (issue #295, 2026-08-13): "the engine can never
manage the Docker socket. Ever." No code path inside the bundled CLI may
even ATTEMPT to spawn `docker` while running as this in-image engine — not
"attempts and fails for lack of a socket," but structurally refuses before
any such attempt.

`src/cli/orbit.ts` bakes this in two parts:

1. The Dockerfile's `runner` stage sets `ENV ORBIT_ENGINE_CONTEXT=container`.
   `ENV` (unlike `CMD`/`ENTRYPOINT`) is part of the image's own config and is
   present in every container started from it regardless of
   `--entrypoint`/`--user` overrides — the one fact the guard trusts. A
   container started any other way (a host checkout run directly via
   `pnpm run orbit`/`tsx`, with no image involved) never has it set.
2. Every command whose adapters would ever spawn `docker`
   (`install`/`update` via `src/lib/install-docker-adapter.ts`;
   `backup`/`restore`/`export-recovery-bundle`/`import-recovery-bundle` via
   `src/lib/recovery-bundle.ts`'s/`src/lib/restore-engine.ts`'s
   `createDockerCompose*Adapter`) calls `refuseDockerInContainer` as the
   FIRST statement in its command function — before any adapter is
   constructed, so the code path that would spawn `docker` is never
   reached, not merely made to fail once reached. When
   `ORBIT_ENGINE_CONTEXT=container` is set, that call prints
   `orbit: refused command=<command> reason=docker-command-forbidden-in-container`
   to stderr and exits `9`, before touching the target directory or any
   subprocess. `check` and `configure` (the pure-logic commands — `configure`
   added by issue #294; see "Invocation contract" above for why it is the
   first `:rw` command despite never touching Docker) never call this guard
   and are unaffected: they work fully against a bind-mounted deploy
   directory, in or out of a container, and never spawn `docker` under any
   invocation — `src/cli/orbit.test.ts`, `src/cli/orbit.configure.test.ts`,
   and the bundle's own smoke test assert this with a booby-trapped `docker`
   on `PATH`.

This is a permanent architectural boundary, not a placeholder pending a
future slice: any command that genuinely needs to touch Docker stays a
host-side operation for good, per the owner's decision above — the engine
computes, validates, and directs; the host's own bash scripts are the only
layer that ever runs `docker`.

### Delegation points

`scripts/engine-check.sh` was the first host script wired onto this
contract: by default it is a behavior-preserving proxy onto the existing
`bash scripts/configure.sh --check`, and only when `ORBIT_ENGINE_CHECK=
container` is set in its environment does it instead compose the one-off
`check` invocation documented above.

`scripts/configure.sh` itself (issue #294) extends the same opt-in pattern
to its own write flows, with its own sibling variable,
`ORBIT_CONFIGURE_ENGINE=container`: unset (the default), every dispatch
path is byte-identical to before this section existed. When set, each of
the bare/default flow, `--init`, `--set-oidc-secret`, and
`--set-deployment-profile` delegates to the one-off `configure` invocation
above whenever every precondition holds (docker present, a valid and
already locally-present `ORBIT_IMAGE`, an already-existing `.env-orbit` —
the very first creation of `.env-orbit` on a fresh checkout always stays
bash, since `docker compose --env-file` requires the file to already
exist), falling back to the original bash logic otherwise. `--init` and
`--set-oidc-secret` are additionally scoped to the two shapes with no real
controlling-terminal interaction — the fully-scripted `ORBIT_CONFIGURE_*`
environment triad or the `ORBIT_CONFIGURE_PROMPTS=machine` grammar above (the
container speaks it itself over `configure.sh`'s own inherited stdio) — a
genuine human TTY session is never delegated. `ensure_vapid_keys` (the one
sub-step that genuinely needs `docker` to run or build an image) always
stays in `scripts/configure.sh`, delegated or not — the containerized engine
can never touch Docker itself (see "Fail-closed guard" above). See
`docs/adr-notes/294-configure-write-port-plan.md` for the full design and
its flags. No existing script's *default* observable behavior changes;
`install.sh` and `repair.sh` are unmodified by this slice.
