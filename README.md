> [!IMPORTANT]
> **Development disclosure:** Orbit was coded by Claude under human
> direction.

<p align="center">
  <img src="docs/images/orbit-mark.svg" alt="Orbit logo" width="132" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>your year, in orbit</strong>
</p>

<p align="center">
  A modern, self-hosted home operations hub for maintenance, renewals,<br />
  recurring services, contracts, cover, and the people who share them.
</p>

<p align="center">
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-ff3e00?style=flat-square&logo=svelte&logoColor=white" />
  <img alt="PostgreSQL 18" src="https://img.shields.io/badge/PostgreSQL-18-22b8a9?style=flat-square&logo=postgresql&logoColor=white" />
  <img alt="Docker ready" src="https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-ff4fa3?style=flat-square&logo=typescript&logoColor=white" />
</p>

<p align="center">
  <img src="docs/images/orbit-banner.png" alt="Orbit — your year, in orbit" width="100%" />
</p>

## Quick start

From an empty directory on a Linux host (amd64 or arm64) with Docker Compose
v2 and `curl`:

```bash
curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh | bash
```

This downloads the signed Orbit launcher and checks it before running
anything: it verifies a signed manifest, checks every file's checksum
against that manifest, and (if `cosign` is installed) checks a second,
independent signature too. Only once everything checks out does it hand off
to the launcher, which runs the same installer described below. See
[docs/installer-guarantees.md](docs/installer-guarantees.md) for exactly
what is checked, and [docs/releasing.md](docs/releasing.md) for how the
signatures are made.

The older direct command still works and is signature-checked the same way:

```bash
curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/install.sh | bash
```

### What the installer asks

Run from a terminal, the installer shows a menu: Install, Update, Repair or
Exit.


- **Install** sets up a new Orbit in an empty directory. It first asks which
  profile you want: Standard (Orbit, its database and the malware scanner),
  Document processing (adds a local text-extraction service), Full local stack
  (adds a local AI model server as well), or Custom. It then asks whether
  people will sign in with local accounts only (the default) or also through
  an identity provider, an external sign-in service such as Authentik. Local
  accounts only: it needs just Orbit's public address. Identity provider as
  well: it also needs the provider's address (the "issuer"), the client ID it
  gave you, and the client secret, which you type hidden. Nothing in the
  directory changes until you accept the final review screen.
- **Update** refreshes an existing Orbit. If the current settings are complete
  it keeps them, and your secrets, exactly as they are and does not ask again.
- **Repair** changes nothing yet. It tells you to run
  `bash scripts/repair.sh --check` to diagnose the deployment, then `--plan`
  to see what a repair would do.

