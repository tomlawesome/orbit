# Orbit administrator operations

This document is for the person who runs an Orbit instance. It says what the
administration screen and the operations APIs show you, what they hide, and
what you can do from them. It is also the contract those surfaces are held
to: the operations interface is for diagnosing and correcting, not a general
database editor or log viewer.

A few words used throughout:

- **Bounded** means a value comes from a fixed list of words that Orbit
  chose in advance. A bounded reason can name a kind of failure, but it can
  never carry a password, an address, a filename or an error message.
- The **document key** (`DOCUMENT_KEK`) is the one master key that protects
  every encrypted document and detail. "KEK" stands for key-encryption key.
- **CSRF proof** is a check that a request came from Orbit's own pages, not
  from another website you happened to have open.

## Information boundary

Only signed-in instance administrators can use the operations APIs. Every
response is marked not to be cached. A response may contain:

- worker state and the time of the last successful cycle;
- whether each provider is configured or not;
- counts by bounded status and safe failure category;
- job identifiers, kind, attempts, lifecycle state and timestamps;
- actor, household and action labels from the audit history.

A response never contains credentials, provider URLs, recipient addresses,
push endpoints or keys, raw exception text, raw audit `changes`, document
names, content, hashes or storage keys, request headers, sessions, or message
bodies.

Before a worker records a failure it turns the error into one of a fixed set
of categories:

- notifications: `smtp_unconfigured`, `smtp_unavailable`, `smtp_rejected`,
  `push_unconfigured`, `push_unsubscribed`, `push_unavailable`,
  `recipient_preferences_disabled`, or `unknown`;
- documents: the existing controlled codes such as `key_unavailable` and
  `purge_failed`, plus `scanner_unavailable`, `scanner_timeout`,
  `scanner_protocol`, `scanner_failed`, `staging_object_invalid`,
  `scan_recovery_expired`, and `stage_purge_failed`.

Raw notification errors recorded in the past stay internal and are never
returned.

## Readiness and classified diagnostics

`GET /api/health` is public and says nothing about why. It checks the
database, which Orbit cannot run without, and answers HTTP `200` with `ready`
or HTTP `503` with `degraded`. Neither answer names the dependency or its
error, and neither may be cached. The optional services (SMTP, push, IMAP, the
virus scanner and the document processor) do not affect this answer: when one
of them fails, core records stay readable.

As an administrator you use four surfaces together, each answering one kind
of question:

| Failure class | Where to look | What it can show |
| --- | --- | --- |
| Required dependency | `/api/health` | `ready` or `degraded` only |
| Configuration and provider | `/api/admin/operations` | configured state and an allowlisted provider category |
| Queue | `/api/admin/operations` | bounded status counts, safe failure category, attempts and timestamps |
| Storage and document dependencies | `/api/admin/documents/health` | allowlisted encryption, storage, scanner, model extraction, quota and worker state |

### Model extraction (ADR-0025 section 5)

`/api/admin/documents/health` includes a `modelExtraction` entry with one of
three states. It exists so that an instance where every upload is quietly
getting the built-in (heuristic) suggestions alone does not look healthy:

- `not_configured` — the optional AI add-on is not running. That add-on is the
  `ai` Compose profile, and the profile is the only switch: there is no
  in-app toggle. This is a normal state, not a warning. Most instances stay
  here for good, and it never makes overall health degraded.
- `ready` — the model is answering, and recent attempts are mostly succeeding.
- `unavailable` — the add-on is running but the model is not answering
  (`unreachable`), or more than half of the recent attempts came back with
  nothing (`failing`). This makes overall health degraded.

The entry also gives three counts for the recent window: attempts, failures,
and how many of the failures were timeouts. A handful of timeouts with the
status still `ready` means a host that is occasionally slow; `unreachable`
means a model that is down. The entry never names a document, its content or
the selected model. It is counts and a fixed list of reasons.

The person uploading never sees a model failure: no error, no blocked step,
just the built-in suggestions instead.

The administrator routes stay session- and administrator-protected and are
never cached. A degraded optional category can be acted on by itself, and does
not reveal configuration values, provider identity, private content or raw
dependency errors.

## Operational log contract

Two settings control the logs. `ORBIT_LOG_LEVEL` takes `error`, `warn`,
`info` or `debug` and defaults to `info`. `ORBIT_LOG_FORMAT` is optional and
takes `text` (the default) or `json`. An invalid value falls back to the safe
default. Both formats show the same events with the same fields; neither has
anything the other lacks.

Every record has a timestamp, level, component, event, lifecycle `state`, and
bounded `reason`, `action`, `impact` and `duration_ms` values. Records about a
configuration problem also carry fixed `setting`, `problem_code` and
`fallback` values. A record may end with a `detail`: a short quoted phrase for
what the fixed words cannot say on their own, such as which migration
disagreed. The wording of a detail comes from Orbit's own source. Only
identifiers such as migration tags and counts are filled in, so a detail never
carries SQL, configuration values or credentials. Text output is one line per
record with stable columns; JSON has the same fields with the same meanings.
Colour is used only on a real terminal. It is off for `NO_COLOR`, for output
that is piped or redirected, and for JSON, and it is never added to collected
logs.

The lifecycle states are `starting`, `ready`, `degraded`, `retrying`,
`recovered`, `exhausted`, `stopping`, `disabled`, `invalid`, `blocked` and
`completed`. Components cover application, configuration, authentication,
database and migrations, notification and delivery, document, scanner and
parser, mail receipt and ingestion, backup and recovery, and shutdown. A
steady state that has not changed, such as `ready`, is logged once for the
life of the process. A failure or retry state that persists is logged again
after a fixed 60-second cooldown. Going from unhealthy back to healthy is
logged as `recovered`; the first `starting` to `ready` is just `ready`.

Ordinary logs never contain raw exceptions, stack traces, provider responses,
SQL, filenames, paths, hosts, URLs, recipients, tokens, user, household or
document identifiers, message or document content, or configuration values.
When a worker catches an error it classifies the failure and carries on
polling. An unexpected failure at process startup still stops the process and
is never silently swallowed. Database notices and launcher errors are reduced
to fixed classifications.

The event groups you will see:

| Component | Starting and healthy path | Failure, and what you do |
| --- | --- | --- |
| Application and configuration | `application.startup` and `configuration.problem` | an invalid or optional setting is blocked or degraded with a safe fallback and a fixed remediation |
| Authentication | `auth.configuration`, `auth.provider` | discovery, token and callback failures block sign-in without provider detail |
| Database and migrations | `database.connection`, `database.migration` | notices, unavailable connections and migration integrity failures stay bounded |
| Document, scanner and parser | `document.lifecycle`, `document.scan`, `document.parse`, `document.worker` | required scanning fails closed; retries, recovery and exhaustion name the safe action |
| Notifications and delivery | `notification.worker`, `delivery.smtp`, `delivery.push` | provider failures are categorised and retried or exhausted, without recipients |
| Mail receipt and ingestion | `imap.receipt`, `imap.ingestion` | preflight and worker failures show a bounded retry or degraded state |
| Backup, recovery and shutdown | `backup.operation`, `recovery.operation`, `shutdown.signal` | scripts and runtime operators use fixed recovery and stopping classifications |

