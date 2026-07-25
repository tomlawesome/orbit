# Orbit

**Everything in your orbit, on track.**

Orbit is a fast, self-hostable household-management PWA for keeping maintenance, recurring services, renewals, contracts, and household cover in order.

The current implementation establishes the production foundation and first user-facing vertical slice:

- responsive Due Next workspace with household switching, section views, search and urgency filters, mobile navigation, dark mode, and accessible controls;
- guided household setup plus create, edit, schedule, remind, archive, and undo workflows for household records;
- item detail and activity history with renewal/service completion, recurring next-date calculation, rescheduling, snoozing, cancellation, restoration, and archived-record views;
- a derived in-app notification centre with unread, read, dismiss, and schedule-aware snooze behaviour;
- personal appearance settings with independent light/dark/system mode and Orbit After Dark, Verdant, Coast, Berry, and Ember colourways;
- configurable household sections that can be added, renamed, reordered, recoloured, hidden, and restored to the Home, Vehicles, Devices, and Services defaults;
- provider-neutral OpenID Connect sign-in with discovery, Authorization Code flow, S256 PKCE, signed ID-token validation, just-in-time account provisioning, and provider logout;
- server-side sessions with opaque hashed credentials, rotation, secure cookies, same-origin checks, and synchronizer-token CSRF protection;
- authenticated PostgreSQL route handlers for workspaces, validated commands, account preferences, owner-controlled membership, and Web Push subscriptions;
- PostgreSQL/Drizzle schema for identities, sessions, households, memberships, items, events, reminders, push devices, notification deliveries, state, and audit history;
- household-local calendar-date rules, due-state ordering, and recurrence suggestions;
- IndexedDB snapshots, queued offline mutations, explicit synchronization states, installable web manifest, icons, offline shell, and service-worker push handling;
- an atomic PostgreSQL-backed SMTP/Web Push scheduler running inside the full-stack Next.js process;
- health endpoint, standalone Next.js build, and a single-application-container runtime;
- version-controlled initial migration and unit tests.

The product workspace remains fully interactive without infrastructure: representative records seed a versioned preview adapter and changes persist on the device. When an authenticated session and PostgreSQL are available, the same service boundary upgrades automatically to the validated API, keeps an IndexedDB snapshot, and synchronizes queued offline changes.

Household owners manage access by selecting existing registered users by display name. Orbit has no invitation workflow and does not expose other users' email addresses in household membership controls.

## Requirements

- Node.js 22 or later
- pnpm 10
- PostgreSQL 17 (or Docker)

## Local development

```sh
pnpm install
copy .env.example .env
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. The health endpoint is available at `/api/health`.

The configured `APP_URL`, the browser address, and the OIDC redirect URI must use the same host. In particular, do not switch between `localhost` and `127.0.0.1` during a sign-in attempt.

For a local PostgreSQL container only:

```sh
docker compose up -d homesee-db
```

The default `DATABASE_URL` in `.env.example` connects to that database from the host.

## Docker

Copy `.env.example` to `.env`, configure authentication and notification credentials, then start the stack:

```sh
docker compose up --build
```

The application applies versioned migrations before it starts serving and runs the notification scheduler in the same Node process. The two services follow the project-wide naming convention:

- `homesee-fe` is the complete Orbit application: interface, authenticated APIs, migrations, and reminder scheduler.
- `homesee-db` is the unmodified official `postgres:17-alpine` image with a persistent volume.

There is no custom database image and no separate backend container. You are still responsible for backing up the PostgreSQL volume and planning major-version upgrades, but not for maintaining a database build.

## Validation

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Runtime configuration

All runtime variables are documented in `.env.example`. Production deployments must use strong unique session secrets, HTTPS at the public URL, a private PostgreSQL connection, and valid OIDC/SMTP/VAPID credentials. Authentication responses and private APIs must use `Cache-Control: no-store`.

Authentik should be configured with a confidential OAuth2/OpenID provider, Authorization Code flow, a strict callback URI, a stable subject mode, and an asymmetric signing key. Orbit requests `openid profile email`; a usable email is required, while the provider's verification status is preserved separately. Account identity is always the immutable issuer/subject pair, so matching email addresses are never automatically merged.

The consumer-facing brand is Orbit. Internal package, database, cookie, and Docker service identifiers remain `homesee-*` during development to avoid an unnecessary infrastructure migration.

See [Authentication and Authentik setup](docs/authentication.md) for provider configuration, endpoint usage, security behaviour, and troubleshooting.

## Before first launch

1. Run the completed migrations against a disposable PostgreSQL instance and exercise OIDC sign-in with the intended provider.
2. Supply working SMTP and VAPID credentials, then verify one email and one browser push delivery.
3. Run browser end-to-end and accessibility coverage against the production build.
4. Configure automated PostgreSQL volume backups before storing real household data.
