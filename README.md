> [!IMPORTANT]
> **Development disclosure:** Orbit was coded by OpenAI Codex under human
> direction.

<p align="center">
  <img src="public/orbit-mark.svg" alt="Orbit logo" width="132" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>Everything in your orbit, on track.</strong>
</p>

<p align="center">
  A modern, self-hosted home operations hub for maintenance, renewals,<br />
  recurring services, contracts, cover, and the people who share them.
</p>

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-15162b?style=flat-square&logo=nextdotjs&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-715cff?style=flat-square&logo=react&logoColor=white" />
  <img alt="PostgreSQL 17" src="https://img.shields.io/badge/PostgreSQL-17-22b8a9?style=flat-square&logo=postgresql&logoColor=white" />
  <img alt="Docker ready" src="https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-ff4fa3?style=flat-square&logo=typescript&logoColor=white" />
</p>

<p align="center">
  <img src="public/og.png" alt="Orbit — Everything in your orbit, on track" width="100%" />
</p>

## Quick start

From an empty directory on a Linux host with Git and Docker Compose v2:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/install.sh)
```

The installer downloads Orbit into the current directory, creates the
Orbit-specific `.env-orbit` configuration when needed, generates independent
256-bit session, PostgreSQL, and document-encryption secrets, and asks whether to build the
application container locally:

- answer **Y/Yes** (or press Enter) to pull current base images and build
  the `orbit-app` service from source;
- answer **N/No** to pull `ghcr.io/tomlawesome/orbit:latest` from GitHub
  Container Registry instead.

It then starts the `orbit` application container, the official
`orbit-postgres` PostgreSQL container, and the isolated official ClamAV scanner
in the background and displays their status. Development and routine preview
images target 64-bit x86 (`linux/amd64`) for faster iteration. ARM64 is added
only after a dedicated exact-image validation path is enabled for that
architecture.

The generated secrets live under `.orbit-secrets`, which is accessible only to
the installing host user. Compose mounts only the required files into each
container under `/run/secrets`; the values are not injected into container
environment variables. Existing secrets are preserved on subsequent runs, and
the installer never reads or modifies a generic `.env` file.

## Your home has an orbit

Boilers need servicing. Insurance renews. Cars need inspections. Devices leave
warranty. Contracts roll over. Orbit brings those scattered responsibilities
into one calm, shared view—so the important things stay visible before they
become urgent.

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>See what is next</h3>
      <p>A focused, urgency-aware workspace brings upcoming work, overdue items, and recently completed tasks into view.</p>
    </td>
    <td width="33%" valign="top">
      <h3>Keep the rhythm</h3>
      <p>Complete, renew, reschedule, snooze, cancel, restore, and automatically calculate the next recurring date.</p>
    </td>
    <td width="33%" valign="top">
      <h3>Share the load</h3>
      <p>Household owners can add existing Orbit users by display name—without invitations or exposed email addresses.</p>
    </td>
  </tr>
</table>

## Designed around your household

- **A workspace that reads at a glance** — responsive Due Next view, search,
  urgency filters, household switching, section views, and mobile navigation.
- **Sections that fit your life** — add, rename, reorder, recolour, hide, or
  restore sections, with Home, Vehicles, Devices, and Services included by
  default.
- **Appearance with personality** — independent light, dark, and system modes
  across Orbit After Dark, Verdant, Coast, Berry, and Ember colourways, three
  in-app text sizes, and traditional or theme-matched due-date heat maps.
- **A complete record of care** — item details, schedule history, activity
  timelines, archived records, reminders, notification state, and encrypted
  supporting documents.
- **Useful even when disconnected** — an installable PWA with IndexedDB
  snapshots, queued offline changes, explicit sync state, an offline shell, and
  service-worker push handling.
- **Private by design** — provider-neutral OIDC, opaque server-side sessions,
  PKCE, signed token validation, same-origin enforcement, CSRF protection, and
  authenticated household APIs.

## One app. Standard supporting services.

Orbit deliberately keeps the operational footprint small:

```mermaid
flowchart LR
    browser["Browser or installed PWA"]
    orbit["orbit application container"]
    postgres[("orbit-postgres")]
    documents[("encrypted document volume")]
    scanner["official ClamAV scanner"]
    identity["OIDC identity provider"]
    delivery["SMTP and Web Push providers"]

    browser <-->|HTTPS| orbit
    orbit <-->|PostgreSQL| postgres
    orbit -->|ciphertext only| documents
    orbit -->|quarantined stream| scanner
    orbit <-->|OpenID Connect| identity
    orbit -->|Notifications| delivery