Backup and restore are things you run deliberately. Their command-line output
is static and content-free. The application reserves the same bounded backup
and recovery states for integrations, and never logs an archive path or
private data.

## Logs, audit, health, and administrator diagnostics

Each surface answers one question:

- Logs answer "what operational transition just happened?" and are not kept.
- The audit trail answers "what security or data action was accepted?" and is
  kept, using the existing safe action labels.
- Public health answers only "is the required database there?" and is
  unchanged.
- The administrator-only operations surface answers "what is the current
  bounded state, and what safe action can I take?" It includes the in-memory
  registry of configuration problems: a fixed code, severity, setting
  category, safe fallback and remediation, and nothing else. It is served by
  the existing administrator-protected operations route. Anyone signed out, or
  signed in but not an administrator, gets the same authorisation failure and
  cannot read diagnostics.

Roll out with the default text format and your existing level. Turn on JSON
only for a controlled log collector that keeps to the same privacy contract.
To go back, unset `ORBIT_LOG_FORMAT` or set it to `text`; no database
migration or outside telemetry service is involved. If a new classification
is ever needed, it is added to the bounded model and its tests before use,
rather than logging arbitrary values.

## Corrective actions

Every change you make through the operations surface needs CSRF proof,
administrator authorisation, and the item to be in exactly the state the
action expects. An accepted change writes an audit event. If the item is
missing, has moved on, was already acted on, is being processed, or the update
touches no row for any other reason, you get the bounded conflict result and
no misleading success is written to the audit trail.

- A failed or cancelled notification can be retried. Its attempt count, lock,
  sent time and failure state are cleared and it is scheduled straight away.
- A pending, retrying or failed notification can be discarded; it becomes
  cancelled.
- A failed scanner recovery job can be retried from attempt zero. Its recovery
  expiry does not change. A failed final stage purge can be retried as a
  deletion only; it never goes back into scanning.
- A restore keeps a scanner job's attempt count and its failed or manual
  state; only live pending, retry or processing leases are put back in the
  queue.
- A failed document job can be discarded; it becomes cancelled. Discarding or
  expiring a scanner recovery rejects the metadata and schedules a secure
  purge of the staged file that is safe to run more than once. If that
  deletion fails, it stays visible to you as a `purge_pending` backlog, never
  a claimed success.
- Work that is being processed is never changed by an administrator. The API
  gives the same conflict response for an ID that does not exist and one that
  cannot be acted on, so it cannot be used to discover IDs.

Notification delivery is at-least-once: SMTP cannot guarantee that a provider
accepted a message and that Orbit's database update afterwards also succeeded.
The retry action tells you this: retrying can send a duplicate.

When a document worker finishes a job it presents a one-time claim that
cannot be guessed. A worker that has been overtaken by a newer one cannot
overwrite the newer worker's job.

## Maintenance mode and the way back in

Maintenance closes Orbit to users while administrators keep full access
(ADR-0013). Administrators pass the request guard on every route, so the
maintenance control needs no special exemption. Someone who is not an
administrator and tries the control during maintenance gets the same bounded
`503` as on any other path; from outside, the control cannot be found or
used.

Sign-in stays open during maintenance: the sign-in page and the OIDC login,
callback, session and logout routes are exempt. So the ordinary way back in
is to sign in and end maintenance from the control.

While the instance is closed but healthy, `/api/health` answers `200` with
`status: maintenance`. Orchestrators keep routing traffic to it and do not
restart it. Only a real dependency failure answers `503 degraded`.

### The emergency path, when OIDC itself is down

If no administrator can sign in, reopen the instance from the host:

```sh
bash scripts/end-maintenance.sh
```

The script runs the application's own "end maintenance" function inside the
already published image, as a throwaway one-off container (ADR-0015). It never
edits the database directly. The write is versioned and audited exactly as an
administrator's would be, with no actor and `origin: operator_shell` in the
audit row, so you can see the recovery in the audit history afterwards.

It also cancels any scheduled maintenance notice that has already come due.
Orbit counts itself as in maintenance if either the maintenance flag is set
*or* such a notice exists, so clearing one without the other would leave the
instance closed and you still locked out.

The script is safe to run twice: against an instance that is already open it
changes nothing, writes no audit row, and still succeeds. It needs the
database to be reachable, which is always so when maintenance is what stands
between users and a running instance.

## Adding a local user

Local sign-in is always available, whether or not OIDC is also on. From
**Administration → Users**, enter the new user's email, display name, and how
long their setup link should stay valid (1 to 14 days, default 7), then
create the account. Orbit **emails the setup link to that address**. The link
is never shown on screen, never returned by the API, and cannot be recovered
afterwards. The new user opens it, sets their own password, and is signed in.

![The "add a local user" form: email, display name, and a "link valid for" days field, with a create button](images/admin-add-local-user.png)

Because the link only ever leaves by email, **an instance with no working
SMTP cannot add a local user.** Configure SMTP first (see "Mailbox provider
operation" below for the provider checks that outbound mail shares with
inbound). If sending fails when the account is created, the account still
exists and its row shows a bounded reason with a Retry action, so nothing
needs recreating.

