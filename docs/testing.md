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
  that build. The browser suite is two jobs side by side: `smoke` runs it in
  Chromium and `smoke_firefox` in Firefox. With Firefox inside `smoke`, that
  one job took 29.9 of its 30 minutes, so it has its own (#1183).

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

The `smoke` and `smoke_firefox` jobs run the Playwright suite in `tests/e2e/`
against the production container just built, with the throwaway OIDC
profile. The suite has three browser projects: desktop Chromium and mobile
Chromium (a Pixel 7 profile) in `smoke`, and desktop Firefox in
`smoke_firefox`. The two Chromium projects cover both of Orbit's layouts, and
Firefox repeats the desktop layout on a second browser engine (#1183). WebKit
is not run yet. The maintenance-window spec runs once per project, after the
rest, one project at a time. Locally, `scripts/test-e2e-local.sh` runs all
three unless told otherwise; `ORBIT_E2E_ENGINES=chromium` or `=firefox` picks
one engine the way the two jobs do. The automated checks are deliberately
representative, not device certification:

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
acceptance and are not implied by the automated Chromium and Firefox evidence.
