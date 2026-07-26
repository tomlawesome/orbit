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
256-bit session and PostgreSQL secrets, and asks whether to build the
application container locally:

- answer **Y/Yes** (or press Enter) to pull current base images and build
  the `orbit-app` service from source;
- answer **N/No** to pull `ghcr.io/tomlawesome/orbit:latest` from GitHub
  Container Registry instead.

It then starts the `orbit` application container and the official
`orbit-postgres` PostgreSQL container in the background and displays their
status. Development images target 64-bit x86 (`linux/amd64`) for faster
iteration. Versioned releases support both `linux/amd64` and `linux/arm64`;
ARM64 images can also be published with the manual workflow when required.

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
  timelines, archived records, reminders, and notification state.
- **Useful even when disconnected** — an installable PWA with IndexedDB
  snapshots, queued offline changes, explicit sync state, an offline shell, and
  service-worker push handling.
- **Private by design** — provider-neutral OIDC, opaque server-side sessions,
  PKCE, signed token validation, same-origin enforcement, CSRF protection, and
  authenticated household APIs.

## One app. One standard database.

Orbit deliberately keeps the operational footprint small:

```mermaid
flowchart LR
    browser["Browser or installed PWA"]
    orbit["orbit application container"]
    postgres[("orbit-postgres")]
    identity["OIDC identity provider"]
    delivery["SMTP and Web Push providers"]

    browser <-->|HTTPS| orbit
    orbit <-->|PostgreSQL| postgres
    orbit <-->|OpenID Connect| identity
    orbit -->|Notifications| delivery
```

- `orbit` is the complete Orbit application: interface, authenticated
  APIs, versioned migrations, and notification scheduler. It can be built from
  source or pulled as `ghcr.io/tomlawesome/orbit:latest`.
- `orbit-postgres` is the unmodified official `postgres:17-alpine` image with a
  persistent volume.

There is no custom PostgreSQL image and no separate backend container to
maintain.

## Run with Docker

### 1. Create the runtime configuration

```sh
bash scripts/configure.sh
```

This creates `.env-orbit` plus the private `.orbit-secrets` directory without
starting containers. Configure your OIDC provider in `.env-orbit`. SMTP and
VAPID values are required when you are ready to exercise email and browser-push
delivery.

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

For authenticated users, Orbit retains a user-scoped IndexedDB snapshot and
synchronises user-scoped queued offline changes. Production images contain no
sample household items or seeded fake records.

## Local development

### Requirements

- Node.js 22 or later
- pnpm 10
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
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The current suite contains 46 unit tests across authentication, environment
and secret validation, database configuration, recurrence, preferences,
notifications, workspace commands, and the notification worker.

Product directions intentionally deferred until after the initial completion
pass are recorded in the [feature register](docs/feature-register.md).

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
| `SMTP_URL` | Worker | SMTP or SMTPS connection URL for email reminders. Leave empty when using `SMTP_URL_FILE`. | `smtps://orbit%40example.com:password@smtp.example.com:465` |
| `SMTP_URL_FILE` | Worker | File containing the SMTP connection URL. | `/run/secrets/orbit-smtp-url` |
| `SMTP_FROM` | Worker | Display name and sender address for reminder email. | `Orbit <orbit@example.com>` |
| `VAPID_SUBJECT` | Worker | Contact URI included in Web Push VAPID claims. | `mailto:admin@example.com` |
| `VAPID_PUBLIC_KEY` | Browser and worker | Public VAPID key generated for this deployment. | `<base64url-public-key>` |
| `VAPID_PRIVATE_KEY` | Worker | Direct private VAPID key. Leave empty when the file form is used. | `<base64url-private-key>` |
| `VAPID_PRIVATE_KEY_FILE` | Worker | File containing the private VAPID key. | `/run/secrets/orbit-vapid-private-key` |
| `WORKER_POLL_SECONDS` | Worker | Interval between notification queue scans. | `60` |
| `NOTIFICATION_MAX_ATTEMPTS` | Worker | Delivery attempts before a notification is marked failed. | `5` |
| `MIGRATE_ON_START` | Orbit | Applies pending Drizzle migrations during application startup. Compose sets this to `true`. | `false` |
| `WORKER_ENABLED` | Orbit | Runs the notification scheduler inside the application container. Compose sets this to `true`. | `false` |
| `DRIZZLE_MIGRATIONS_PATH` | Orbit | Directory containing versioned SQL migrations. | `drizzle` |
| `ORBIT_SECRETS_DIR` | Compose | Host directory containing files mounted as Compose secrets. | `./.orbit-secrets` |

For production, use HTTPS, file-backed secrets, a private PostgreSQL connection,
and valid OIDC, SMTP, and VAPID credentials. Back up the PostgreSQL volume and
the `.orbit-secrets` directory before storing real household data.

See [Authentication and Authentik setup](docs/authentication.md) for provider
configuration, endpoint behaviour, security details, and troubleshooting.

## Before the first real launch

1. Apply the migrations to a disposable PostgreSQL instance and exercise OIDC
   sign-in with the intended provider.
2. Verify one SMTP delivery and one browser-push delivery with production-like
   credentials.
3. Run browser end-to-end and accessibility checks against the production
   build.
4. Configure automated PostgreSQL backups and a tested restore procedure.

---

<p align="center">
  <img src="public/orbit-mark.svg" alt="" width="52" />
  <br />
  <strong>Everything in your orbit, on track.</strong>
</p>