A local user who has forgotten their password gets the same treatment: "Send
a new setup link" on their row in the users table, behind the same
recent-sign-in challenge as any other sensitive action. Sending a new link
cancels any earlier one for that user. See
[authentication.md](authentication.md#administrator-adding-a-local-user) for
the walkthrough, including what to tell a new user.

## Recovering the primary administrator

If the primary administrator has forgotten their local password, or only ever
used OIDC and has lost the provider, recover from the deployment host:

```sh
docker compose --env-file .env-orbit exec orbit-app node /opt/orbit/cli/orbit.js auth recovery-link
```

The command looks up the current primary administrator in
`instance_authority`, creates a one-time setup link for them, signs them out
everywhere, records the `recovery_link_issued` audit entry, and prints that
one URL to the terminal and nothing else. Opening the link sets (or replaces)
the primary administrator's local password and signs them in. The link
expires **5 minutes** after it is printed: use it straight away. A stale link
gets the same `setup_token_invalid` answer as any other expired or already
used setup link. The command never touches `is_instance_admin` and never
moves primary authority, so it cannot get round the last-administrator or
primary-administrator rules.

Anyone who can run `docker compose exec` on the host can recover the primary
administrator at any time (ADR-0022 §6). That is not a gap the command opens:
host access to the running deployment already means full control of it.

## When the encryption key and the recovery bundle are both lost

This is the last resort, and it recovers nothing. Read the whole section
before running it.

Orbit encrypts documents and personal details, including everyone's email
address, under one key. If that key and the recovery bundle are both gone,
those things are gone with them, permanently. Nothing here brings them back.

What it does fix is the second problem that follows. Orbit finds an account by
its email address, and it can no longer read any address, so **nobody can
sign in at all**. Without this command the instance is a locked box with
everyone's accounts intact inside it.

```sh
docker compose --env-file .env-orbit exec orbit-app node /opt/orbit/cli/orbit.js auth clear-addresses
```

It asks you to type `CLEAR ADDRESSES` before doing anything, and then:

- removes every account address it cannot read — **the accounts themselves
  survive**, with their households, memberships and history intact;
- removes every mail-forwarding address it cannot read; members add and prove
  those again afterwards;
- leaves alone any address it *can* still read.

Then get back in and put the addresses back:

```sh
docker compose --env-file .env-orbit exec orbit-app node /opt/orbit/cli/orbit.js auth recovery-link
```

Open that link to set the primary administrator's password and sign in, then
re-enter members' addresses by hand from the users screen. Each member sets
their own password through a setup link as usual.

**It refuses to run while the key still works.** This is deliberate, and it is
the guard that matters most. If members cannot sign in and the key is fine,
the fault is something else entirely, and running this would destroy addresses
that were never in danger, so the command checks first and stops. If you have
the recovery bundle, restore that instead: it brings the key back and nothing
is lost.

It can only be run from the host shell. No page, no button and no API request
can reach it, deliberately: reachable over the network it would be a single
request that wipes every account's identity. It needs a real terminal, so a
script or scheduled job cannot run it either. Each run is recorded in the
audit log as `account_addresses_cleared`, with counts only. The addresses
could not be read, so there is nothing else to record.

## Provider tests

The SMTP test checks connection and sign-in only. It sends no message and
returns a bounded result category. It has a short timeout and never returns
configuration or the provider's response text. Push tests, when added, go
only to the requesting administrator's own current subscription; they cannot
pick another recipient.

## Deployment configuration readiness

Run guided setup once from the persistent deployment directory, then check the
configuration before every first start and before any material provider
change:

```sh
bash scripts/configure.sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

The first command is the non-interactive bootstrap and upgrade path. It
creates any missing generated secrets and keeps your existing settings.

Guided setup first asks whether people sign in with local accounts only, or
also with an identity provider (`ORBIT_AUTH_OIDC`, default local-only). If you
answer "also", it records the public HTTPS Orbit origin, the complete OIDC
issuer, the client ID and the callback URL it works out from those, writing
them all in one go so a failure part-way leaves nothing half-written. It does
not ask for provider credentials.

The separate secret step reads the OIDC client secret without echoing it,
stores it in one go at `.orbit-secrets/oidc-client-secret` with mode `0600`,
and records only the path `/run/orbit-secrets/orbit-oidc-client-secret` in
`.env-orbit`. Never give the secret on the command line or through a shell
pipeline that contains it as text.

Setting `ORBIT_AUTH_OIDC` back to `false` later turns provider sign-in off
without deleting its configuration, so you can turn it back on without
re-entering anything; see
[authentication.md](authentication.md#adding-oidc-later).

The readiness check looks for required settings that are missing, secrets
given both directly and as a file, and optional groups that are only partly
configured. Its output has only field names and readiness categories, never
values. A failed check is yours to resolve before deploying. Keep the
persistent `.env-orbit` file at mode `0600`. A secret is given either
directly or as a file, never both. Ordinary configuration runs and recognised
upgrades keep the OIDC secret file. Never put credentials in command
arguments, terminal history, issue text, chat or logs.

## Configuration

Every supported setting is listed, with comments, in
[`.env-orbit.example`](../.env-orbit.example). A sensitive setting can be given
either directly (for example `SESSION_SECRET`) or as the path to a file
holding it (`SESSION_SECRET_FILE`). Set one form or the other, never both.

The generated `.env-orbit` is short and grouped into Core, Authentication,
Generated secrets and keys, Deployment, Optional services and Observability.
Defaults and tuning examples stay in `.env-orbit.example` for reference. Fill
in an optional group completely or not at all, then run
`bash scripts/configure.sh --check` before starting or updating Orbit. The
check prints setting names and their state, never values.

The examples below show the expected shape only. Generate real secrets; never
copy a placeholder into a real deployment.

The installer creates the database password, session secret, document key
and private push key files in `.orbit-secrets/`, and Compose hands each one to
Orbit under `/run/orbit-secrets/`. If you choose a different `_FILE` setting,
create that file yourself and add a matching read-only secret mount to the
Compose service.

In the table, "Orbit" means the Orbit container, which also runs the
notification scheduler; there is no separate worker. A "digest" is a build's
fingerprint: it identifies one exact build and nothing else. The "document
key-encryption key" is the master key that protects each document's own key.

| Variable | Used by | Purpose | Example value |
| --- | --- | --- | --- |
| `APP_URL` | Orbit | The address people use in the browser; also used for cookies and request checks. Use HTTPS except on loopback. | `https://orbit.example.com` |
| `ORBIT_AUTH_OIDC` | Orbit | `true` turns on sign-in through an identity provider and makes the `OIDC_*` settings required. While `false`, those settings may stay filled in and are ignored. | `false` |
| `ORBIT_IMAGE` | Compose | Exact `registry/repository@sha256:...` identity for pulled deployments. Repository build scripts supply a revision-specific local tag instead. | `ghcr.io/tomlawesome/orbit@sha256:<64 lowercase hexadecimal characters>` |
| `COMPOSE_PROJECT_NAME` | Compose | The Compose project name the installer recorded. Written by the installer; do not edit it after installation. | `orbit` |
| `ORBIT_CONFIG_APPLIED_VERSION` / `ORBIT_CONFIG_APPLIED_DIGEST` | Installer | The version and build fingerprint that last checked this file. Written by the installer; never edit them. | `v0.3.0` / `sha256:<64 lowercase hexadecimal characters>` |
| `ORBIT_CONFIG_SCHEMA_VERSION` | Installer | The layout version of `.env-orbit` itself. Written by the installer. | `1` |
| `ORBIT_LOG_LEVEL` | Orbit | How much the log says: `error`, `warn`, `info` or `debug`. Document content, file names and recipients are never logged. | `info` |
| `ORBIT_LOG_FORMAT` | Orbit | `text` or `json`, for a log collector. Both carry the same fields. | `text` |
| `COMPOSE_PROFILES` | Compose | Optional services to run: `processing` for the document text reader, `ai` for the private model server, or both. Empty runs the standard stack. | `processing,ai` |
| `ORBIT_BIND_ADDRESS` | Compose | Host interface that publishes Orbit. Use loopback when a reverse proxy is on the same host. | `0.0.0.0` |
| `ORBIT_PORT` | Compose | Host TCP port mapped to container port 3000. | `3000` |
| `SESSION_SECRET` | Orbit | Direct session-signing secret. Leave empty when `SESSION_SECRET_FILE` is set. | `<64-character-random-hex>` |
| `SESSION_SECRET_FILE` | Orbit | File containing the session-signing secret. The Compose stack sets this to `/run/orbit-secrets/orbit-session-secret`. | `.orbit-secrets/session-secret` |
| `SESSION_TTL_SECONDS` | Orbit | How long a sign-in lasts, in seconds. | `604800` |
| `DOCUMENTS_ROOT` | Orbit | Where encrypted documents are kept inside the container. | `/var/lib/orbit/documents` |
| `DOCUMENTS_QUARANTINE_ROOT` | Orbit | Temporary holding area for an upload while it is scanned; Compose supplies a private in-memory folder that disappears on restart. | `/tmp/orbit-document-quarantine` |
| `DOCUMENT_KEK` | Orbit | Direct 32-byte hexadecimal document key-encryption key. Leave empty when the file form is used. | `<64-character-random-hex>` |
| `DOCUMENT_KEK_FILE` | Orbit | File containing the document key-encryption key. Compose mounts the generated file at `/run/orbit-secrets/orbit-document-kek`. | `.orbit-secrets/document-kek` |
| `DOCUMENT_KEK_NEXT` / `DOCUMENT_KEK_NEXT_FILE` | Orbit | Second document key-encryption key, held alongside the first only while a key rotation is in progress (#954). Set only via the `docker-compose.kek-rotation.yml` overlay — see "Rotating the document key-encryption key" in `docs/administrator-operations.md`. | `<64-character-random-hex>` |
| `DOCUMENT_MAX_BYTES` | Orbit | Largest upload accepted, in bytes, until an administrator sets their own limit under "Upload size limit" in Administration (1 to 100 MiB, no restart). "use the default" there goes back to this value. Allowed: 1048576 to 104857600. | `52428800` |
| `DOCUMENT_HOUSEHOLD_QUOTA_BYTES` | Orbit | Most document storage one household may keep. | `5368709120` |
| `DOCUMENT_INSTANCE_QUOTA_BYTES` | Orbit | Most document storage the whole instance may keep. | `21474836480` |
| `DOCUMENT_RETENTION_DAYS` | Orbit | Days a deleted document can still be restored before it is purged for good. | `30` |
| `DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS` | Orbit | Hours an upload is kept, encrypted, waiting for the malware scanner to come back before it is discarded. | `24` |
| `DOCUMENT_SCAN_MODE` | Orbit | `required` refuses uploads when ClamAV is unavailable; `disabled` skips scanning and shows a permanent warning. | `required` |
| `CLAMAV_HOST` | Orbit | Private Compose hostname of the ClamAV daemon. | `orbit-clamav` |
| `CLAMAV_PORT` | Orbit | Private ClamAV daemon port; do not publish it on the host. | `3310` |
| `CLAMAV_TIMEOUT_MS` | Orbit | Longest a malware scan may take per upload. | `30000` |
| `CLAMAV_MEMORY_LIMIT` | Compose | Memory limit for the scanner container. | `4g` |
| `TIKA_URL` | Orbit | Private address of the document text reader, when the `processing` profile is on. | `http://orbit-tika:9998` |
| `TIKA_TIMEOUT_MS` | Orbit | Longest the text reader may take per document. | `45000` |
| `TIKA_MEMORY_LIMIT` | Compose | Memory limit for the text reader container. | `1g` |
| `OLLAMA_MODEL` | Orbit and Compose | The local model the private model server uses and the pull helper fetches. | `<a-local-model-name>` |
| `OLLAMA_MEMORY_LIMIT` / `OLLAMA_CPUS` | Compose | Memory and CPU limits for the model server. | `6g` / `2.0` |
| `OLLAMA_MAX_QUEUE` / `OLLAMA_KEEP_ALIVE` | Compose | Most requests the model server queues, and how long it keeps a model loaded after use. | `8` / `0` |
| `DATABASE_URL` | Orbit | Complete PostgreSQL connection URL. Leave empty when using the individual PostgreSQL settings. | `postgres://orbit:example-password@postgres:5432/orbit` |
| `DATABASE_URL_FILE` | Orbit | File containing a complete database URL instead of `DATABASE_URL`. | `/run/secrets/orbit-database-url` |
| `POSTGRES_HOST` | Orbit | PostgreSQL hostname. Compose overrides the host-local default with the database service name. | `localhost` |
| `POSTGRES_PORT` | Orbit | PostgreSQL TCP port. | `5432` |
| `POSTGRES_DB` | Orbit and PostgreSQL | Database created and used by Orbit. | `orbit` |
| `POSTGRES_USER` | Orbit and PostgreSQL | PostgreSQL role created and used by Orbit. | `orbit` |
| `POSTGRES_PASSWORD` | Orbit and PostgreSQL | Direct database password. Leave empty when the password file is used. | `<generated-random-password>` |
| `POSTGRES_PASSWORD_FILE` | Orbit and PostgreSQL | File containing the generated PostgreSQL password. | `.orbit-secrets/postgres-password` |
| `OIDC_ISSUER` | Orbit | The identity provider's HTTPS address, which Orbit also uses to discover its settings. | `https://auth.example.com/application/o/orbit/` |
| `OIDC_CLIENT_ID` | Orbit | The client ID the identity provider gave Orbit. | `orbit` |
| `OIDC_CLIENT_SECRET` | Orbit | Direct OIDC client secret. Leave empty when the file form is used. | `<provider-generated-secret>` |
| `OIDC_CLIENT_SECRET_FILE` | Orbit | File containing the OIDC client secret. | `/run/orbit-secrets/orbit-oidc-client-secret` |
| `OIDC_CALLBACK_URL` | Orbit | The exact return address registered with the identity provider. | `https://orbit.example.com/api/auth/callback` |
| `OIDC_SCOPES` | Orbit | Space-separated scopes requested during sign-in; must contain `openid`. | `openid profile email` |
| `OIDC_EMAIL_CLAIM` | Orbit | Which field of the provider's ID token holds the email address. | `email` |
| `OIDC_EMAIL_VERIFIED_CLAIM` | Orbit | Which field says whether the email is verified. | `email_verified` |
| `OIDC_NAME_CLAIM` | Orbit | Which field becomes the person's display name. | `name` |
| `OIDC_AVATAR_CLAIM` | Orbit | Optional field holding the avatar URL. | `picture` |
| `SMTP_HOST` / `SMTP_PORT` | Orbit | SMTP server host and port. | `smtp.example.com` / `587` |
| `SMTP_SECURITY` | Orbit | `starttls` (port 587) or `implicit_tls` (port 465); plaintext SMTP is unsupported. | `starttls` |
| `SMTP_USER` / `SMTP_PASSWORD_FILE` | Orbit | SMTP login and a file containing its password. | `orbit@example.com` / `/run/orbit-secrets/orbit-smtp-password` |
| `SMTP_URL` / `SMTP_URL_FILE` | Orbit | Deprecated compatibility form, given directly or as a file; do not set it with the individual SMTP settings. | `smtps://orbit%40example.com:password@smtp.example.com:465` |
| `SMTP_FROM` | Orbit | Display name and sender address for reminder email. | `Orbit <orbit@example.com>` |
| `VAPID_SUBJECT` | Orbit | Contact address sent with browser push notifications. VAPID is the standard for browser and PWA push; it is not Pushover. | `mailto:admin@example.com` |
| `VAPID_PUBLIC_KEY` | Orbit and the browser | Public push key generated for this deployment. | `<base64url-public-key>` |
| `VAPID_PRIVATE_KEY` | Orbit | Direct private push key. Leave empty when the file form is used. | `<base64url-private-key>` |
| `VAPID_PRIVATE_KEY_FILE` | Orbit | File containing the private push key. | `/run/orbit-secrets/orbit-vapid-private-key` |
| `WORKER_POLL_SECONDS` | Orbit | Seconds between checks of the notification queue. | `60` |
| `MAINTENANCE_TICK_SECONDS` | Orbit | Seconds between checks for a scheduled maintenance notice that is due. Maintenance begins at its scheduled time regardless; this only records the change. | `30` |
| `NOTIFICATION_MAX_ATTEMPTS` | Orbit | Delivery attempts before a notification is marked failed. | `5` |
| `MIGRATE_ON_START` | Orbit | Applies pending database migrations at startup. Compose sets this to `true`. | `false` |
| `WORKER_ENABLED` | Orbit | Runs the notification scheduler inside the application container. Compose sets this to `true`. | `false` |
| `DRIZZLE_MIGRATIONS_PATH` | Orbit | Directory containing versioned SQL migrations. | `drizzle` |
| `ORBIT_SECRETS_DIR` | Compose | Host directory containing files mounted as Compose secrets. | `./.orbit-secrets` |

Inbound mail (the mailbox Orbit polls for incoming statements and documents)
is not set here any more. An instance administrator sets it on the
administration screen, and Orbit stores the credential encrypted in the
database (ADR-0017). No `IMAP_*` setting is accepted.

Reminder email needs the SMTP password in `.orbit-secrets/smtp-password` and
the `docker-compose.mail.yml` overlay, which hands that file to Orbit. Inbound
mail is covered in [Mailbox provider operation](#mailbox-provider-operation).

For production, use HTTPS, file-backed secrets, a private PostgreSQL
connection, and working identity-provider, SMTP and push credentials. Keep
recovery bundles somewhere other than the Docker host before storing real
household data.

## Mailbox provider operation

Mailbox ingestion is optional. An installation that does not use mail runs the
base `docker-compose.yml` without mail secret files.

**The mailbox is not container configuration.** Since ADR-0017 an instance
administrator sets it on the administration screen, and Orbit stores the
password encrypted in its own database under the document key. No `IMAP_*`
environment variable is accepted any more; one left in `.env-orbit` fails the
configuration check as a removed key. Outbound SMTP is unchanged and is still
deployment configuration.

To configure inbound mail:

1. Configure SMTP first, and deploy the mail overlay so the SMTP password is
   mounted from `${ORBIT_SECRETS_DIR}/smtp-password`. Put it there from a
   secret manager or a private editor, not a command argument. The path must
   be a non-empty ordinary file, not a symbolic link, and readable only by the
   deployment operator.

   ```sh
   docker compose --env-file .env-orbit \
     -f docker-compose.yml -f docker-compose.mail.yml config --quiet
   COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml \
     bash scripts/deploy-container.sh --pull
   ```

2. Sign in as an instance administrator, open **Administration → Mail
   machinery**, and enter the mailbox: host, port, account address, folder,
   TLS server name, provider profile, envelope-recipient header, poll seconds
   and the mailbox password.

   ![The mailbox settings form: host, port, account, folder, TLS name, provider, envelope header, poll seconds and password](images/admin-mailbox-settings-form.png)

3. Orbit connects to the provider and signs in **before** it stores anything.
   If the provider refuses, whatever was there before is untouched and no part
   of the password is stored; only a successful check commits it.

Two things are worked out from the account address rather than entered: the
collection domain, and the base local part every member's relay address is
built on. Relay addresses are plus-addresses of that account
(`account+<code>@domain`), so it must be an address the provider delivers
sub-addressed mail to.

The alias key, which Orbit uses to make each member's relay address, is
generated at first setup, stored encrypted alongside the password, and never
shown to anyone, members included. Changing the account address generates a
new alias key, which changes every member's relay address; correcting a host,
port or folder does not.

**Forward, do not redirect.** The only supported way to use a relay address is
for a member to forward mail to it from their own mailbox. A redirect keeps the
original sender's address, so the message looks to Orbit as though somebody
else sent it, matches nobody, and is deleted. Handing a relay address to a
supplier, a bank or a web form is unsupported for the same reason. Tell members
this when you tell them the relay exists.

Orbit matches a forwarded message to a member by the address it was sent from,
and only when your provider's own check says that address is genuine. That
check is the `Authentication-Results` header your provider writes, and Orbit
has to know whose header to believe: that is the **trusted authserv-id** on the
mail settings screen. Gmail and Outlook are known, so leaving it blank works
for them. For Mailcow or any other provider it is your own mail server's
hostname, the name it writes at the start of that header. Until you fill it in
Orbit believes nothing, matches nothing to anybody, and says so on each
member's relay page. That is deliberate: guessing would be the guess an
attacker gets to use.

A message Orbit cannot match to a member is deleted from the mailbox, and
nothing is kept for you or anyone else to look at. The sender is told once, and
only when your provider vouched for them: never a mailing list, never an
autoresponder, never twice in a day, and never quoting what they sent.

Each member can pause their own collection from the same page. While they are
paused, mail addressed to them is recorded as having arrived and nothing else
happens to it: no attachment is fetched, nothing is stored, and they are not
told. Turning it back on prepares everything that was waiting, once. A held
message expires on the same schedule as any other, after which it lives only in
the provider mailbox. One member pausing changes nothing for anybody else.

What you see of any of this is a count. The operations view reports how many
receipts sit in each state, including held and unattributed, and never whose
they are or what address they came to.

Members rotate their own relay address from their relay page, and one member
rotating changes nothing for anybody else. The one exception is an emergency:
you can replace the alias key for the whole instance, which changes every
member's address at once. Choose how long the old addresses keep collecting,
anything from none at all up to 90 days, and mail already on its way arrives
at the old address until that runs out. Everything else about rotation belongs
to the member, not to you: you can see that a rotation happened and who did
it, never the address itself.

When the container starts it copies the mounted Compose secrets into a
private in-memory folder that disappears when the container stops, gives them
to Orbit's unprivileged runtime user, sets mode `0400`, then drops root. The
application reads only the `/run/orbit-secrets/...` copies. A secret that is
missing, partial, empty, a symbolic link, oversized, or given both directly
and as a file stops startup.

SMTP and IMAP are checked separately, each with certificate and hostname
validation. SMTP supports required STARTTLS or implicit TLS; plain text and
opportunistic downgrade are not supported. IMAP uses implicit verified TLS on
the port you configured; it does not assume a provider uses only the default
port. Polling cannot begin until both current configurations pass their
checks. If a provider is down at startup, mailbox ingestion is degraded and
retryable while core records, the durable cursor (Orbit's record of how far
through the mailbox it has read), existing private drafts and cleanup
obligations stay available.

The administrator operations view shows only these mailbox states:

| State | What it means for you |
| --- | --- |
| `not_configured` | Required provider or alias configuration is absent. |
| `disabled` | Polling is intentionally off; existing state is kept. |
| `verification_pending` | The current configuration has not yet passed both provider checks. |
| `available` | Both provider checks passed and polling may run. |
| `provider_unavailable` | A bounded provider connection or sign-in check failed. |
| `unsafe_input` | The configuration is malformed or contradicts itself. |
| `credential_locked` | The stored password could not be decrypted under the current key (ADR-0017); polling is stopped until an administrator re-enters it. |
| `retrying` | A content-free notification is waiting for a bounded retry. |
| `exhausted` | A content-free notification reached its attempt limit. |
| `retention_backlog` | Private staging cleanup needs your attention. |

Verification and retry actions need a signed-in instance administrator,
same-origin CSRF proof, and responses that are never cached. They never return
recipients, aliases, filenames, message or document content, hashes, storage
identifiers, credentials or raw provider errors. Being an administrator does
not give you access to a user's private receipt, draft, staged attachment or
their review page.

What the mailbox settings screen shows, and only this: host, port, account
address, folder, TLS server name, provider profile, envelope-recipient header,
poll seconds, verification state and time, who set the credential and when,
the *shape* relay addresses take, and the bounded health words above. It never
shows the mailbox password, the alias key or any member's relay address. None
of those can be read back at all.

Mailbox notifications are durable, claimed by one worker at a time, safe to
create more than once, and bounded on failure. Their generic body contains no
source content and links only to `/?open=inbox` on the configured HTTP(S)
application origin. The link still needs sign-in and cannot approve, attach or
write anything. SMTP is at-least-once: if a provider accepts a message just
before Orbit loses its completion update, an explicit retry can send the
generic notification twice. The interface warns before retrying exhausted
deliveries.

### Disable, restart, and credential rotation

All of these are actions on the administration screen. None needs a redeploy,
and none is a container setting.

- **Pause ingest** stops new polling and keeps everything: the mailbox cursor,
  receipts, private drafts and staging are untouched, exactly as the old
  `IMAP_ENABLED=false` kept them. Resume picks up from the durable cursor.
- **Check connection** re-runs the bounded TLS and sign-in check against the
  stored password and records the outcome as a bounded word.
- **Run setup probe** sends one message from the instance to a plus-address
  of the mailbox and watches for it to come back. It answers `delivered` when
  the message arrived with its envelope recipient intact, the only state in
  which mail can be matched to a member. It tells the two failures apart:
  `delivered_without_recipient_header` means the provider delivers
  sub-addressed mail but strips the envelope recipient, and `not_delivered`
  means it does not deliver it at all. Orbit removes its own probe message
  from the mailbox.
- **Rotate password** takes the new password, proves it against the provider
  first, and only then swaps it in. The new encrypted row becomes active and
  the old one is deleted in the same transaction, so a rotation never leaves a
  spent password behind, and a refused one leaves the previous password
  working.
- **Remove credential** deletes the stored password and switches ingest off.
  The host, account and folder stay, and so do the cursor, receipts, drafts
  and staging.
- A routine restart re-checks the current provider settings before polling
  and resumes through the durable cursor and leases. Re-enabling after a
  restart or provider outage uses the kept cursor and receipt identities; it
  must not create a second draft or delivery for mail already recorded.
- Rotate SMTP separately: replace its host secret file in one step and
  restart the exact deployed image. Never put a credential in a command,
  screenshot, issue, log or acceptance record.

If the document key is replaced **without** rewrapping (a recovery-bundle
import, or repair regenerating `document-kek` when no document volume is
kept) the stored mailbox password can no longer be decrypted. Mail-in reports
`credential_locked`, polling stops, and you re-enter the password on the same
screen. That is acceptable for those two paths because a mailbox password can
be fetched again from the provider; documents and encrypted metadata cannot.
Both paths are a wholesale key *replacement*, not a rotation, and neither
keeps the old key for a rewrap to use. An ordinary planned rotation is
different (see "Rotating the document key-encryption key" below) and leaves
every credential, document and encrypted field readable throughout.

### Exact-image mailbox acceptance

Acceptance against a real provider is release evidence, not an ordinary CI
secret. Use provider identities set aside for it, keep their credentials only
in the mounted files above, and deploy the exact build under test by its
digest (the fingerprint that names one build and nothing else). Record the
image's `org.opencontainers.image.revision` label and require it to match the
accepted source revision.

Exercise, in order:

1. verified SMTP and IMAP TLS and sign-in;
2. preservation of the configured envelope-recipient header;
3. reconnect and container restart with the durable cursor preserved;
4. one controlled PDF receipt, including a replay that creates no second
   private draft;
5. a generic notification whose link requires sign-in and opens only the
   recipient's private inbox;
6. inspection of the notification content proving that no source, provider,
   recipient, household, item, attachment, alias or draft data is present;
7. a bounded provider failure followed by recovery without loss of the cursor,
   drafts or delivery identities.

The external harness reduces those observations to the yes/no stage schema
accepted by `scripts/acceptance-mailbox.mjs`. Set the expected and inspected
digest and revision independently, use `ORBIT_ACCEPTANCE_MODE=live`, and
direct the sanitised JSON record to a private evidence path with
`ORBIT_ACCEPTANCE_EVIDENCE_FILE`. The script rejects a digest or revision
mismatch and malformed or incomplete proof, and emits no raw provider
material.

`ORBIT_ACCEPTANCE_MODE=fake` produces predictable made-up contract evidence
for ordinary CI only. Its record says so, and cannot be used as live provider
or release acceptance.

## Exporting a recovery bundle

Orbit does not export a recovery bundle for you. If `DOCUMENT_KEK` is ever
lost with no bundle to recover it from, every document, all encrypted
metadata and, once account addresses are encrypted, every stored address are
gone for good, by design (see "Restoring the document key-encryption key"
below). Making a bundle is a deliberate step, and one every deployment should
take before it holds real data:

```sh
bash scripts/backup.sh
bash scripts/export-recovery-bundle.sh backups/orbit-<timestamp>.tar
```

Run them from the deployment directory. Each runs the Orbit engine's own
command (`orbit backup`, then `orbit export-recovery-bundle <backup.tar>`)
inside the deployment, as a one-off container on the app service, so the host
needs Docker and nothing else.

`export-recovery-bundle.sh` asks for the passphrase twice, then locks the live
`DOCUMENT_KEK` under it
passphrase you choose (the passphrase is stretched with scrypt and the key
encrypted with AES-256-GCM) and packages it with the backup you just made into
one file, `orbit-recovery-<timestamp>.tar`.

Keep its two parts apart: the bundle file on storage separate from this
instance, and its passphrase in a password manager or on paper — never both
together. That separation is what stops anyone who gets hold of the file alone
from being able to use it.

The administration screen shows a "No recovery bundle exported" card until a
bundle has been recorded, and again after every `DOCUMENT_KEK` rotation,
because a bundle wrapped under the previous key can no longer recover the
current one. The card is a reminder, not a gate: it never blocks use of the
instance, and it clears the moment `export-recovery-bundle.sh` completes.

![The "No recovery bundle exported" card, persistent until a bundle is recorded](images/admin-no-recovery-bundle.png)

To use a recovery bundle, run `bash scripts/import-recovery-bundle.sh
<recovery.tar>` (it asks for the passphrase, then for `IMPORT RECOVERY`, then
for `RESTORE`) and see "Restoring
the document key-encryption key" below.

## Restoring the document key-encryption key

An instance that starts without `DOCUMENT_KEK` is **locked**, not damaged.
Nothing is lost and nothing is overwritten. Documents cannot be opened;
encrypted notes, references and mail-in extracts cannot be read or written;
and every item edit is refused with a 503, because saving an item rewrites its
encrypted fields. The rest of Orbit stays usable, deliberately (ADR-0024
decision 5): a missing key must not take the household's list down with it.

Members see this at the field: "locked — safe, but unreadable right now", and
a paused edit panel that says an administrator is who fixes it. The
administration screen shows one "Encrypted details are locked" card with how
many items and mail-in messages are waiting. No count and no detail of the key
reaches a member, and Orbit never says the data is gone, because it is not.

![The "Encrypted details are locked" card, with counts of affected items and mail-in messages](images/admin-encrypted-details-locked.png)

To restore it, put the same key back where the deployment expects it and
restart the exact deployed image:

1. Confirm which key this database was written under. Every encrypted row
   records its own `key_id`, and the startup log names the key id Orbit is
   holding. A key that is not the one that wrote them leaves everything locked
   exactly as it was. A wrong key can never damage a value, because
   decryption refuses rather than guesses.
2. Restore the key file from wherever you kept it, your recovery bundle or
   the secrets directory backup, with owner-only permissions:
   ```sh
   install -m 0400 /path/to/your/copy/document-kek .orbit-secrets/document-kek
   ```
3. Restart the deployment:
   ```sh
   bash scripts/deploy-container.sh --pull
   ```
4. Confirm on the administration screen that the "Encrypted details are
   locked" card has gone. It disappears the moment the instance holds a usable
   key. Nothing needs re-encrypting and no backfill runs, because the values
   were never changed.

If the key is really gone and no recovery bundle holds it, this is not a
restore. Encrypted documents and Tier 1 metadata are unrecoverable by design
when both the key and the bundle are lost; that is the whole point of the
encryption. The way back is to restore both the database and the key from a
backup that has them together (ADR-0004).

## Rotating the document key-encryption key

`DOCUMENT_KEK` protects three kinds of stored secret: the key for each
document (`document_crypto`), each household's metadata keys covering Tier 1
and Tier 2 fields (`metadata_keys`, ADR-0024), and the mail-in mailbox
password and alias key (`mail_in_secrets`, ADR-0017). Rotating it is always
your decision (#932). Nothing in Orbit rotates it automatically or on a
schedule.

Nothing is ever locked during a rotation. For as long as it runs, the
application holds **both** the current key and the next one
(`DOCUMENT_KEK_NEXT`, #954, ADR-0024 decision 4). Every row records which key
protects it, so every row stays readable whether or not the rewrap worker has
reached it yet. No maintenance window is needed at any step below.

1. Generate a fresh key and put it where the rotation overlay expects it,
   with owner-only permissions:
   ```sh
   openssl rand -hex 32 > .orbit-secrets/document-kek-next
   chmod 0400 .orbit-secrets/document-kek-next
   ```
2. Give the running application the next key *before* rewrapping anything,
   using the `docker-compose.kek-rotation.yml` overlay:
   ```sh
   docker compose --env-file .env-orbit \
     -f docker-compose.yml -f docker-compose.kek-rotation.yml config --quiet
   COMPOSE_FILE=docker-compose.yml:docker-compose.kek-rotation.yml \
     bash scripts/deploy-container.sh --pull
   ```
   After this restart Orbit holds both keys. Every existing row is still on
   the current key and reads exactly as before; a row the worker moves to the
   next key reads too. From this restart anything newly written (an uploaded
   document, a new household's metadata key, a mailbox password) goes under
   the **next** key straight away (#955), so the rewrap in step 3 is working
   through a fixed set of rows rather than a growing one.

   From this restart you can also see that a rotation is open, until step 4
   removes the second key (#956):

   - the administration screen shows a "Document key rotation in progress"
     card with how long it has been open;
   - every startup logs a `document.kek_rotation` line saying a rotation is in
     progress and for how long;
   - the audit history has one instance-level `document_kek_rotation_started`
     entry naming both key ids, one per rotation however many restarts happen
     inside it.

   Orbit never refuses to start because a rotation has been open a long time;
   that would turn a slow rotation into an outage. So this visibility is the
   whole guard: if the card or the log line is still there tomorrow, the
   rotation was left unfinished.

   ![The "Document key rotation in progress" card, with how long the rotation has been open](images/admin-key-rotation-in-progress.png)

3. Run the rewrap worker. It reads the current key exactly as the running
   application does, and takes the next key only from the file you give it:
   ```sh
   pnpm rewrap-kek --next-key-file .orbit-secrets/document-kek-next
   ```
   It reports progress and keeps going until every `document_crypto`,
   `metadata_keys` and `mail_in_secrets` row is under the next key. You can
   stop it (Ctrl-C, a crash, a host reboot) and run it again; it carries on
   from where it was. Every row it has not reached is still readable under
   the current key, and every row it has moved is readable under the next
   one. Each batch is one transaction, so a row is never left half-moved. It
   records one `document_kek_rotation_completed` audit entry when it finishes.
4. **The point of no return.** Only once the worker reports completion, make
   the next key the current one and drop the overlay:
   ```sh
   mv .orbit-secrets/document-kek-next .orbit-secrets/document-kek
   bash scripts/deploy-container.sh --pull
   ```
   Treat this step as a confirmation. Everything before it can be undone.
   This move overwrites the outgoing key, and after it that key is gone: no
   row is under it any more, nothing needs it, and it cannot be used to read
   anything ever again. That is deliberate. A rotation you are running because
   a key may have leaked has not achieved much if the leaked key is still
   sitting in `.orbit-secrets/` beside its replacement.

   Orbit works out `DOCUMENT_KEK`'s id from the key bytes themselves, so this
   restart always finds every row already on the key it just loaded as
   current; nothing needs to know the id in advance. Dropping the overlay (by
   deploying with just `docker-compose.yml` again) removes
   `DOCUMENT_KEK_NEXT`; with the rewrap complete, no row depended on it.

### If you are rotating because a key may have leaked

The exposed key stays live, and stays able to read everything, until step 4.
The exposure ends there, not at step 1. So run the steps together rather than
leaving a rotation part-done overnight.

Rotation also does not un-read anything already copied. It stops the exposed
key being useful against this instance from step 4 onward; it does not undo a
copy someone took before you started.

### Undoing a rotation, before step 4 only

Going back is not a rollback, because there is nothing to roll back. It is a
rotation in the other direction, from the new key to the original one, and it
is only possible while both keys are still loaded. After step 4 the original
key no longer exists, so there is no way back and you should not plan for one.

To undo, swap which key is which and run the same steps again:

```sh
mv .orbit-secrets/document-kek       .orbit-secrets/document-kek-abandoning
mv .orbit-secrets/document-kek-next  .orbit-secrets/document-kek
mv .orbit-secrets/document-kek-abandoning .orbit-secrets/document-kek-next
```

Then repeat steps 2, 3 and 4. Nothing is unreadable at any point: the instance
holds the same two keys throughout, and every row reads under whichever of
them protects it. Step 4 finishes by overwriting the abandoned key, which is
what you want. A spare key left lying in `.orbit-secrets/` is one a later
rotation can pick up by mistake, and this instance has already written rows
under it.

If you copied that key anywhere else (a password manager, a note, a backup of
the secrets directory) delete it there too. Removing the file on this host is
not the same as the key being gone.

Recovery-bundle import and repair's `document-kek` regeneration are still
wholesale key *replacements*, not rotations. Neither keeps the old key for a
rewrap, so they leave existing documents, encrypted metadata and the mailbox
password unreadable under the new key (see the end of "Disable, restart, and
credential rotation" above).

## Recovering from a failed database credential rotation

`bash scripts/repair.sh --execute --dangerous` rotates the `postgres-password`
credential when diagnosis finds it broken (a mismatch, or missing alongside a
retained database volume). Before touching the database it writes a
**checkpoint**: the current password, encrypted with a passphrase you choose,
to a file named on stderr (`Orbit repair: pre-rotation checkpoint created and
verified at <path>/postgres-password.orbkek`). repair.sh decrypts it straight
back and compares it byte-for-byte against the live password before going any
further — the same "locked, not damaged" guarantee as `document-kek`: nothing
is touched until there is a proven-good way back.

If one of the rotation's own later steps then fails — writing the new
credential to the database, landing the new secret file, or restarting the
containers to pick it up — repair.sh stops and names which checkpoint file
holds the password the database still actually has. Three different situations
reach this message, and the recovery is not the same for each; the stderr text
tells you which one you are in:

- **The database already has the new password, but the secret file was not
  updated** (the rotation step succeeded and the next step, landing the new
  secret file, failed). stderr also says `a newly rotated credential is
  already staged at <path>` and names the file. Do not restore the checkpoint:
  the database no longer accepts the old password. Move the staged file into
  place as `.orbit-secrets/postgres-password`, restart the containers, and run
  the diagnosis again. Only if the database refuses the staged value too does
  the checkpoint path below apply.

- **The database was never changed** (the rotation step itself failed,
  before anything new was written). Decrypt the checkpoint and put the
  original password back where it was:
  ```sh
  printf '%s' 'your checkpoint passphrase' |
    docker compose --project-name <your-project> --env-file .env-orbit \
      run --rm --no-deps -T \
      --volume "$PWD/<checkpoint-dir>/postgres-password.orbkek:/recovery/postgres-password.enc:ro" \
      --entrypoint node orbit-app \
      /opt/orbit/scripts/recovery-crypto.mjs decrypt /recovery/postgres-password.enc
  ```
  This prints the original password on stdout (nothing is written for you —
  the passphrase and the printed value are both sensitive). Confirm it still
  matches `.orbit-secrets/postgres-password`, then re-run diagnosis.

- **Only the final restart failed, after the rotation fully landed** — the
  database already has the new password and `.orbit-secrets/postgres-password`
  already holds it; only the containers haven't restarted to pick it up. Do
  **not** decrypt and restore the checkpoint here: it holds the OLD password,
  which no longer matches the database and would reintroduce the exact
  mismatch the rotation was fixing. Instead restart the deployment yourself:
  ```sh
  bash scripts/deploy-container.sh --pull
  ```
  then re-run diagnosis to confirm it is healthy. repair.sh's own stderr
  output says which of these two states you are in; it never leaves you to
  guess.

The checkpoint file is never deleted automatically — delete it yourself, by
hand, once you have confirmed the rotation succeeded (or that you have
recovered the original password from it). Keep the passphrase only until then;
Orbit never stores it.

## Hostile document processor operation

The default stack leaves `TIKA_URL` empty and does not start the `processing`
profile. Documents can still be uploaded and reviewed; you just get no
suggestions read out of the file.

To turn on the pinned processor, set `TIKA_URL=http://orbit-tika:9998`, check
the resolved Compose configuration, and start the profile:

```sh
docker compose --env-file .env-orbit --profile processing config --quiet
docker compose --env-file .env-orbit --profile processing up -d orbit-tika orbit-app
```

Do not add host ports, application secrets, document volumes, membership of
the default network, arbitrary Tika headers or caller-chosen endpoints. The
supplied configuration runs Tika as a non-root user with a read-only
filesystem, turns off OCR (reading text out of images) and the unpacking of
files embedded in other files, and keeps it on the processing network, which
has no route to the internet. ClamAV uses that network for bounded scan
streams and a separate network only for signature updates; it does not share
PostgreSQL's default network.

To turn extraction off safely, clear `TIKA_URL`, recreate `orbit-app`, and
stop the optional processor. Originals already scanned clean stay available
and the review flow falls back to filling the fields by hand:

```sh
docker compose --env-file .env-orbit up -d orbit-app
docker compose --env-file .env-orbit --profile processing stop orbit-tika
```

## Private model server and its model pull

The default stack does not start the `ai` profile. If you leave it off you
get no model server, no pull helper, and no change of any kind.

With the profile on, the model server runs on the same no-internet network as
the document parser, and its port is not published to the host. This is
deliberate and built in: the container that would hold document text has no
route to the internet, so it cannot become a way out for household documents,
whatever image or model is loaded into it. The address Orbit uses for it is
fixed in the application code, so there is no base URL, proxy setting or API
key to configure, and so no setting that could point extraction at a hosted
service. Do not give this service the default network, a second network or a
published port; the Compose validation refuses the configuration if you do.

### Pulling a model

Because the server has no route out, it cannot download a model. Getting one
in is a separate step that you run by name; it never happens as a side effect
of starting the stack. Set the model reference in `.env-orbit` first. A
reference pinned by digest is recommended, so that a later pull fetches the
model that was actually evaluated rather than whatever the name points at
that day:

```sh
# .env-orbit
OLLAMA_MODEL=<model>@sha256:<digest>
```

Then check the resolved configuration and run the pull. It downloads into the
`orbit-ollama-data` volume and exits:

```sh
docker compose --env-file .env-orbit --profile ai-model-pull config --quiet
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm orbit-ollama-model-pull
```

Start the server once the pull has reported success:

```sh
docker compose --env-file .env-orbit --profile ai up -d orbit-ollama
```

Run the pull again whenever the model reference changes. The pull helper is
the only part of this stack that reaches the internet for model data. It runs
only for as long as your command runs, and it never receives document text.

### Hosts with no direct internet access

The pull helper needs outbound access to the model registry, so on an isolated
host it cannot fetch anything. Two options, in order of preference:

1. Allow the host outbound access, or point the Docker daemon at an HTTP proxy,
   for the length of the pull only, then take it away again. The model server
   is unaffected either way: the access belongs to the host and to the one-off
   pull container, never to the service Orbit talks to.
2. Carry the model in from a machine that does have access. Run the pull there
   against the same compose file, export the model volume, and import it on
   the isolated host. Only model data moves; no household data is involved.

```sh
# on the connected machine, after the pull above has succeeded
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm --entrypoint /bin/sh -v "$PWD:/export" orbit-ollama-model-pull \
  -c 'tar -C /root/.ollama -czf /export/orbit-model.tar.gz .'

# on the isolated host, with the ai profile stopped
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm --entrypoint /bin/sh -v "$PWD:/import" orbit-ollama-model-pull \
  -c 'tar -C /root/.ollama -xzf /import/orbit-model.tar.gz'
```

Move the archive between the two machines by whatever means your site already
trusts. Then confirm the server can see the model:

```sh
docker compose --env-file .env-orbit --profile ai up -d orbit-ollama
docker compose --env-file .env-orbit --profile ai exec orbit-ollama ollama list
```

To stop using the model server, stop the profile. Nothing else changes:

```sh
docker compose --env-file .env-orbit --profile ai stop orbit-ollama
```

## Audit history

Instance-wide actions may have no household, so `audit_log.household_id` may
be empty. The administrator history is read a page at a time, from newest to
oldest, and selects only safe columns. Each page continues from the exact
`(created_at, id)` position of the last entry on the previous one, so events
with the same timestamp are neither shown twice nor skipped, and the
administrator screen adds older entries to what is already shown rather than
replacing the page. Raw `changes` are available only to trusted internal
code. After a household is purged, its retained events keep only the safe
actor, household and action labels; deleted private names and raw changes
are never shown. An action code Orbit does not yet know gets a generic label
rather than exposing the raw payload.
