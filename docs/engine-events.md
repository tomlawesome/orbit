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
