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
the configuration phase). That reason is never emitted once the deployment
files are committed: a failure after that point is the generic `failure`
(#1227). A consumer that receives this outcome should
re-run configuration interactively (for `orbit-launcher`: the terminal
handoff stretch), then retry.

A consumer that wants to run that configuration itself sets
`ORBIT_LAUNCHER_CONFIG_TREE` to an empty directory it created (mode 0700,
owned by the running user) (#1225). On any exit whose event reason is
`configuration-failure`, before the event and before rolling back,
`install.sh` copies the configure tree it verified from the digest-pinned
image into it at the same relative paths: `scripts/configure.sh`,
`scripts/installer-ui.sh` and `.env-orbit.example`, plus the image pin
`.orbit-image`, which holds the resolved digest reference
(`ghcr.io/<repo>@sha256:<64 hex>`) on one newline-terminated line. All are
owner-only (0600/0700) regular files, written all or nothing: a failed copy
removes what it wrote. The pin is written only into this launcher tree; a
deployment never has an `.orbit-image`. If the directory is missing,
not a directory, a symlink, not mode 0700, not empty or not owned by the
current user, it writes nothing and prints one stderr line; the event,
guidance and exit status are unchanged either way. Unset or empty, nothing
is written.

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
abort
```

`abort` marks a failure that no retry can clear (#1038): the installer
emits it in place of the phase's usual `retry`, and a consumer should stop
the run rather than loop. It first appears on the ADR-0019 refusal of an
image published without bundled deployment assets.

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

## Configuration readiness report (v0)

`scripts/configure.sh --check` (and `--check-rollback`, identical in every
respect but the file it checks) emits a fixed-vocabulary readiness summary on
stdout: one line per required field or optional group, from `evaluateReadiness`
(`src/lib/config-contract.ts`), run in the engine as `orbit check` (and
`orbit check --rollback`). This is orbit-launcher's own machine interface
onto configuration state — separate from the `phase=...` event stream and
from the "Machine prompts (v0)" prompt grammar above, sharing neither their
line shape nor `installer_ui_emit`. orbit-launcher's `RunConfigCheck`
(`internal/deploy/configure.go`) parses it to decide what a deployment still
needs before it can be brought up, and what it can fix itself through the
guided machine prompts above.

### Line grammar

```
ready <FIELD>
missing <FIELD>
optional <FIELD>
app-managed <FIELD>
not in use <FIELD>
```

- One line per readiness item, in the fixed order below.
- A consumer parses exactly the first two whitespace-separated tokens per
  line; orbit-launcher's own parser discards any line that does not split
  into exactly two fields, and treats a run that produces no `ready`,
  `missing`, `optional` or `app-managed` line at all as a structural failure
  rather than "everything is ready". `not in use <FIELD>` is four tokens, so
  that same parser discards it today rather than misreading it — the safe
  outcome, since a "not in use" field must never appear in `Missing` or
  `Unfixable` either.
- `app-managed <FIELD>` means the field's credential is administration-
  screen configuration stored encrypted in the database, not .env-orbit
  (ADR-0017): it is reported unconditionally, regardless of any environment
  content, is never counted toward `Missing`/`Unfixable`, and never turns
  the exit status non-zero.
- `not in use <FIELD>` (ADR-0023 §1) means the field belongs to a sign-in
  method that is currently switched off (`ORBIT_AUTH_OIDC=false`, the
  default): a value left in .env-orbit is neither validated nor required
  while the method is off, so operators can disable a provider without
  deleting its configuration. It is never counted toward `Missing`/
  `Unfixable` and never turns the exit status non-zero.
- `<FIELD>` is always a fixed name, never a configured value: `--check` never
  discloses secrets, URLs or other configured content, by field name alone.
- Exit status is non-zero whenever any line reports `missing`, zero
  otherwise.

### field

Required fields — reported as `ready` or `missing`, and additionally, for the
four OIDC fields below, as `not in use` whenever `ORBIT_AUTH_OIDC` is not
`true`:

```
APP_URL
ORBIT_IMAGE
OIDC_ISSUER
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET
OIDC_CALLBACK_URL
```

Optional groups — `ready` when fully and correctly configured, `missing` when
partially configured (present but not usable), `optional` when entirely
absent:

```
processing
ai
mail
push
```

App-managed groups — always reported as `app-managed <FIELD>`, never `ready`,
`missing` or `optional`, regardless of environment content:

```
imap
```

### Consumer guidance

- orbit-launcher's `ConfigCheck.Missing` collects every field reported
  `missing`. `NeedsSecret` is true iff `OIDC_CLIENT_SECRET` is in `Missing`.
  `Unfixable` lists every `Missing` field that is neither a guided
  machine-prompt field (see "field" under "Machine prompts (v0)" above) nor
  `OIDC_CLIENT_SECRET` nor `ORBIT_IMAGE` — `install.sh` persists `ORBIT_IMAGE`
  itself, from the image it resolves, before this readiness gate ever runs.
- An `app-managed` field is never `missing` and never appears in
  `ConfigCheck.Missing`: there is nothing for the environment or the guided
  machine prompts to fix, because the credential lives in the database and is
  set from the administration screen after Orbit is up.
- The readiness report never reveals which value is wrong for a `missing`
  field, only that it is missing; the guided machine prompts above are the
  only path for a consumer to learn more.

### Changing this vocabulary

Adding a field is allowed within v0 and must update this document in the same
pull request, enforced both ways (implemented vocabulary against documented,
and back) by `scripts/configure-check-contract.test.mjs`, mirroring
`scripts/engine-events.test.mjs` above. Renaming or removing a field, or
changing whether it can report `optional`, is a breaking change requiring a
version bump and coordination with orbit-launcher.

`imap` moved from "Optional groups" to "App-managed groups" in the same
change that removed every `IMAP_*` .env-orbit key (ADR-0017 slice 2, issue
#743): a consumer that still expects `optional imap`/`missing imap`/
`ready imap` will not see any of those three words for this field again.
This is exactly the breaking change the paragraph above describes; it ships
without a version bump only because there are no external operators of this
interface to coordinate with yet (the same reasoning ADR-0017 gives for
dropping the deployment contract's `IMAP_*` deprecation window). Coordinate
with orbit-launcher before relying on this if that stops being true.

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
(`import-recovery-bundle.sh` guarantee #17). `RESTORE_CONFIRMATION` is
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
stage), and is invoked by host scripts as a disposable one-off container, in
one of two shapes (below) — the same idea `scripts/repair.sh` already uses to
call `scripts/recovery-crypto.mjs` (see that script's "Passphrase — the
checkpoint" section), generalized to the engine CLI. The engine container is
never handed the Docker socket, never starts/stops/inspects other containers,
and no host in this architecture is ever required to have Node installed
outside the image.

### Invocation contract

Two shapes, chosen by what the command needs from the host.

**File-only commands (`check`, `configure`): a plain `docker run --rm`.**
These need only the deployment directory, so the one-off does not go through
Compose. Compose's `--env-file` requires `.env-orbit` to exist before the
container can start, which is the file `configure` creates; a plain `docker
run` has no such precondition. `scripts/configure.sh` runs (#1210):

```
docker run --rm --network none [-i [-t]] \
  -e ORBIT_HOST_UID=<uid> -e ORBIT_HOST_GID=<gid> -e ORBIT_IMAGE \
  -e ORBIT_CONFIGURE_TRUST_ORBIT_IMAGE -e ORBIT_CONFIGURE_PROMPTS \
  -e ORBIT_CONFIGURE_APP_URL -e ORBIT_CONFIGURE_OIDC_ISSUER \
  -e ORBIT_CONFIGURE_OIDC_CLIENT_ID -e ORBIT_CONFIGURE_AUTH_MODE \
  -v "<host-deployment-dir>:/orbit-deploy:<ro|rw>" \
  --entrypoint node "$engine_image" /opt/orbit/cli/orbit.js \
  <check [--rollback] | configure ...> --dir /orbit-deploy
```

- `--rm --network none` — a throwaway container with no network: the work is
  file work only.
- `-e NAME` with no value — Docker reads the value from the script's own
  environment and passes it only when set, so no configured value or secret is
  ever on a command line. The OIDC client secret arrives only on standard
  input.
- `-i` for a flow that reads standard input (a piped OIDC secret, machine
  prompts); `-t` as well only when `--init` or `--set-oidc-secret` will
  prompt a person on a terminal (no `ORBIT_CONFIGURE_*` answers and not
  `ORBIT_CONFIGURE_PROMPTS=machine`). The engine prompts on that terminal
  itself. `--check` never gets `-t`, so its output stays plain lines. Without
  `-t` the engine's stdio is the caller's, and the "Machine prompts (v0)"
  grammar above flows over it unchanged.
- `--entrypoint node` — bypasses `container-entrypoint.sh` (the secret
  bootstrap/privilege-drop entrypoint the normal `orbit-app` service uses)
  entirely; the process runs as the image's own declared `USER` (`root`).
- The deployment directory is bind-mounted at the fixed in-container path
  `/orbit-deploy`: `:ro` for `check`, `:rw` for `configure`, which writes
  `.env-orbit`, `.orbit-secrets/` and the VAPID keys. For `--preflight` and
  `--migrate` the mount is the directory of the `--file`, `:ro` and `:rw`
  respectively, because the rollback copy and the deploy lock sit beside it.
  `configure` is pure file work, never Docker (see "Fail-closed guard"
  below).
- The image is resolved by the script before the first engine call, and the
  script never writes configuration itself: `ORBIT_IMAGE` from the
  environment, else the last `ORBIT_IMAGE=` line in `.env-orbit` (read as
  text, never sourced; `--check-rollback` also looks in the rollback copy),
  else it refuses with `No Orbit image to run configuration with. Set
  ORBIT_IMAGE to an immutable registry digest (or the local tag
  scripts/build-container.sh builds), or install with get-orbit.sh, which
  records it in .env-orbit.` The reference must be a digest or the
  installer-generated local tag. A digest that is not present locally is
  pulled; a local tag that is not present is refused, because there is
  nothing to pull.
- Ownership of what the engine writes: the one-off runs as the image's
  `root`, so on rootful Docker the files it created would be root-owned and
  `install.sh` would refuse them. The script passes `ORBIT_HOST_UID` and
  `ORBIT_HOST_GID` (the operator's own ids on rootful Docker; `0:0` on
  rootless Docker, which it detects from `docker info --format
  '{{.SecurityOptions}}'` containing `rootless`, because there container root
  already is the operator), and the engine hands every file and directory it
  creates under `--dir` to that pair (`src/lib/host-ownership.ts`, called by
  every writer). It never uses `--user`: under rootless Docker a numeric
  `--user` maps to a subordinate id the operator cannot access. If it cannot
  hand a file over it refuses rather than leave one behind (#1258).

**Commands that need the deployment itself (`backup`, `restore`,
`export-recovery-bundle`, `import-recovery-bundle`): the compose-attached
one-off.** They read and write the database, the document volume and the
mounted secrets, so they run on the `orbit-app` service, inside the
deployment (#1211). `scripts/backup.sh`, `restore.sh`,
`export-recovery-bundle.sh` and `import-recovery-bundle.sh` run:

```
docker compose --env-file "$environment_file" \
  run --rm --no-deps -i <-t|-T> \
  -e ORBIT_HOST_UID=<uid> -e ORBIT_HOST_GID=<gid> -e ORBIT_HOST_DEPLOY_DIR=<host-deployment-dir> \
  [-e <switch>=<value> ...] \
  -v "<host-deployment-dir>:/orbit-deploy:rw" \
  [-v "<backup-dir>:/orbit-backups:rw" -e ORBIT_HOST_BACKUP_DIR=<backup-dir>] \
  [-v "<secrets-dir>:/orbit-secrets:rw" -e ORBIT_HOST_SECRETS_DIR=<secrets-dir>] \
  [-v "<bundle>:/orbit-input/bundle.tar:ro" -e ORBIT_HOST_INPUT_FILE=<bundle>] \
  --entrypoint node orbit-app /opt/orbit/cli/orbit.js <command> ... \
  --dir /orbit-deploy [--backup-dir /orbit-backups] [--secrets-dir /orbit-secrets]
```

- `--rm --no-deps` — a throwaway container on the `orbit-app` service; no
  other service is started. The one-off is on the project network, so the
  engine reaches `orbit-db` over TCP, has the compose secrets under
  `/run/secrets`, and has the document volume at `DOCUMENTS_ROOT`. It runs
  `pg_dump`, `pg_restore` and `psql` from the image (PostgreSQL 18 client,
  pinned to the server's major by `src/lib/postgres-client-major.test.ts`;
  the engine refuses with `preflight/tools failed` before a dump if the
  server is a different major) and `tar` on the volume, all locally
  (`src/lib/in-container-adapter.ts`). The database password reaches each
  tool as `PGPASSWORD` in its own environment, never on a command line.
- `-i` always; `-t` when both standard input and standard output are a
  terminal, otherwise `-T`. On a terminal the engine prompts for the
  recovery passphrase and the `RESTORE`/`IMPORT RECOVERY` confirmations
  itself. `ORBIT_RECOVERY_TEST_MODE=true` reads each answer as a plain line
  on standard input with no prompt text, as the scripts' test mode always
  did; the "Machine prompts: backup/restore/recovery (v0)" grammar above is
  unchanged.
- Switches travel as `-e NAME=value`, only when set: `ORBIT_NONINTERACTIVE_RESTORE`,
  `ORBIT_RECOVERY_TEST_MODE`, and restore.sh's test switches
  (`ORBIT_RESTORE_TEST_*`, which `scripts/test-backup-restore.sh` sets). None
  is a secret; passphrases only ever travel on standard input.
- `ORBIT_ENV_FILE` is the `--env-file`. `ORBIT_BACKUP_DIR` and
  `ORBIT_SECRETS_DIR`, when they name somewhere other than the deployment's
  own `backups/` and `.orbit-secrets/`, get mounts of their own and are
  passed as `--backup-dir`/`--secrets-dir`; the script creates an outside
  backup directory (mode 700) itself, so Docker never creates it as root.
  The bundle being read is mounted read-only at `/orbit-input/bundle.tar`.
  The `ORBIT_HOST_*` variables let the engine print host paths
  (`src/lib/host-paths.ts`): `Orbit backup created: /srv/orbit/backups/...`,
  never the mount point.
- Ownership: the one-off runs as the image's `root` (it must read the
  `orbit`-owned document objects). Every file and directory it creates under
  `/orbit-deploy`, `/orbit-backups` or `/orbit-secrets` — the backups
  directory, the lock file, bundles, the restore journal and checkpoints, a
  swapped document key — is handed to `ORBIT_HOST_UID:ORBIT_HOST_GID`, as for
  `configure` above. The document tree on the volume keeps the owners in its
  archive, as `tar` running as root always gave it.
- The backup/restore lock is the engine's: a `flock` on
  `backups/.orbit-backup-restore.lock`, on the bind mount, so it excludes a
  second run on the same host kernel (a backups directory on NFS is not
  supported). A run that finds the lock held refuses at once and exits `75`;
  the shell then leaves `orbit-app` to the run that holds it.
- The shell stops and starts `orbit-app`; the engine never does. `backup.sh`
  stops it, runs `backup`, and starts it again. `restore.sh` (with a bundle
  or `--recover`) and `import-recovery-bundle.sh` stop it for the whole run,
  preflight included, then start it and wait up to 45 seconds for
  `/api/health` — unless `backups/.orbit-restore/restore.journal` exists
  afterwards, which keeps Orbit stopped for `bash scripts/restore.sh
  --recover`. `backup.sh --verify` and `export-recovery-bundle.sh` leave it
  running. The engine reports, once, on standard error, that it left the
  app's lifecycle to the shell:
  `phase=application component=application state=skipped reason=application-startup action=skip elapsed=0s`.
- Exit statuses pass through unchanged.

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
   (`install`/`update` via `src/lib/install-docker-adapter.ts`) calls
   `refuseDockerInContainer` as the FIRST statement in its command function
   — before any adapter is constructed, so the code path that would spawn
   `docker` is never reached, not merely made to fail once reached. When
   `ORBIT_ENGINE_CONTEXT=container` is set, that call prints
   `orbit: refused command=<command> reason=docker-command-forbidden-in-container`
   to stderr and exits `9`, before touching the target directory or any
   subprocess. `check` and `configure` (the pure-logic commands — `configure`
   added by issue #294, and the commands that run in the plain `docker run`
   shape above) never call this guard and are unaffected: they work fully
   against a bind-mounted deploy directory, in or out of a container, and
   never spawn `docker` under any invocation — `src/cli/orbit.test.ts`,
   `src/cli/orbit.configure.test.ts`, and the bundle's own smoke test assert
   this with a booby-trapped `docker` on `PATH`.
3. `backup`, `restore`, `export-recovery-bundle` and `import-recovery-bundle`
   spawn no `docker` at all since #1211: they run only inside the
   deployment, and anywhere else refuse with `orbit: <command> runs inside
   the deployment; use bash scripts/<script>.sh.` (exit 1).
   `src/cli/orbit.test.ts` asserts a booby-trapped `docker` is never called.

This is a permanent architectural boundary, not a placeholder pending a
future slice: any command that genuinely needs to touch Docker stays a
host-side operation for good, per the owner's decision above — the engine
computes, validates, and directs; the host's own bash scripts are the only
layer that ever runs `docker`.

### Delegation points

Since #1210 every flow of `scripts/configure.sh` runs in the engine. There is
no opt-in variable and no bash fallback. With no image to run,
`configure.sh` refuses (message above) rather than configure by other means.

| `configure.sh` flow | Engine command | Mount |
|---|---|---|
| (no flag) | `configure` | `:rw` |
| `--init` | `configure --init` | `:rw` |
| `--set-oidc-secret` | `configure --set-oidc-secret` | `:rw` |
| `--set-deployment-profile PRESET [MODEL]` | `configure --set-deployment-profile PRESET [MODEL]` | `:rw` |
| `--check` | `check` | `:ro` |
| `--check-rollback` | `check --rollback` | `:ro` |
| `--preflight`, `--migrate` | `configure --preflight`, `configure --migrate` (with `--file`; install.sh's arguments) | the file's directory, `:ro` and `:rw` |

- The exit status and standard output are the engine's, unchanged: `--check`
  and `--check-rollback` print the same enum-only readiness report (see
  "Configuration readiness report (v0)") and exit codes `repair.sh` and
  `orbit-launcher` already read.
- VAPID keys are generated by the engine, as the last step of the bare flow
  (`src/lib/vapid-keys.ts`); nothing in `configure.sh` builds or runs another
  image for them.
- A real terminal is passed through to the engine, which does all the
  prompting itself (`--init`, `--set-oidc-secret`). The non-terminal shapes
  are the same as before: the fully-scripted `ORBIT_CONFIGURE_*` environment
  triad, the `ORBIT_CONFIGURE_PROMPTS=machine` grammar above, and a piped
  secret line.
- `install.sh` and `repair.sh` call `scripts/configure.sh`; `deploy-container.sh`
  builds or pulls the image first, then runs `configure.sh`.
- `backup`, `restore` and the recovery-bundle commands use the compose-attached
  shape above (#1211).

`docs/adr-notes/294-configure-write-port-plan.md` records the design of the
opt-in era this replaced.

## Repair stream (v0)

`scripts/repair.sh` writes its own line grammar, separate from the installer
event stream above: no `installer_ui_emit`, no `phase`/`component` vocabulary.
It is documented here as a versioned machine interface because the launcher
consumes it (#533), and a consumer that has to guess is a consumer that breaks
silently when the wording changes.

**stdout is unconditionally plain**, deterministic and ANSI-free, regardless of
terminal or of `--plain` — which is accepted anywhere in the argument list and
is inert, kept only so a caller may pass it without special-casing repair.
Human guidance goes to **stderr**, never stdout. A consumer therefore reads
stdout for state and stderr for nothing at all.

The rule that makes this safe to depend on: **parse enums, exit codes and the
prompt grammar; never parse prose.** Prose on stderr is deliberately unstable.

### Line grammar

```
finding class=<class> target=<target> severity=info|warn|fail
diagnosis result=<result> checked=<n> skipped=<n>
plan action=<action> resolves=<class> mutation=<mutation> backup=<backup> target=<target> rollback=<rollback> expect=<expect>
plan result=<result> actions=<n> manual=<n>
execute action=<action> resolves=<class> result=done|failed|skipped
execution result=<result> done=<n> failed=<n> [reason=<reason>]
dangerous result=<result> done=<n> failed=<n> reason=<reason>
```

The `plan action=` line's trailing three fields are #681's preview contract:
`target` repeats the resolved finding's own target enum, `rollback` names
the rollback point (`recovery-directory | credential-checkpoint |
prior-mode | not-required`), and `expect` names the expected result of the
action succeeding (`files-restored | permissions-safe | secret-recreated |
authentication-restored | services-healthy | configuration-valid |
operator-action`). All three are closed enums; unknown-key tolerance means
a pre-#681 consumer keeps working unchanged. `execution result=refused`
carries a `reason=` key (currently only `deployment-version-unsupported`);
no other execution result does.

Unknown keys are ignored by consumers; unknown enum values are renderable but
unstyled, exactly as for the installer stream.

### result vocabularies

Each line form has its own closed set. They are not interchangeable — a
consumer must not, for example, expect `failed` on a `plan` line.

```
diagnosis result=  healthy | attention | failed
plan result=       empty | ready | manual-required
execute result=    done | failed | skipped
execution result=  empty | complete | unactionable | declined | failed
                   | refused
dangerous result=  empty | complete | refused | failed
dangerous reason=  none | non-interactive | refused-by-operator
                   | checkpoint-failed | step-failed
```

`refused` is not a failure: the dangerous batch was never attempted, and
`reason` says why. Treating it as a failure reports a problem where the
operator simply declined, or where no terminal was available to ask.

### finding class

```
application-unhealthy                   image-identity-mismatch
compose-interpolation-failed            managed-file-missing
configuration-incomplete                managed-file-permissions
configuration-invalid                   managed-file-symlink
configuration-migration-interrupted     migration-failed
container-foreign-owner                 not-orbit-directory
database-below-floor                    secret-missing
database-credential-mismatch            secret-permissions
database-credential-unverifiable        secrets-directory-invalid
database-schema-mismatch                staging-evidence-present
database-unreachable                    stale-container
deployment-version-unsupported          unrelated-resource-present
docker-unavailable                      volume-retained-without-credentials
document-volume-retained-without-key
```

### action, mutation and backup

Every planned action declares what it may change and whether it takes a
content backup first. `mutation` is the field a consumer keys destructiveness
off — never the action's name.

| action | mutation | backup |
| --- | --- | --- |
| `restore-transaction` | `reversible` | `required` |
| `fix-permissions` | `reversible` | `not-required` |
| `regenerate-secret` | `reversible` | `not-required` |
| `rotate-database-credential` | `credential-rotation` | `required` |
| `restart-services` | `service-restart` | `not-required` |
| `rerun-configuration` | `none` | `not-required` |
| `manual` | `none` | `not-required` |

`manual` is not an action repair performs: it marks a finding a human must
resolve, and carries one value-free guidance line on stderr.

### Exit codes

Repair's exit vocabulary is its own and **collides with `install.sh`'s** —
install's `3` is "blocked", repair's `3` is "attention". A consumer must never
route one script's exit code through the other's table.

| Mode | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--check` | healthy | — | usage | attention (warn only) | failed (any fail) | not-an-orbit-installation | — |
| `--plan` | empty | — | usage | plan-available | unplannable-failures-present | not-an-orbit-installation | — |
| `--execute --safe-only` | succeeded | declined | usage | — | failed | not-an-orbit-installation | execution refused |
| `--execute --dangerous` | empty or complete | safe batch declined | usage | — | failed in either batch | not-an-orbit-installation | refused (either gate) |
| `--export-diagnostics` | written | declined | usage | — | could not write | not-an-orbit-installation | — |

`5` (`not-an-orbit-installation`) has the identical trigger and meaning in
every mode: the target directory carries no Orbit fingerprint at all. A
consumer that treats it as a generic failure will tell an operator their
deployment is broken when in fact they are standing in the wrong directory.

`6` uniformly means "refused, unmutated" — nothing was attempted. Under
`--execute --dangerous` that is the dangerous batch's own refusal
(non-interactive, or declined by the operator). Under either `--execute`
form it is also the whole-execution refusal on an unsupported deployment
version (`execution result=refused reason=deployment-version-unsupported`,
ADR-0016/#681). It is not a failure.

`130` is the interrupted-by-signal case, as everywhere else.

### Machine prompts

`ORBIT_REPAIR_PROMPTS=machine` extends the #297 prompt grammar to repair,
regardless of TTY-ness. Prompt lines on stdout, one answer line per prompt on
stdin:

```
prompt field=safe-batch                    kind=confirm    required=true attempt=1
prompt field=action-word                   kind=typed-word required=true attempt=<n>
prompt field=checkpoint-passphrase         kind=secret     required=true attempt=<n>
prompt field=checkpoint-passphrase-confirm kind=secret     required=true attempt=<n>
prompt field=export-diagnostics            kind=confirm    required=true attempt=1
```

With neither a controlling terminal nor this opt-in, there is nobody to ask, and
each confirmation resolves on its own terms rather than by one blanket rule:

| Confirmation | Unattended outcome |
| --- | --- |
| safe batch (`--execute --safe-only`) | **proceeds** |
| dangerous batch (`--execute --dangerous`) | refused: `dangerous result=refused … reason=non-interactive`, exit `6` |
| `--export-diagnostics` | declines, exit `1` |

The safe batch proceeds because `--safe-only` is mandatory alongside `--execute`
in v0, so reaching that point is already the automation contract's intended
unattended path — every action in the batch is reversible and none of them mints
or rotates a credential. Nothing dangerous ever runs unattended.

One consequence a consumer has to handle: **the unattended safe batch emits no
`plan` lines.** The plan preview exists to show an operator what they are
approving, so where nothing is asked, nothing is previewed. A consumer that
waits for a `plan` line before reading `execute` lines will wait forever on this
path.

### Changing this vocabulary

Any change to the enums, fields or exit codes above lands **in the same pull
request as its update here**. A consumer pinned to v0 is entitled to assume
that a value it has never seen is new rather than renamed; splitting the change
from its documentation is what breaks that.