When everything is running, the final screen shows Orbit's address, the
version, the exact build installed, the profile, and the commands for status
and logs. It also points you at the container log, which holds the link for
claiming the new Orbit and creating its first administrator: see
[Claiming a fresh install](docs/authentication.md#claiming-a-fresh-install).

Git is not needed and the repository is not cloned. A deployment needs only
the Compose files and a published build, not the source code or tests.

### Automated or logged runs

Add `--plain` for output with no screen drawing, one line at a time, safe for
logs and pipes, and name one action: `--install`, `--update` or `--repair`.
`--install` accepts only an empty directory (or a pre-provisioned one, below);
`--update` accepts only a directory that already holds an Orbit deployment.

`bash scripts/install.sh --simulate` (with `--plain` if you like) is a
rehearsal. It shows the same menus, prompts and example success and failure
screens, using clearly labelled made-up values. It does not read or change the
directory and never contacts Docker, `curl`, a registry or an identity
provider. It cannot be combined with `--install`, `--update` or `--repair`.

### Installing with no prompts

For an unattended install, the directory must already contain a complete
`.env-orbit` and an `.orbit-secrets/` directory, and nothing else. Before it
downloads anything, the installer checks that:

- `.env-orbit` is a plain file (not a symlink) with permissions `0600`;
- `.orbit-secrets/` is a real directory (not a symlink) with permissions
  `0700`, and every file inside it is a plain, non-empty, non-symlink file
  with permissions `0600`;
- `.orbit-secrets/oidc-client-secret` exists and is not empty;
- `.env-orbit` points at that secret file (the file-backed setting, not the
  direct one) and passes `bash scripts/configure.sh --check`.

Anything else is refused before Docker or any download starts: extra files,
symlinks, empty files, looser permissions, a setting that still needs
attention, an invalid callback address, or an optional group that is only
half filled in. If configuration, identity-provider discovery or the Compose
pre-check then fails, your files are left byte-for-byte as they were.

### What gets installed

The installer downloads Orbit from the release registry, the server that
publishes Orbit's builds. It records exactly which build it downloaded using
the build's digest: a fingerprint that identifies one build and nothing else.
That fingerprint is written to `.env-orbit`, and that build is what runs, so
an update can't swap in something different behind your back. Everything
needed to run Orbit, including its configuration files and operator scripts,
is packed inside the same build. The files always match the version they came
with, and the installer never downloads them separately. A version name like
`preview` is only used to look up which build it points to today; what gets
installed is always the fingerprint, never the name.

It then creates or re-checks `.env-orbit`, generates three separate random
secrets (for sign-in sessions, the database password and document
encryption), checks the Compose configuration, and fetches the images for the
services you chose. It reports success only once the database is healthy,
Orbit's own health check at `/api/health` says ready, the malware scanner is
healthy, and each optional service you chose answers its check.

Development and routine preview builds are made for 64-bit x86
(`linux/amd64`) so they build faster. ARM64 builds are added only once they
can be tested the same exact-image way.

If you cancel during the prompts, or an unattended run finds a setting that
needs attention, the installer puts the managed files back as they were and
prints only the names of the fields and what to do next. From a terminal,
rerun the installer. From a checked-out deployment you can also fix the
settings directly:

```sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

### Building from source instead

Building is a developer task, not an install option, so the installer does
not offer it. Clone the repository and build:

```bash
git clone https://github.com/tomlawesome/orbit.git && cd orbit
bash scripts/configure.sh
bash scripts/build-container.sh
```

Generated secrets live in `.orbit-secrets`, readable only by the user who ran
the script. Compose gives each container only the secret files it needs, under
`/run/secrets`; secret values never go into container environment variables.
Later runs keep existing secrets, and the scripts never read or write a
generic `.env` file.

## Your home has an orbit

Boilers need servicing. Insurance renews. Cars need inspections. Devices leave
warranty. Contracts roll over. Orbit brings those scattered responsibilities
into one calm, shared view—so the important things stay visible before they
become urgent.

## A quick visual tour

These screenshots show the real Orbit application using deterministic synthetic
household, item, document and mailbox data. They contain no live accounts,
provider settings or infrastructure details.

<p align="center">
  <img src="docs/assets/product-tour/overview.png" alt="Orbit desktop overview showing three upcoming synthetic household records" width="100%" />
</p>

<p align="center">
  <img src="docs/assets/product-tour/item-detail.png" alt="Orbit item details for a synthetic annual boiler service, including schedule and reminders" width="100%" />
</p>

<p align="center">
  <img src="docs/assets/product-tour/settings.png" alt="Orbit desktop settings page showing appearance, data, inbox and household sections" width="100%" />
</p>

<p align="center">
  <img src="docs/assets/product-tour/inbox.png" alt="Orbit incoming-documents view showing one synthetic mailbox review" width="100%" />
</p>

The captures show synthetic data only. They are static assets under
`docs/assets/product-tour/`: the browser test that used to regenerate them
went with the Next application (#735), and ordinary browser tests do not
write documentation assets.

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
- **Installable without private offline storage** — a PWA shell and
  service-worker push handling, while authenticated workspace data remains
  server-authoritative and changes are never queued for later replay.
- **Private by design** — local password accounts are always available, and
  an identity provider is optional. Sign-in state stays on the server, and
  every request is checked to be genuine and to come from Orbit's own
  address before it can touch household data.

## One app. Standard supporting services.

Orbit deliberately keeps the operational footprint small:

```mermaid
flowchart LR
    browser["Browser or installed PWA"]
    orbit["orbit application container"]
    postgres[("orbit-postgres")]
    documents[("encrypted document volume")]
    scanner["official ClamAV scanner"]
    identity["OIDC identity provider (optional)"]
    delivery["SMTP and Web Push providers"]

    browser <-->|HTTPS| orbit
    orbit <-->|PostgreSQL| postgres
    orbit -->|ciphertext only| documents
    orbit -->|quarantined stream| scanner
    orbit <-.->|OpenID Connect, when enabled| identity
    orbit -->|Notifications| delivery
```

- `orbit` is the whole Orbit application: the interface, the signed-in APIs,
  the database migrations and the notification scheduler. It is either built
  from source or pulled by exact build fingerprint (`ORBIT_IMAGE` must name a
  registry digest).
- `orbit-postgres` is the official PostgreSQL 18 Alpine image, pinned to one
  exact build, with a persistent volume.
- `orbit-clamav` is the official malware scanner image. It receives only
  quarantined file streams over a private network and has no port on the host,
  no database credentials, no document volume and no Orbit secrets.

There is no custom PostgreSQL image and no separate frontend and backend to
maintain. ClamAV is on by default and normally needs about 4 GiB of memory.
An administrator can turn it off, but Orbit then shows a permanent warning and
marks every later upload as unscanned.

## Run with Docker

### 1. Create the runtime configuration

```sh
bash scripts/configure.sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

`bash scripts/configure.sh` on its own creates `.env-orbit` and the private
`.orbit-secrets` directory without starting any containers. It runs the Orbit
image once, only to generate the key pair used for browser push
notifications: the private key goes in `.orbit-secrets`, the public key in
`.env-orbit`. If the files already exist it leaves them alone. Unattended
installs and upgrades rely on this: the installer carries on only when the
existing configuration and secret file are already complete and safe.

`--init` asks whether people will sign in with local accounts only (the
default, `ORBIT_AUTH_OIDC=false`) or also through an identity provider. Only if
you answer "also" does it ask for Orbit's public HTTPS address, the provider's
issuer URL and the client ID, and it works out the callback URL itself. It
never asks for, or invents, the provider's client secret.

`--set-oidc-secret` reads that secret without showing it, stores it in
`.orbit-secrets`, and records only the file's path in `.env-orbit`. See
[authentication setup](docs/authentication.md).

`--check` reports whether every required setting and each optional group is
complete. It prints setting names and their state, never values.

After Orbit starts, claim it to create the first administrator: see
[Claiming a fresh install](docs/authentication.md#claiming-a-fresh-install).

### 2. Start Orbit

From a checkout, build the image and start the stack with the same guarded
script CI uses:

```sh
bash scripts/deploy-container.sh --build
```

It builds through the `compose/docker-compose.build.yml` overlay. The base
Compose file describes a deployment, which has a published image and no source
tree, so the build instructions live in the overlay. If you drive Compose by
hand, `scripts/build-container.sh` shows the three build variables
(`ORBIT_VERSION`, `ORBIT_REVISION`, `ORBIT_CHANNEL`) the overlay requires.

Open the address in `APP_URL`. For a real deployment that is an HTTPS
address, and your reverse proxy must send it to Orbit's published port. Plain
HTTP works only on the Docker host itself, at
[http://127.0.0.1:3000](http://127.0.0.1:3000). The health check is at
`/api/health`.

By default Orbit listens on every network interface of the host. Set
`ORBIT_BIND_ADDRESS=127.0.0.1` in `.env-orbit` when only the host itself, or a
reverse proxy running on it, should reach Orbit. Never open port `3000`
directly to the internet.

On start, Orbit waits for the database, applies any pending database
migrations (schema updates), starts the notification scheduler, then serves
the application.

### Before and after an upgrade

Before an upgrade, take a backup, check it, and keep a copy of the current
`.env-orbit` beside it, readable only by you. The backup deliberately holds
no configuration or secrets; the saved `.env-orbit` records exactly which
build was running, so you can go back to it:

```sh
umask 077
preupgrade_dir="${ORBIT_BACKUP_DIR:-backups}"
mkdir -p -- "$preupgrade_dir"
chmod 700 -- "$preupgrade_dir"
preupgrade_config="$preupgrade_dir/orbit-pre-upgrade.env"
cp -- .env-orbit "$preupgrade_config"
chmod 600 "$preupgrade_config"
backup_output="$(ORBIT_BACKUP_DIR="$preupgrade_dir" bash scripts/backup.sh)" || exit 1
case "$backup_output" in
  "Orbit backup created: "*) backup_path="${backup_output#Orbit backup created: }" ;;
  *) exit 1 ;;
esac
ORBIT_BACKUP_DIR="$preupgrade_dir" bash scripts/backup.sh --verify "$backup_path" >/dev/null
```

What the installer guarantees during an upgrade:

- It checks the new build's configuration rules before touching an existing
  `.env-orbit`, and keeps a private rollback copy. Until it reports success, a
  configuration or pre-start failure automatically restores the original
  files.
- Each successful upgrade records the version and build fingerprint it applied
  in `ORBIT_CONFIG_APPLIED_VERSION` and `ORBIT_CONFIG_APPLIED_DIGEST`. They
  must match `ORBIT_IMAGE`; never edit them by hand.
- A fresh install, or a recognised rename of the deployment directory, records
  the validated `COMPOSE_PROJECT_NAME` (the Compose project name). Keep running
  `docker compose --env-file .env-orbit`, `scripts/backup.sh` and
  `scripts/restore.sh` from the deployment directory, and do not pass a
  remembered `--project-name`, so every command keeps addressing the same
  containers and volumes after a reboot.
- If the installer is killed mid-run, `.env-orbit` is either the old file or
  the complete new one, never half-written. Private
  `.orbit-install-staging.*` files may be left behind with owner-only
  permissions; keep them until recovery is complete.
- Before reusing an existing deployment it proves the deployment is really
  this one: the Compose project, the database volume's labels, who owns the
  stopped containers, and the previous build. Moving the directory therefore
  never quietly creates an empty database. A fresh install is refused if any
  Orbit database volume already exists, and an update is refused if ownership
  cannot be proven. Orbit never deletes or resets a database volume by itself.
  Keep `.orbit-secrets/postgres-password` exactly as it is.

A configuration file from an older Orbit that no installer has migrated can be
inspected with `scripts/configuration.sh --preflight` and upgraded explicitly,
giving it the new build's details:

```sh
bash scripts/configuration.sh --migrate --orbit-image \
  'registry.example/orbit@sha256:<64 lowercase hexadecimal characters>' \
  --applied-version v1.2.3 \
  --applied-digest 'sha256:<64 lowercase hexadecimal characters>' \
  --compose-project-name orbit
```

The two digests must be the same. The command keeps one owner-only rollback
copy beside the file, changes the file all at once or not at all, is safe to
run again, and never rewrites your own values or secrets.

If Orbit has started but the database migration or sign-in then fails, stop
it and restore both the checked backup and the saved configuration:

```sh
docker compose --env-file .env-orbit stop orbit-app
cp -- "$preupgrade_config" .env-orbit
chmod 600 .env-orbit
docker compose --env-file .env-orbit pull orbit-app
ORBIT_BACKUP_DIR="$preupgrade_dir" bash scripts/restore.sh "$backup_path"
```

The restored `.env-orbit` names the previous build exactly; do not swap in a
version name or edit only `ORBIT_IMAGE`. Follow the restore prompts, check
`/api/health` and that you can sign in on the previous build, and only then
delete the saved copy with `rm -f -- "$preupgrade_config"`. Keep it until
health is confirmed.

### Optional local processing stack

The standard stack already scans every upload for malware. Two further
services are optional, because they need a lot of host memory and normal use
does not need them: Tika, which extracts text from documents (including OCR
for scanned pages), and Ollama, which runs an AI model locally. Current Orbit
releases use Tika only to show bounded review evidence. They never send
document text to Ollama and never let it create or change household data.

To turn both on, add these lines to `.env-orbit`:

```sh
TIKA_URL=http://orbit-tika:9998
# Choose a local model only after checking its size, licence and host capacity.
OLLAMA_MODEL=<a-local-model-name>
COMPOSE_PROFILES=processing,ai
```

Then start Orbit with the usual command:

```sh
docker compose --env-file .env-orbit up -d
```

The choice lives in `.env-orbit`, not in the command, so turning a service on
or off later is a one-line edit. Leave `COMPOSE_PROFILES` empty for the
standard stack, which runs neither.

Neither service has a port on the host. Both sit on a private network shared
only with Orbit and the virus scanner. From there they cannot reach the
database or the internet. Ollama keeps its models in a local volume, never uses cloud
models, and is limited to 2 CPUs and 6 GiB of memory by default.

Because Ollama cannot reach the internet, it cannot download a model. Set
`OLLAMA_MODEL` first, then run the one-off pull helper, which downloads into
the model volume and exits:

```sh
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm orbit-ollama-model-pull
```

Full details, including hosts with no internet access, are in
[Private model server and its model pull](docs/administrator-operations.md#private-model-server-and-its-model-pull).

To stop and remove the optional containers, run the same Compose command with
`down` instead of `up -d`. Leave out `--volumes` to keep downloaded models.

> [!IMPORTANT]
> Use one address everywhere: `APP_URL`, the address in the browser, and the
> callback address registered with the identity provider. Do not switch
> between `localhost` and `127.0.0.1` part-way through a sign-in.

Nobody sees a household without signing in. A new Orbit stays unclaimed until
someone opens the claim link printed in the container's start-up log (see
[Claiming a fresh install](docs/authentication.md#claiming-a-fresh-install)).
That person becomes the first instance administrator and is walked through
setup: household name, timezone, currency and sections. Home, Vehicles,
Devices and Services are offered as defaults, or you can give your own list.

![The first-run setup wizard asking for a name, time zone and currency, and admitting to the four default sections](docs/images/first-run-sections-step.png)

Instance administrators can manage every household and can grant or remove
administrator access for other users. Orbit will not let the last
administrator be removed.

### Update and launch an existing checkout

Once `.env-orbit` exists, update and start Orbit from a checkout with:

```sh
./scripts/update-and-start.sh
```

It pulls the latest source (fast-forward only), pulls the PostgreSQL and
ClamAV images, rebuilds the Orbit image, starts the stack in the background
and prints the service status. It stops at once if Git, Docker Compose v2 or
`.env-orbit` is missing.

## Production foundation

Orbit already includes:

- a first-run setup wizard, instance administrators, and household membership
  controlled by each household's owner;
- create, edit, schedule, remind, archive, undo and restore;
- recurrence suggestions and calendar-date rules that follow the household's
  own timezone;
- a notification centre that knows the schedule, with read, dismiss and
  snooze;
- per-user choices for email and browser-push delivery;
- household ownership transfer that happens all at once and is written to
  the audit history;
- a PostgreSQL database (managed with Drizzle) for users, sessions,
  households, memberships, items, events, reminders, push devices, delivery
  state and audit history;
- local password accounts, always available, plus optional sign-in through
  any standard OpenID Connect provider using the recommended flow
  (Authorization Code with PKCE) — see
  [authentication.md](docs/authentication.md);
- when a provider is on, accounts are created at first sign-in and tied
  permanently to that provider's identity for the person;
- email and browser-push delivery through a scheduler that uses PostgreSQL
  to make sure each notification is claimed once;
- a sign-in gate that shows nothing about a workspace or a household to
  signed-out visitors;
- production health checks, a standalone server build, a purpose-built
  browser favicon, and version-controlled migrations;
- document uploads (PDF, JPEG, PNG) with size limits, malware rejection by
  ClamAV, a separate encryption key for each document, quotas, audited
  downloads, soft deletion, timed purge and storage reconciliation — see
  [Encryption at rest](docs/encryption-at-rest.md) for what this protects,
  what it does not, and why.

Orbit does not keep workspace data or pending changes in the browser's own
storage. It removes the old preview-build IndexedDB database before a session
starts and on sign-out, and its service worker never caches API or sign-in
responses. Production images contain no sample households or seeded records.

## Local development

### Requirements

- Node.js 22 or later
- pnpm, at the version `package.json` pins under `packageManager`
- PostgreSQL 18, or Docker for the database only

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
against disposable data.

`bash scripts/test-e2e-local.sh` is the safe default: it brings up this same
overlay, plus the mail overlay, under an isolated Compose project derived from
this worktree and process (so it can never collide with a real deployment or
another concurrent run on the same host), waits for health, runs the browser
suite, and guarantees teardown, all mirroring the acceptance stage of the
container-validation workflow:

```sh
bash scripts/test-e2e-local.sh
bash scripts/test-e2e-local.sh --spec tests/e2e/v19-mail-review.spec.ts --project mobile-chromium
```

Re-running one failing spec need not pay for a fresh build and start each
time: `--keep` leaves the stack up, and a later `--reuse PROJECT` (the
project name that run's startup log line names) skips straight to Playwright
against it. `--reuse` identifies and health-checks that stack itself --
never assumes it is still healthy, and never tears it down:

```sh
bash scripts/test-e2e-local.sh --keep
# ... a spec fails; fix it, then:
bash scripts/test-e2e-local.sh --reuse <project> --spec tests/e2e/v19-mail-review.spec.ts
```

If you run the Compose commands by hand (for example to inspect a stack
between steps), always pass an isolating `-p`, or you can silently attach to
your real deployment's containers and data. `docker-compose.yml`'s
`name: orbit` and `.env-orbit`'s `COMPOSE_PROJECT_NAME` both default to the
same project name a real deployment uses, from any checkout, so a bare
`--env-file .env-orbit` command with no `-p` reuses that deployment's
containers and named volumes instead of creating its own. AGENTS.md documents
this trap and issue #536 hit it for real. The `--keep` output prints the
exact teardown line to use:

```sh
docker compose -p orbit-acceptance-local --env-file .env-orbit -f docker-compose.yml -f compose/docker-compose.acceptance.yml up --build --wait
ORBIT_ACCEPTANCE_OIDC=true bash scripts/test-frontend.sh
docker compose -p orbit-acceptance-local --env-file .env-orbit -f docker-compose.yml -f compose/docker-compose.acceptance.yml down --volumes --remove-orphans
```

`scripts/compose-isolation-preflight.sh` is the scripted version of the same
check: source it and call `resolve_compose_project` and
`compose_isolation_preflight` before an `up`, and it refuses -- naming the
resolved project and the safe `-p` alternative -- when that project already
has containers running.

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

Every corpus committed to the repository is invented — real paperwork must
never be committed. If you want to know how extraction does against your own
real documents, [private local evaluation](docs/private-eval.md) runs
entirely on your machine, against a directory you choose outside the repo,
and prints only per-field and overall scores; it structurally refuses to run
against anything inside the repository and never prints document content.

The [v1 charter](docs/v1-charter.md) defines the supported release,
[architecture and ADRs](docs/architecture.md) record durable system decisions,
and the [quality strategy](docs/quality-strategy.md) defines test and CI
evidence. GitHub milestones and issues own delivery status. Product directions
outside the stable contract remain in the
[feature register](docs/feature-register.md).

## Configuration

Every supported setting is listed, with comments, in
[`.env-orbit.example`](.env-orbit.example). A sensitive setting can be given
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

The installer creates and mounts the PostgreSQL password and session secret
files for you. If you choose a different `_FILE` setting, create that file
yourself and add a matching read-only secret mount to the Compose service.

In the table, a "digest" is a build's fingerprint: it identifies one exact
build and nothing else. The "document key-encryption key" is the master key
that protects each document's own key.

| Variable | Used by | Purpose | Example value |
| --- | --- | --- | --- |
| `APP_URL` | Orbit | The address people use in the browser; also used for cookies and request checks. Use HTTPS except on loopback. | `https://orbit.example.com` |
| `ORBIT_IMAGE` | Compose | Exact `registry/repository@sha256:...` identity for pulled deployments. Repository build scripts supply a revision-specific local tag instead. | `ghcr.io/tomlawesome/orbit@sha256:<64 lowercase hexadecimal characters>` |
| `ORBIT_BIND_ADDRESS` | Compose | Host interface that publishes Orbit. Use loopback when a reverse proxy is on the same host. | `0.0.0.0` |
| `ORBIT_PORT` | Compose | Host TCP port mapped to container port 3000. | `3000` |
| `SESSION_SECRET` | Orbit | Direct session-signing secret. Leave empty when `SESSION_SECRET_FILE` is set. | `<64-character-random-hex>` |
| `SESSION_SECRET_FILE` | Orbit | File containing the session-signing secret. The Compose stack overrides this to `/run/secrets/...`. | `.orbit-secrets/session-secret` |
| `SESSION_TTL_SECONDS` | Orbit | How long a sign-in lasts, in seconds. | `604800` |
| `DOCUMENTS_ROOT` | Orbit | Where encrypted documents are kept inside the container. | `/var/lib/orbit/documents` |
| `DOCUMENTS_QUARANTINE_ROOT` | Orbit | Temporary holding area for an upload while it is scanned; Compose supplies a private in-memory folder that disappears on restart. | `/tmp/orbit-document-quarantine` |
| `DOCUMENT_KEK` | Orbit | Direct 32-byte hexadecimal document key-encryption key. Leave empty when the file form is used. | `<64-character-random-hex>` |
| `DOCUMENT_KEK_FILE` | Orbit | File containing the document key-encryption key. Compose mounts the generated file under `/run/secrets`. | `.orbit-secrets/document-kek` |
| `DOCUMENT_KEK_NEXT` / `DOCUMENT_KEK_NEXT_FILE` | Orbit | Second document key-encryption key, held alongside the first only while a key rotation is in progress (#954). Set only via the `docker-compose.kek-rotation.yml` overlay — see "Rotating the document key-encryption key" in `docs/administrator-operations.md`. | `<64-character-random-hex>` |
| `DOCUMENT_MAX_BYTES` | Orbit | Largest upload accepted, in bytes. | `26214400` |
| `DOCUMENT_HOUSEHOLD_QUOTA_BYTES` | Orbit | Most document storage one household may keep. | `5368709120` |
| `DOCUMENT_INSTANCE_QUOTA_BYTES` | Orbit | Most document storage the whole instance may keep. | `21474836480` |
| `DOCUMENT_RETENTION_DAYS` | Orbit | Days a deleted document can still be restored before it is purged for good. | `30` |
| `DOCUMENT_SCAN_MODE` | Orbit | `required` refuses uploads when ClamAV is unavailable; `disabled` skips scanning and shows a permanent warning. | `required` |
| `CLAMAV_HOST` | Orbit | Private Compose hostname of the ClamAV daemon. | `orbit-clamav` |
| `CLAMAV_PORT` | Orbit | Private ClamAV daemon port; do not publish it on the host. | `3310` |
| `CLAMAV_TIMEOUT_MS` | Orbit | Longest a malware scan may take per upload. | `30000` |
| `CLAMAV_MEMORY_LIMIT` | Compose | Memory limit for the scanner container. | `4g` |
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
| `SMTP_HOST` / `SMTP_PORT` | Worker | SMTP server host and port. | `smtp.example.com` / `587` |
| `SMTP_SECURITY` | Worker | `starttls` (port 587) or `implicit_tls` (port 465); plaintext SMTP is unsupported. | `starttls` |
| `SMTP_USER` / `SMTP_PASSWORD_FILE` | Worker | SMTP login and a file containing its password. | `orbit@example.com` / `/run/orbit-secrets/orbit-smtp-password` |
| `SMTP_URL` | Worker | Deprecated compatibility form; do not set it with the individual SMTP settings. | `smtps://orbit%40example.com:password@smtp.example.com:465` |
| `SMTP_FROM` | Worker | Display name and sender address for reminder email. | `Orbit <orbit@example.com>` |
| `VAPID_SUBJECT` | Worker | Contact address sent with browser push notifications. VAPID is the standard for browser and PWA push; it is not Pushover. | `mailto:admin@example.com` |
| `VAPID_PUBLIC_KEY` | Browser and worker | Public push key generated for this deployment. | `<base64url-public-key>` |
| `VAPID_PRIVATE_KEY` | Worker | Direct private push key. Leave empty when the file form is used. | `<base64url-private-key>` |
| `VAPID_PRIVATE_KEY_FILE` | Worker | File containing the private push key. | `/run/secrets/orbit-vapid-private-key` |
| `WORKER_POLL_SECONDS` | Worker | Seconds between checks of the notification queue. | `60` |
| `MAINTENANCE_TICK_SECONDS` | Worker | Seconds between checks for a scheduled maintenance notice that is due. Maintenance begins at its scheduled time regardless; this only records the change. | `30` |
| `NOTIFICATION_MAX_ATTEMPTS` | Worker | Delivery attempts before a notification is marked failed. | `5` |
| `MIGRATE_ON_START` | Orbit | Applies pending database migrations at startup. Compose sets this to `true`. | `false` |
| `WORKER_ENABLED` | Orbit | Runs the notification scheduler inside the application container. Compose sets this to `true`. | `false` |
| `DRIZZLE_MIGRATIONS_PATH` | Orbit | Directory containing versioned SQL migrations. | `drizzle` |
| `ORBIT_SECRETS_DIR` | Compose | Host directory containing files mounted as Compose secrets. | `./.orbit-secrets` |

Inbound mail (the mailbox Orbit polls for incoming statements and documents)
is not set here any more. An instance administrator sets it on the
administration screen, and Orbit stores the credential encrypted in the
database (ADR-0017). No `IMAP_*` setting is accepted.

Use `docker-compose.mail.yml` once the SMTP password file exists. The
complete operator procedure and production-like acceptance boundary are
documented in
[Orbit administrator operations](docs/administrator-operations.md).

For production, use HTTPS, file-backed secrets, a private PostgreSQL
connection, and working identity-provider, SMTP and push credentials. Keep
recovery bundles somewhere other than the Docker host before storing real
household data.

### Backups

Create a checked backup of the PostgreSQL database and an encrypted archive
of the document volume:

```sh
bash scripts/backup.sh
```

The ordinary backup deliberately leaves out the document key, so it is only
useful together with the key on this host. Restore it while Orbit is stopped;
the restore either completes fully or changes nothing:

```sh
bash scripts/restore.sh backups/orbit-YYYYMMDD-HHMMSS.tar
```

When the backup must survive losing the host, create a recovery bundle
protected by a passphrase and store it elsewhere:

```sh
bash scripts/export-recovery-bundle.sh backups/orbit-YYYYMMDD-HHMMSS.tar
bash scripts/import-recovery-bundle.sh backups/orbit-recovery-YYYYMMDD-HHMMSS.tar
```

The bundle is sealed with strong, tamper-evident encryption (AES-256-GCM,
with the key derived from the passphrase by scrypt). Neither the document key
nor the passphrase is ever printed, put in an environment variable or passed
on a command line.

### Build or deploy

Build or deploy the Compose application through the same guarded scripts CI
uses:

```sh
bash scripts/build-container.sh
bash scripts/deploy-container.sh --pull
# Or build locally before deployment:
bash scripts/deploy-container.sh --build
```

See [Authentication and Authentik setup](docs/authentication.md) for provider
configuration, endpoint behaviour, security details, and troubleshooting.
See [Gitflow previews and stable promotion](docs/releasing.md) for
the protected branch, test, manual-validation, and digest-promotion workflow.

## Before the first real launch

1. Apply the migrations to a disposable PostgreSQL instance and exercise OIDC
   sign-in with the intended provider.
2. Verify one SMTP delivery and one browser-push delivery with production-like
   credentials.
3. Run the browser and accessibility checks against the production build.
4. Schedule `scripts/backup.sh`, retain copies outside the Docker host, and
   perform a test restore.
5. Read [Encryption at rest](docs/encryption-at-rest.md) and decide whether
   the host disk needs encryption before going live — Orbit does not decide
   this for you.

---

## Licence

Orbit is free software, licensed under the [GNU Affero General Public
License v3.0 or later](LICENSE). If you run a modified Orbit for others
over a network, the AGPL's remote-interaction clause applies. The three
bundled typefaces are separately licensed under the SIL OFL&nbsp;1.1
(issue&nbsp;#440); their licence text ships with the application.

<p align="center">
  <img src="docs/images/orbit-mark.svg" alt="" width="52" />
  <br />
  <strong>your year, in orbit</strong>
</p>
