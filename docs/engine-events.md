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
