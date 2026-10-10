# Testing Orbit

Orbit's tests are in separate layers, so quick feedback does not depend on
Docker, while anything that claims something about the database or an HTTP
boundary is checked against real services.

## Commands

- `pnpm test` runs the fast unit and domain suite. It does not need Docker.
- `pnpm test:integration` starts one throwaway PostgreSQL 18 Alpine container
  on a random loopback port, applies every migration, runs the PostgreSQL and
  API integration suite, and removes that exact container whether the run
  passes, fails or is interrupted. The container image is the official one,
  pinned by digest (a fingerprint that names one exact image, so a moved tag
  cannot change what the tests run against).
- `pnpm test:e2e` runs browser tests against an application that is already
  running.
- `pnpm test:coverage` produces V8 coverage for the fast suite, for
  information only.

The integration command needs Docker to be running. It never touches the
developer's own Orbit database, containers or volumes. Every run makes up a
unique container, database name, user and fake password, so repeated and
concurrent runs cannot share state. Test fixtures use only `example.invalid`
identities and made-up records. They never contact an OIDC provider, and they
add no way to skip real sign-in.

## Integration fixture contract

Integration fixtures create only the records a test needs, using the real
PostgreSQL schema: users, preferences, external identities, sessions,
households, owner and member memberships, sections, items and visible
document metadata. Sessions are created through the production session code,
and tests use the production cookie name and the production CSRF check (the
check that a request came from Orbit's own pages, not another site). Route
tests call the real SvelteKit route handlers with a `RequestEvent`
(`tests/integration/support/request-event.ts`), not a development server or a
mocked authorisation boundary.

The first examples cover a saved `household.update` workspace change, CSRF
rejection before anything changes, and household-scoped document listing with
an outsider response that reveals nothing. Uploading, parsing, scanning and
encrypting document bytes belong to higher test layers.

The PostgreSQL integration layer also holds a saved authorisation matrix. It
covers malformed, expired and disabled sessions; live membership removal;
workspace, household and lifecycle routes; denial of document list, download,
delete and restore; portable archive ownership and non-disclosure; and
administrator operations. For each denied request it asserts the bounded
error contract, a `no-store` response, an unchanged target and, where the
request would have changed something, an unchanged audit trail.

## Hand-writing a migration

`pnpm db:generate` is refused (`scripts/db-generate-refused.mjs`, #535).
drizzle-kit works out a new migration by comparing the schema with its last
saved snapshot of it, and `drizzle/meta/` only has snapshots through 0004. So
`drizzle-kit generate` would compare against that old snapshot and quietly
write a migration that recreates almost the whole schema. Write migrations by
hand instead:

1. Create `drizzle/NNNN_name.sql`, where `NNNN` is the next number after the
   last journal entry, in the style of `drizzle/0027_instance_authority.sql`:
   plain DDL, with `--> statement-breakpoint` between statements. Write a
   `DO $$ ... END $$` block only when existing rows must be changed, and make
   that change deliberate and auditable. (0027 seats a primary administrator;
   when the data is ambiguous it stops rather than guesses.)
2. Add the matching entry to `drizzle/meta/_journal.json` by hand: `idx` one
   past the last entry, `version` copied from the file's own top-level
   `version`, `tag` equal to the migration's filename without `.sql`, `when` a
   later millisecond timestamp than the previous entry's, and
   `breakpoints: true`.
3. Update `tests/integration/support/migration-fixture.ts` for whatever the
   migration changes:
   - New or changed columns go in `EXPECTED_TABLE_COLUMNS` (kept sorted; the
     module sorts every entry once at load).
   - New indexes go in `EXPECTED_INDEXES`, constraints (primary key, unique,
     foreign key) in `EXPECTED_CONSTRAINTS`, and new enum labels in
     `EXPECTED_ENUMS`.
   - Everything here is compared word for word with `readSchemaContract` in
     `tests/integration/migrations.test.ts`, so a mismatch in either
     direction fails that test rather than passing quietly.
4. Update `tests/integration/migrations.test.ts` if the migration does more
   than change the schema. A migration that always seeds or transforms data
   (as 0028 and 0033 do for their single-row tables) needs an assertion on
   that seeded state in the "migrates every current migration into a fresh
   PostgreSQL 18 database" test. A migration that can fail on existing data
   (as 0022 does) needs its own scenario, following the
   `document_openable_scan_status_valid` test below it.

`tests/integration/fixtures/migration-baseline.json` freezes the supported
upgrade starting point (`migrationPrefix`, currently through 0017). An
ordinary new migration does not touch it.

## CI relationship

Merge requests and pushes to `dev` run:

- lint, type checking and the complete unit suite;
- the source secret scan;
- the licence-policy check over the whole installed dependency tree;
- PostgreSQL integration;
- the container build, then the smoke, browser and recovery journeys against
  that build. The browser suite is four jobs side by side: `smoke` runs it in
  Chromium, `smoke_firefox` in Firefox, and `smoke_webkit` /
  `smoke_webkit_mobile` in WebKit, desktop and phone. With Firefox inside
  `smoke`, that one job took 29.9 of its 30 minutes, so it has its own
  (#1183); WebKit's desktop and phone projects together ran close to the same
  limit, so they split the same way (#1192).
- the appearance checks, also two jobs: `fidelity` (Chromium appearance and
  the phone-floor measurements) and `fidelity_webkit` (the phone film in
  WebKit), split in #1174 so neither risks the 30-minute job limit.

CodeQL runs separately on the GitHub mirror.

Every push to protected `preview` (or a `hotfix/**` branch) runs the whole
path: source policy, PostgreSQL, the exact image, browser, security, recovery,
installer and publication. A merge to `main` checks the already-tested preview
digest, its embedded identity and its attestations (the signed proofs of what
it passed) without rebuilding it.

When selected, two integration runs at the same time prove that independent
runs share no PostgreSQL state or Docker resources. The command is still
usable as a single isolated run during local development.

If Docker is unavailable, the command fails with a clear message. If a run is
interrupted, look only at the uniquely named `orbit-integration-*` container
the run reported; do not use broad Docker prune or delete commands.

## What the accessibility checks cover

The `smoke`, `smoke_firefox`, `smoke_webkit` and `smoke_webkit_mobile` jobs
run the Playwright suite in `tests/e2e/` against the production container
just built, with the throwaway OIDC profile. The suite has five browser
projects: desktop Chromium and mobile Chromium (a Pixel 7 profile) in
`smoke`, desktop Firefox in `smoke_firefox`, and desktop WebKit (Safari) and
mobile WebKit (an iPhone 15 profile) in `smoke_webkit` and
`smoke_webkit_mobile`. The two Chromium projects cover both of Orbit's
layouts, and Firefox and WebKit repeat them on their own engines (#1183,
#1192). The maintenance-window spec runs once per project, after the rest,
one project at a time, for the Chromium and Firefox projects only -- WebKit
has no maintenance pass of its own yet. Locally, `scripts/test-e2e-local.sh`
runs all five unless told otherwise; `ORBIT_E2E_ENGINES=chromium`, `=firefox`
or `=webkit` picks one engine the way the jobs do, and
`ORBIT_E2E_WEBKIT_DEVICES=desktop` or `=mobile` narrows WebKit further the
way `smoke_webkit` and `smoke_webkit_mobile` do. On the development host the
WebKit projects run inside the CI Playwright image rather than on the host,
which lacks WebKit's system packages (#1235). The automated checks are
deliberately representative, not device certification:

| Contract | Automated evidence |
| --- | --- |
| WCAG A/AA | `v19-axe-sweep.spec.ts` runs Axe over every signed-in route in both layouts; `signed-out.spec.ts` covers the sign-in door. |
| Keyboard and focus | `v19-keyboard.spec.ts` and `v19-keyboard-pocket.spec.ts` drive the core journeys, sign-in through sign-out, by keyboard alone on desktop and mobile. |
| Screen reader | `v19-screen-reader.spec.ts` reads back what the browser's accessibility engine would announce on every core-journey screen, and writes the raw ARIA tree to `test-results/aria/<route>.txt` for a person to read. |
| Charts | `v19-chart-accessibility.spec.ts` checks the home dial is a labelled group with a named link per body, and that nothing focusable inside it is unnamed. |
| Reduced motion | `v19-reduced-motion.spec.ts` checks that `prefers-reduced-motion` and no-JS both fall back to the plain list. |
| Responsive layout | `v19-layout-and-themes.spec.ts` opens every signed-in screen at 1440×900, 820×1180 and 412×915 (desktop project) and checks the page never scrolls sideways, every visible control sits inside the screen and is not cut off, and Axe finds nothing at that size. |
| Colour and theme packs | The same spec runs Axe over every screen in every theme pack other than the default (which `v19-axe-sweep.spec.ts` covers), in both layouts, after confirming the pack is the one drawn. Text size is not checked: Orbit stores the setting but no v19 screen applies it yet. |
| Feedback and recovery | `v19-feedback-recovery.spec.ts` makes things fail on purpose: a save on `/create` with no connection, a mail suggestion whose approval fails (item view and `/inbox`), a household deletion request that fails, and a document picked on `/create`. Each checks the message reaches a screen reader, focus is not dropped, and the same act works by keyboard once the fault is gone. |

Where one of these checks has found a real fault in Orbit, the test is
marked `test.fail` with the fault named in it, so it stays visible and turns
red the day the fault is fixed and the mark is still there.
Where a fault shows only sometimes on one browser, `test.fail` would pass or
fail by chance, so that check is marked `test.fixme` on that browser with the
fault named instead. Today that is the dropped-focus fault in
`v19-feedback-recovery.spec.ts` on Firefox.

Fixtures use throwaway made-up households, items, documents and mailbox
metadata. The Playwright trace is kept only on the first retry. Checks on
real devices and with real assistive technology are still part of release
acceptance and are not implied by the automated Chromium, Firefox and WebKit
evidence.

## Local development

### Requirements

- Node.js 22, the version Orbit's image runs
- pnpm, at the version `package.json` pins under `packageManager`
- PostgreSQL 18, or Docker for the database only

### Start the development stack

```sh
pnpm install
bash scripts/build-container.sh
ORBIT_IMAGE="orbit-local:$(git rev-parse --short=12 HEAD)" bash scripts/configure.sh
pnpm db:migrate
pnpm --filter orbit-web dev
```

`configure.sh` runs inside the Orbit image, so the image has to exist first:
`build-container.sh` builds it as `orbit-local:<12-character commit>`, and
`configure.sh` records that tag in `.env-orbit`. To use a published image
instead, skip the build and set `ORBIT_IMAGE` to its digest.

The last command starts the development server for the app under `web/`;
the repository root has no `dev` script of its own.

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
containers and named volumes instead of creating its own. [Local traps](#local-traps)
documents this one, and issue #536 hit it for real. The `--keep` output prints the
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
[engineering baseline](engineering-baseline.md). Playwright verifies
signed-out privacy in desktop and mobile Chromium and uses the disposable OIDC
profile for authenticated household-lifecycle acceptance. Coverage is
diagnostic while the database/API integration baseline is established; it is
not an arbitrary release percentage.

Every corpus committed to the repository is invented — real paperwork must
never be committed. If you want to know how extraction does against your own
real documents, [private local evaluation](private-eval.md) runs
entirely on your machine, against a directory you choose outside the repo,
and prints only per-field and overall scores; it structurally refuses to run
against anything inside the repository and never prints document content.

The [v1 charter](v1-charter.md) defines the supported release,
[architecture and ADRs](architecture.md) record durable system decisions,
and the [quality strategy](quality-strategy.md) defines test and CI
evidence. GitHub milestones and issues own delivery status. Product directions
outside the stable contract remain in the
[feature register](feature-register.md).

## Local harnesses

Check this list before building a test rig or handing a check to the owner.
Each script's own header holds its full usage.

| Script | What it does |
| --- | --- |
| `scripts/test-all.sh` | `test-backend.sh`, then `test-frontend.sh` (Playwright against a running instance; `ORBIT_SKIP_E2E=true` skips it). |
| `scripts/test-backend.sh` | Static analysis and the fast Vitest suite. |
| `scripts/test-frontend.sh` | Playwright against a running instance. |
| `pnpm --filter orbit-web fidelity` | The v19 visual gate: stands up the adapter-node build and the mockup host, compares 17 screens against the committed baselines. In CI it runs pinned to the Playwright image the baselines were proven against; run it locally the same way if a diff disagrees. |
| `scripts/test-integration.mjs` | Integration suite against a real database. |
| `scripts/test-e2e-local.sh` | Local stack with disposable OIDC and GreenMail sidecars, then Playwright. `--profile local-only` swaps them for an Orbit with no identity provider and runs the short list in `tests/e2e/local-only-specs.txt`, which is what CI's `smoke_local_only` runs too (#916). `--reuse PROJECT` skips the build and `compose up` and runs Playwright against a stack a prior `--keep` run left up, identified by Compose's project/service labels and health-checked first; it never tears that stack down (#947). `--ci-cap` adds the cpu/memory overlay CI's acceptance stack runs under, so a local timing measurement transfers; off by default because an uncapped stack is the faster loop (#1080). **WebKit runs on this host only inside the CI Playwright image** (`mcr.microsoft.com/playwright:v1.63.0-noble`, already pulled): the host lacks WebKit's system packages, and that is not a reason to leave the check to a pipeline. The script does this itself for any run that includes a WebKit project (#1235); `--project desktop-webkit --spec <file>` with `--reuse` runs one file in WebKit alone. A change to a WebKit-affected e2e test is run locally on both WebKit projects before it is pushed; the pipeline is the second check, not the first (owner, 2026-10-06). |
| `scripts/test-install-acceptance.sh` | Real fresh install to a healthy `/api/health`, asserting `docs/installer-guarantees.md`; OIDC discovery is a fixture, so no provider credentials are needed. |
| `scripts/test-install-bootstrap.sh` | The direct bootstrap path (not a supported install entry since ADR-0031's 2026-10-04 amendment; `get-orbit.sh` is): fetches `install.sh` over the network from a branch, pipes it to bash, and proves the channel tag resolved to the digest the registry serves right now. Real network and registry; only OIDC discovery is redirected, to the `tests/oidc` sidecar. Non-interactive path only; `--red` proves the digest assertion fires. Runs two ways (#724): weekly, via the `install_bootstrap` job in `.gitlab-ci.yml` (maintenance stage, `INSTALL_BOOTSTRAP=true`), `--red` then the green run in that one job; and green-only, via `verify_bootstrap` in `.github/workflows/publish-from-gitlab.yml`, right after that workflow's `publish` job moves GHCR's `preview` tag, the publication path that can actually invalidate what the harness asserts. |
| `scripts/test-backup-restore.sh` | Backup and restore acceptance drill. Locally run it with `--own-stack`: it builds the working tree, installs a throwaway deployment (Compose project `orbit-backup-drill`) and removes it on every exit (#1273). Needs a host with no Orbit stack and no `*orbit-db-data` volume. Without the flag it borrows the deployment `.env-orbit` names and never removes it, which is CI's path (#1241). |
| `scripts/test-repair-journeys.sh` | Live repair journeys: installs a real stack, breaks it, and proves `repair.sh` recovers it (`--list` shows which journeys are live and which are still absent). |
| `scripts/test-malware-scanner.sh` | ClamAV detection. |
| `scripts/test-secret-scan.sh` | Proves the `gitleaks` CI job's full-history scan fires: plants a synthetic secret in a throwaway `mktemp -d` git repo (never committed to Orbit) and asserts detection and redaction. |
| `scripts/test-tika-processor.mjs` | Tika document extraction. |
| `scripts/installer-simulation.sh` | Installer command centre UI, no Docker. |
| `scripts/install-test-browser.sh` | One-time headless browser download. |
| `scripts/preview-lane-preflight.sh` | Preview-lane preflight checks. |
| `scripts/validate-compose-config.sh` | Compose configuration validation. |
| `scripts/ci/*.sh` | The container validation sequence, one script per workflow step, so GitHub Actions and the GitLab pipeline run the same checks rather than two paraphrases of them (#801). Inputs are environment variables; `$GITHUB_OUTPUT` and `$GITHUB_ENV` are written only when set. |
| `scripts/acceptance-mailbox.mjs` | Mailbox acceptance record for a digest. |
| `scripts/sidecar-pins.mjs` | Sidecar pin freshness: `check` reports drift between compose and policy, a moved tag, and stale packages inside a current pin (`--offline` is the drift axis alone, `--red` proves it fires); `sync` re-pins both places after a Renovate bump. |
| `scripts/check-rolldown-jsdoc-trap.mjs` | Flags a JSDoc comment inside a `{#snippet}` parameter list, or inside a multi-line comma-separated parameter/argument list, before it reaches rolldown's own opaque parse crash on the production build (#782). `pnpm --filter orbit-web repro:782` drives the real crash against throwaway fixtures in `web/tests/rolldown-repro/` (slow, not wired into the fast suite). |
| `scripts/ci/prove-content-id.sh` | ADR-0028 section 6's proof (#1060 slice 2): three image builds showing that the same tree on two commits gives one image content ID and that a changed `src/` file gives another. By hand or as a manual job, never in an ordinary pipeline, because it builds the image three times. |
| `scripts/ci/repin-base-image.sh` | Base image freshness (#708): compares the Dockerfile pin to ai/orbit-base-image's published-digest.txt artifact and, on a mismatch, re-pins every location and opens a merge request; `--red` proves the comparison fires, `--dry-run` stops before any commit, push or merge-request call. Its header holds the job-token and Renovate arrangement. |
| `scripts/cleanup-stacks.sh` | Lists every `orbit*` Compose project on the host, marked running or stale (containers, volumes, networks, stopped and profile ones included, and networks left with no container). `--remove` tears down only stale projects and skips any with a running container, since other sessions share the host; `--project NAME --remove` removes that one even if running, `--remove --all` removes running ones too. Also removes unused `orbit-local`, `orbit-vapid-bootstrap` and `orbit-acceptance-local` images over a day old (not with `--project`). Keeps `orbit-ollama` and its model volume unless `--include-ollama`. Containers Compose did not create are listed, never removed (#1241). |
| `scripts/dev/test-bed.sh` | The demo and owner-review bed (#1241); see its header. |
| `scripts/corpus/stages-rerun.sh '<command>'` | Runs one command inside a Node container on the document-processing network, for eval runs that ask the model. See [Extraction method](extraction-method.md). |

## Local traps

Known ways to lose an afternoon, or worse. `AGENTS.md` carries each as one line;
the reasoning is here.

### A stack a script started is torn down by the same script

Stale containers are a defect, not housekeeping. Run
`bash scripts/cleanup-stacks.sh` at session end and before an acceptance run.
Plain `--remove` clears stale stacks and skips running ones (another session
may own them); a running stack you started yourself goes with
`--project NAME --remove` (#1241).

### `pnpm db:generate` refuses to run, on purpose

`drizzle/meta/` holds snapshots only up to 0004, so `drizzle-kit generate`
would diff against a stale snapshot and silently emit a migration that
recreates almost the whole schema. `scripts/db-generate-refused.mjs` is the
guard; the hand-written procedure is under "Hand-writing a migration" above.
See #535.

### Compose commands attach to whatever project `.env-orbit` names

`docker compose --env-file .env-orbit ...` with no `-p` silently adopts that
project (and its named volumes) from any checkout or worktree, and the fixed
`container_name` pins in `docker-compose.yml` then stop a second stack
coexisting instead of failing loudly. Source
`scripts/compose-isolation-preflight.sh` before an `up` you assemble by hand,
and see the isolated-stack recipe under "Quality checks" above. Fixed in the
acceptance-stack entry point by #536; still your job for a one-off manual
command.

### Never drive a pty test by closing its own stdin

`spawnSync({ input })` closes stdin as soon as the string is written, which
under `script` closes the pty master and makes the next read return EOF
instead of blocking. A widget that tells a timeout from a read error then takes
the wrong branch, and the test either races or silently never exercises what it
claims. Keep stdin open for the life of the child, as `runPty` in
`scripts/installer-simulation.test.mjs` and `runPtyInterrupted` in
`scripts/installer-ui.test.mjs` both do. Diagnosed twice: #510/#512, then #552.

### A pty driver's deadline belongs to `scripts/pty-deadline.mjs`

A child killed for running out of time has no exit status, so a driver that
hands the result to an exit-code assertion fails with `expected null to be 130`
and names the wrong fault: the child never exited at all. Take the deadline and
the failure from that module rather than writing another timer. A `spawn`-based
driver must reject rather than resolve, and its tests declare
`PTY_TEST_TIMEOUT_MS` so Vitest's 5s default does not speak first. See #595.

### A Compose `file:` secret is a bind mount of an inode, not of a path

Edit the file in place and every running container sees it at once; *replace*
it (`mktemp` + `mv`, `tar -x`, `rsync`) and each container keeps reading the
old file for as long as it keeps running. A plain `docker restart` re-resolves
the mount. Repair's rotation lands the new password by rename precisely so a
half-written secret is impossible, which left the database container reading a
spent copy and made repair diagnose its own successful rotation as failed.
Postgres itself never notices, because it reads that file once at initdb and
authenticates from its own catalogue afterwards. See #629.

### `scripts/test-backup-restore.sh` seeds its own state with SQL

Nothing else drives it. A dropped column passes every unit and integration
check and fails only the compose smoke test, so grep it before changing a
schema.

### Do not run `pnpm install` from a worktree

An install run from inside a worktree used to rewire the main checkout; this is
closed (#784, #858). `scripts/guard-worktree-install.mjs`, wired as pnpm's
`preinstall`, refuses `pnpm install` from a worktree whose `node_modules`
resolves outside itself; a worktree with its own `node_modules` installs safely
through pnpm's shared content-addressable store. `test-e2e-local.sh`'s two pnpm
calls no longer reach through the trap either. If it ever recurs,
`find node_modules web/node_modules -type l -lname '*worktrees*'` must be empty
in the main checkout; repair with `CI=true pnpm install` from the main checkout
root (it breaks other sessions' builds while it runs, so agree a window first).

### The web type check says SKIPPED in most worktrees, and that is correct

(#1029.) `web/node_modules/orbit` usually links to the main checkout, so
`orbit/server/*` would be read from whatever branch *that* has out: a wrong
answer either way, and a passing one is the dangerous half. Run it in the main
checkout or let CI answer; it is not a fault to fix.

### A red compose smoke job can be hiding the next failure

Its steps run in one job and it stops at the first, so fixing that step reveals
what was behind it rather than turning the job green. The favicon 404 hid nine
e2e failures all of 2026-09-03. Read the whole job before reporting what a
branch needs.

### Never hand-write a control-character range in a regular expression

The escapes are what break. Lose them and the intended "control characters or
backslash" collapses into a range running from space to backslash, matching most
ordinary characters: a path sanitiser then rejects every real path, or the
reverse, and no test notices unless it covers the boundary. Scan the string
explicitly instead, as `isApplicationRelative` in `web/src/lib/return-path.js`
does, and give it cases for the empty string, a protocol-relative `//` and a
backslash.

### A leftover volume of the same Compose project blocks an install

Another stack's database volume no longer does (#1239, #1261): a fresh install
is blocked only by the volume it would itself attach to, and an update whose
project name is known skips a volume labelled with another project that is not
provably its own. Two volumes that could both be this deployment's still refuse,
so a leftover volume of the *same* Compose project does too.
`scripts/cleanup-stacks.sh` lists them.

### A lockfile diff adding an `@pnpm/exe` block means the host pnpm is older than the pin

(#884, #901, #1185.) An older pnpm reads `packageManager` and hands over to the
pinned version, but first writes `@pnpm/exe` into `pnpm-lock.yaml`, even with
`--frozen-lockfile`. A correct 12.x lockfile has no such block. The owner
upgraded `/usr/local/bin/pnpm` to the pin (12.4.1) on 2026-10-07, after which
`CI=true pnpm install --frozen-lockfile` leaves `git status` clean. If the block
reappears, the pin has moved ahead of the host: discard the lockfile diff, run
`node --test scripts/lockfile-no-pnpm-exe.test.mjs` before committing a lockfile
change, and ask the owner to upgrade the host pnpm (`sudo npm install -g
pnpm@<pin>`). CI activates the pin through corepack, so it never sees this.

### Only ten fonts exist on this host, and the rest fail silently

See "Fonts" in [the corpus README](../scripts/corpus/README.md#fonts) for the
list and the reason. Check with `fc-list : family` rather than assuming a
common font is present.

### Scratch work goes in `tmp/`

`tmp/` is gitignored scratch for prototypes and the experiment-log render. The
gates deliberately skip it (`tsconfig.json`, `eslint.config.mjs`,
`vitest.config.ts`; guarded by `scripts/scratch-dir-ignored.test.mjs`), because
a prototype there is expected to rot and must not break the suite for the next
session (#995). Nothing in `tmp/` is built, shipped or imported.

### The 44px tap floor

Every tappable thing on the phone layout is at least 44x44px. The size is the
token `--p-hit` in `web/src/lib/pocket/tokens.css`; the gate is
`web/tests/fidelity/pocket-measure.spec.js` (`MIN_HIT`, #1120), which runs in
the `fidelity` job (see [the quality strategy](quality-strategy.md)).