```

- `orbit` is the complete Orbit application: interface, authenticated
  APIs, versioned migrations, and notification scheduler. It can be built from
  source or pulled as `ghcr.io/tomlawesome/orbit:latest`.
- `orbit-postgres` is the unmodified official `postgres:17-alpine` image with a
  persistent volume.
- `orbit-clamav` is the official scanner image. It receives only quarantined
  file streams over the private Compose network and has no published host port,
  database credentials, document volume, or Orbit secrets.

There is no custom PostgreSQL image and no separate Orbit frontend/backend pair
to maintain. ClamAV is enabled by default and normally needs approximately
4 GiB of memory; administrators can explicitly disable it, but Orbit displays a
persistent warning and marks subsequently uploaded files as unscanned.

## Run with Docker

### 1. Create the runtime configuration

```sh
bash scripts/configure.sh
```

This creates `.env-orbit` plus the private `.orbit-secrets` directory without
starting containers. It also runs the selected Orbit image once, with only a
key-generation command, to generate and persist Orbit's VAPID Web Push key
pair on first setup: the private key stays in `.orbit-secrets` and only the
public key is written to `.env-orbit`. Configure your OIDC provider in
`.env-orbit`. SMTP is required when you are ready to exercise email delivery.

### 2. Start Orbit

```sh
docker compose --env-file .env-orbit up --build
```

Open `http://<docker-host-ip>:3000` from another device, or
[http://127.0.0.1:3000](http://127.0.0.1:3000) on the Docker host. The health
endpoint is available at `/api/health`.

Orbit listens on all host interfaces by default. Set
`ORBIT_BIND_ADDRESS=127.0.0.1` in `.env-orbit` when access should be restricted
to the Docker host or an HTTPS reverse proxy. Do not expose port `3000` directly
to the public internet.

The application waits for PostgreSQL, applies versioned migrations, starts the
notification scheduler, and then serves the full-stack application.

### Optional local processing stack

The standard stack includes private ClamAV scanning. Tika OCR/text extraction
and Ollama are deliberately separate because they increase host memory and are
never needed for normal operation. To start both optional services, add this to
`.env-orbit` before starting them:

```sh
TIKA_URL=http://orbit-tika:9998
# Choose a local model only after checking its size, licence and host capacity.
OLLAMA_MODEL=<a-local-model-name>
```

Then launch the full local stack:

```sh
docker compose --env-file .env-orbit \
  -f docker-compose.yml -f docker-compose.full.yml \
  --profile processing --profile ai up -d
```

The services have no published host ports. Tika is attached only to a dedicated
internal processing network shared with Orbit, so it has no route to the
database, sibling services on the default network, or external networks.
Ollama remains reachable only on the private default Compose network. Its
volume is persistent, local-only, uses no cloud models, and is bounded to 2
CPUs and 6 GiB by default. It does not download a model automatically. After
the server reports healthy, pull the model selected above explicitly:

```sh
docker compose --env-file .env-orbit \
  -f docker-compose.yml -f docker-compose.full.yml \
  exec orbit-ollama sh -ec 'test -n "$ORBIT_OLLAMA_MODEL"; ollama pull "$ORBIT_OLLAMA_MODEL"'
```

This prepares the optional infrastructure only. Current Orbit releases use
Tika for bounded review evidence; they do not send document text to Ollama or
permit it to create or update household data. Stop and remove the optional
containers with the same Compose arguments followed by `down`; omit `--volumes`
to retain downloaded models.

> [!IMPORTANT]
> Keep `APP_URL`, the address used in the browser, and the OIDC callback host
> identical. Do not switch between `localhost` and `127.0.0.1` during a sign-in
> attempt.

Orbit never exposes a household workspace to an unauthenticated visitor. After
the first successful registration, that user becomes the initial instance
administrator and completes a guided setup for the household name, timezone,
currency, and sections. The wizard offers Home, Vehicles, Devices, and Services
as sensible defaults or accepts a fully custom section list.

Instance administrators can manage every household and grant or remove
administrator access for other registered users. Orbit prevents removal of the
last administrator.

### Update and launch an existing checkout

Once the host has a configured `.env-orbit`, update and start Orbit with:

```sh
./scripts/update-and-start.sh
```

The script fast-forwards the current Git branch, pulls the official PostgreSQL
image, refreshes the application build layers, rebuilds the `orbit-app`
service, starts the stack in the background, and prints the resulting service
status. It stops immediately if Git, Docker Compose v2, or `.env-orbit` is
unavailable.

## Production foundation

Orbit already includes:

- a clean first-run wizard, instance administrators, and owner-controlled
  household membership;
- create, edit, schedule, remind, archive, undo, and restore workflows;
- recurrence suggestions and household-local calendar-date rules;
- a schedule-aware notification centre with read, dismiss, and snooze state;
- per-user email and browser-push delivery preferences;
- atomic, audited household ownership transfer;
- PostgreSQL/Drizzle models for users, sessions, households, memberships,
  items, events, reminders, push devices, delivery state, and audit history;
- provider-neutral OpenID Connect discovery and Authorization Code flow with
  S256 PKCE;
- just-in-time user provisioning and immutable issuer/subject identities;
- SMTP and Web Push delivery through an atomic PostgreSQL-backed scheduler;
- an authentication gate that reveals no workspace or cached household data to
  signed-out visitors;
- production health checks, standalone Next.js output, a purpose-built browser
  favicon, and version-controlled migrations.
- bounded PDF/JPEG/PNG uploads, ClamAV malware rejection, per-document
  AES-256-GCM envelope encryption, quotas, audited downloads, soft deletion,
  retention purge, and storage reconciliation.

For authenticated users, Orbit retains a user-scoped IndexedDB snapshot and
synchronises user-scoped queued offline changes. Production images contain no
sample household items or seeded fake records.

## Local development

### Requirements

- Node.js 22 or later
- pnpm 11
- PostgreSQL 17, or Docker for the database only

### Start the development stack

```sh
pnpm install
bash scripts/configure.sh
pnpm db:migrate
pnpm dev
```

To run only PostgreSQL in Docker:

```sh
docker compose --env-file .env-orbit up -d orbit-db
```

The default host and database settings in `.env-orbit.example` use the same
generated PostgreSQL password file as the container.

### Quality checks

```sh
bash scripts/test-backend.sh
pnpm test:coverage
bash scripts/test-frontend.sh
bash scripts/test-all.sh
```

The frontend script targets `http://127.0.0.1:3000` by default; set
`PLAYWRIGHT_BASE_URL` to test another non-production deployment. Use
`ORBIT_SKIP_E2E=true bash scripts/test-all.sh` for the fast static and unit
suite when no browser target is running.

The authenticated acceptance checks use a separate Compose overlay with a
disposable local OIDC provider. It performs discovery, PKCE, code exchange and
signed ID-token validation; it does not add an Orbit sign-in bypass. Run it only
against disposable data:

```sh
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.acceptance.yml up --build --wait
ORBIT_ACCEPTANCE_OIDC=true bash scripts/test-frontend.sh
docker compose --env-file .env-orbit -f docker-compose.yml -f docker-compose.acceptance.yml down --volumes --remove-orphans
```

Install Playwright's local Chromium build once, then repeat browser tests
without using an AI service:

```sh
bash scripts/install-test-browser.sh
bash scripts/test-frontend.sh
```

The current measured suite and its known gaps are recorded in the
[engineering baseline](docs/engineering-baseline.md). Playwright verifies
signed-out privacy in desktop and mobile Chromium and uses the disposable OIDC
profile for authenticated household-lifecycle acceptance. Coverage is
diagnostic while the database/API integration baseline is established; it is
not an arbitrary release percentage.

The [v1 charter](docs/v1-charter.md) defines the supported release,
[architecture and ADRs](docs/architecture.md) record durable system decisions,
and the [quality strategy](docs/quality-strategy.md) defines test and CI
evidence. GitHub milestones and issues own delivery status. Product directions
outside the stable contract remain in the
[feature register](docs/feature-register.md).

## Configuration

All supported runtime variables are documented in
[`.env-orbit.example`](.env-orbit.example). Sensitive settings accept either
their direct variable or the corresponding `_FILE` variable. Do not configure
both forms for the same setting.

Examples below demonstrate the expected shape. Generate real secrets; do not
copy placeholder secret values into a public deployment.

The installer creates and mounts the PostgreSQL password and Orbit session
secret files. If you choose another `_FILE` setting, create that file yourself
and add a matching read-only secret mount to the Compose service.

| Variable | Used by | Purpose | Example value |
| --- | --- | --- | --- |
| `APP_URL` | Orbit | Canonical browser origin used for cookies and request validation. Use HTTPS except on loopback. | `https://orbit.example.com` |
| `ORBIT_BIND_ADDRESS` | Compose | Host interface that publishes Orbit. Use loopback when a reverse proxy is on the same host. | `0.0.0.0` |
| `ORBIT_PORT` | Compose | Host TCP port mapped to container port 3000. | `3000` |
| `SESSION_SECRET` | Orbit | Direct session-signing secret. Leave empty when `SESSION_SECRET_FILE` is set. | `<64-character-random-hex>` |
| `SESSION_SECRET_FILE` | Orbit | File containing the session-signing secret. The Compose stack overrides this to `/run/secrets/...`. | `.orbit-secrets/session-secret` |
| `SESSION_TTL_SECONDS` | Orbit | Login-session lifetime in seconds. | `604800` |
| `DOCUMENTS_ROOT` | Orbit | Durable encrypted-document root inside the container. | `/var/lib/orbit/documents` |
| `DOCUMENTS_QUARANTINE_ROOT` | Orbit | Ephemeral plaintext quarantine; Compose supplies a private `tmpfs`. | `/tmp/orbit-document-quarantine` |
| `DOCUMENT_KEK` | Orbit | Direct 32-byte hexadecimal document key-encryption key. Leave empty when the file form is used. | `<64-character-random-hex>` |
| `DOCUMENT_KEK_FILE` | Orbit | File containing the document key-encryption key. Compose mounts the generated file under `/run/secrets`. | `.orbit-secrets/document-kek` |
| `DOCUMENT_MAX_BYTES` | Orbit | Maximum bytes accepted for one document. | `26214400` |
| `DOCUMENT_HOUSEHOLD_QUOTA_BYTES` | Orbit | Maximum retained document bytes for one household. | `5368709120` |
| `DOCUMENT_INSTANCE_QUOTA_BYTES` | Orbit | Maximum retained document bytes for the instance. | `21474836480` |
| `DOCUMENT_RETENTION_DAYS` | Orbit | Soft-delete interval before irreversible document purge. | `30` |
| `DOCUMENT_SCAN_MODE` | Orbit | `required` fails closed when ClamAV is unavailable; `disabled` is an explicit warned bypass. | `required` |
| `CLAMAV_HOST` | Orbit | Private Compose hostname of the ClamAV daemon. | `orbit-clamav` |
| `CLAMAV_PORT` | Orbit | Private ClamAV daemon port; do not publish it on the host. | `3310` |
| `CLAMAV_TIMEOUT_MS` | Orbit | Maximum malware-scan duration per upload. | `30000` |
| `CLAMAV_MEMORY_LIMIT` | Compose | Memory limit assigned to the scanner container. | `4g` |
| `DATABASE_URL` | Orbit | Complete PostgreSQL connection URL. Leave empty when using the individual PostgreSQL settings. | `postgres://orbit:example-password@postgres:5432/orbit` |
| `DATABASE_URL_FILE` | Orbit | File containing a complete database URL instead of `DATABASE_URL`. | `/run/secrets/orbit-database-url` |
| `POSTGRES_HOST` | Orbit | PostgreSQL hostname. Compose overrides the host-local default with the database service name. | `localhost` |
| `POSTGRES_PORT` | Orbit | PostgreSQL TCP port. | `5432` |
| `POSTGRES_DB` | Orbit and PostgreSQL | Database created and used by Orbit. | `orbit` |
| `POSTGRES_USER` | Orbit and PostgreSQL | PostgreSQL role created and used by Orbit. | `orbit` |
| `POSTGRES_PASSWORD` | Orbit and PostgreSQL | Direct database password. Leave empty when the password file is used. | `<generated-random-password>` |
| `POSTGRES_PASSWORD_FILE` | Orbit and PostgreSQL | File containing the generated PostgreSQL password. | `.orbit-secrets/postgres-password` |
| `OIDC_ISSUER` | Orbit | HTTPS issuer/discovery URL for the OpenID Connect provider. | `https://auth.example.com/application/o/orbit/` |
| `OIDC_CLIENT_ID` | Orbit | Client identifier registered with the identity provider. | `orbit` |
| `OIDC_CLIENT_SECRET` | Orbit | Direct OIDC client secret. Leave empty when the file form is used. | `<provider-generated-secret>` |
| `OIDC_CLIENT_SECRET_FILE` | Orbit | File containing the OIDC client secret. | `/run/secrets/orbit-oidc-client-secret` |
| `OIDC_CALLBACK_URL` | Orbit | Exact callback URI registered with the identity provider. | `https://orbit.example.com/api/auth/callback` |
| `OIDC_SCOPES` | Orbit | Space-separated scopes requested during sign-in; must contain `openid`. | `openid profile email` |
| `OIDC_EMAIL_CLAIM` | Orbit | ID-token claim containing the user email address. | `email` |
| `OIDC_EMAIL_VERIFIED_CLAIM` | Orbit | ID-token claim indicating whether the email is verified. | `email_verified` |
| `OIDC_NAME_CLAIM` | Orbit | ID-token claim used as the registered user’s display name. | `name` |
| `OIDC_AVATAR_CLAIM` | Orbit | Optional ID-token claim containing the avatar URL. | `picture` |
| `SMTP_HOST` / `SMTP_PORT` | Worker | SMTP server host and port. | `smtp.example.com` / `587` |
| `SMTP_SECURITY` | Worker | `starttls` (port 587) or `implicit_tls` (port 465); plaintext SMTP is unsupported. | `starttls` |
| `SMTP_USER` / `SMTP_PASSWORD_FILE` | Worker | SMTP login and a file containing its password. | `orbit@example.com` / `/run/secrets/orbit-smtp-password` |
| `SMTP_URL` | Worker | Deprecated compatibility form; do not set it with the individual SMTP settings. | `smtps://orbit%40example.com:password@smtp.example.com:465` |
| `SMTP_FROM` | Worker | Display name and sender address for reminder email. | `Orbit <orbit@example.com>` |
| `IMAP_ALIAS_CURRENT_GENERATION` | Orbit | Positive current HMAC alias generation. | `2` |
| `IMAP_ALIAS_CURRENT_SECRET_FILE` | Orbit | Runtime secret file for the current alias key; use a distinct file from the previous key. | `/run/secrets/orbit-imap-alias-current` |
| `IMAP_ALIAS_PREVIOUS_GENERATION` | Orbit | Optional previous HMAC alias generation during an explicit bounded rotation. | `1` |
| `IMAP_ALIAS_PREVIOUS_SECRET_FILE` | Orbit | Runtime secret file for the previous alias key. | `/run/secrets/orbit-imap-alias-previous` |
| `IMAP_ALIAS_PREVIOUS_EXPIRES_AT` | Orbit | Explicit UTC expiry for the previous generation; omit all previous-generation settings for emergency invalidation. | `2026-08-15T00:00:00.000Z` |
| `VAPID_SUBJECT` | Worker | Contact URI included in Web Push VAPID claims. VAPID enables browser/PWA native notifications; it is not Pushover. | `mailto:admin@example.com` |
| `VAPID_PUBLIC_KEY` | Browser and worker | Public VAPID key generated for this deployment. | `<base64url-public-key>` |
| `VAPID_PRIVATE_KEY` | Worker | Direct private VAPID key. Leave empty when the file form is used. | `<base64url-private-key>` |
| `VAPID_PRIVATE_KEY_FILE` | Worker | File containing the private VAPID key. | `/run/secrets/orbit-vapid-private-key` |
| `WORKER_POLL_SECONDS` | Worker | Interval between notification queue scans. | `60` |
| `NOTIFICATION_MAX_ATTEMPTS` | Worker | Delivery attempts before a notification is marked failed. | `5` |
| `MIGRATE_ON_START` | Orbit | Applies pending Drizzle migrations during application startup. Compose sets this to `true`. | `false` |
| `WORKER_ENABLED` | Orbit | Runs the notification scheduler inside the application container. Compose sets this to `true`. | `false` |
| `DRIZZLE_MIGRATIONS_PATH` | Orbit | Directory containing versioned SQL migrations. | `drizzle` |
| `ORBIT_SECRETS_DIR` | Compose | Host directory containing files mounted as Compose secrets. | `./.orbit-secrets` |

### IMAP alias rotation

For a key rotation within the same recipient domain, increment the generation,
deploy the new key as current and the exact old current tuple as previous, and
set an explicit UTC expiry no more than 90 days away. Replicas with stale or
mismatched generation, key, domain, or trusted-header configuration fail
closed. At expiry, current ingestion continues and the previous tuple is
retired; omit all previous settings for immediate emergency invalidation. A
recipient-domain change cannot preserve old-domain aliases in v1: use a new
generation/current-only deployment, which invalidates the old domain at once.

For production, use HTTPS, file-backed secrets, a private PostgreSQL connection,
and valid OIDC, SMTP, and VAPID credentials. Keep recovery bundles outside the
Docker host before storing real household data.

Create a validated ordinary backup containing the PostgreSQL database and an
encrypted document-volume archive:

```sh
bash scripts/backup.sh
```

The ordinary backup deliberately excludes the document key and is useful only
with the matching local key. Restore it transactionally while Orbit is stopped:

```sh
bash scripts/restore.sh backups/orbit-YYYYMMDD-HHMMSS.tar
```

Create a separately stored, passphrase-protected recovery bundle when the
backup must remain recoverable after loss of the host:

```sh
bash scripts/export-recovery-bundle.sh backups/orbit-YYYYMMDD-HHMMSS.tar
bash scripts/import-recovery-bundle.sh backups/orbit-recovery-YYYYMMDD-HHMMSS.tar
```

The recovery-key envelope uses authenticated AES-256-GCM with scrypt. Neither
the document key nor recovery passphrase is printed, placed in an environment
variable, or passed as a process argument.

Build or deploy the Compose application through the same guarded scripts used
by CI:

```sh
bash scripts/build-container.sh
bash scripts/deploy-container.sh --pull
# Or build locally before deployment:
bash scripts/deploy-container.sh --build
```

See [Authentication and Authentik setup](docs/authentication.md) for provider
configuration, endpoint behaviour, security details, and troubleshooting.
See [Previews, release candidates and stable promotion](docs/releasing.md) for
the protected branch, test, manual-validation, and digest-promotion workflow.

## Before the first real launch

1. Apply the migrations to a disposable PostgreSQL instance and exercise OIDC
   sign-in with the intended provider.
2. Verify one SMTP delivery and one browser-push delivery with production-like
   credentials.
3. Run the browser and accessibility checks against the production build.
4. Schedule `scripts/backup.sh`, retain copies outside the Docker host, and
   perform a test restore.

---

<p align="center">
  <img src="public/orbit-mark.svg" alt="" width="52" />
  <br />
  <strong>Everything in your orbit, on track.</strong>
</p>
