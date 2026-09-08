# Testing Orbit

Orbit has separate test layers so fast feedback does not depend on Docker while
database and HTTP boundary claims use real services.

## Commands

- `pnpm test` runs the fast unit/domain suite and does not require Docker.
- `pnpm test:integration` starts one disposable digest-pinned official
  PostgreSQL 18 Alpine
  container on a random loopback port, applies every migration, runs the
  PostgreSQL/API integration suite, and removes that exact container on success,
  failure or interruption.
- `pnpm test:e2e` runs browser tests against an already-running application.
- `pnpm test:coverage` produces diagnostic V8 coverage for the fast suite.

The integration command requires Docker to be running and does not use the
developer Orbit database, containers or volumes. Every invocation generates a
unique container, database name, user and fake password, so repeated and
concurrent runs cannot share state. Test fixtures use only `example.invalid`
identities and synthetic records. They never contact an OIDC provider and do
not add an authentication bypass.

## Integration fixture contract

Integration fixtures create only the records a test needs using the real
PostgreSQL schema: users, preferences, external identities, sessions,
households, owner/member memberships, sections, items and visible document
metadata. Sessions are created through the production session implementation;
tests use the production cookie name and CSRF derivation. Route tests invoke
the actual Next.js route functions with `NextRequest`, not a development
server or mocked authorization boundary.

The initial examples cover a persisted `household.update` workspace mutation,
CSRF rejection before mutation, and household-scoped document listing with a
non-disclosing outsider response. Uploading, parsing, scanning and encrypting
document bytes belong to higher test layers.

The PostgreSQL integration layer also contains a persisted authorization matrix
covering malformed, expired and disabled sessions; live membership removal;
workspace, household and lifecycle routes; document list/download/delete/
restore denial; portable archive ownership and non-disclosure; and administrator
operations. Denied requests assert bounded error contracts, `no-store` responses,
unchanged target state and unchanged audit state where mutation is applicable.

## Hand-writing a migration

`pnpm db:generate` is refused (`scripts/db-generate-refused.mjs`, #535):
`drizzle/meta/` only has snapshots through 0004, so `drizzle-kit generate`
would diff against that stale snapshot and silently emit a migration that
recreates almost the whole schema. Write migrations by hand instead:

1. Create `drizzle/NNNN_name.sql`, where `NNNN` is the next number after the
   last journal entry, in the style of `drizzle/0027_instance_authority.sql`:
   plain DDL, `--> statement-breakpoint` between statements, and a `DO $$ ...
   END $$` block only where existing data needs a deliberate, auditable
   transformation (0027 seats a primary administrator; failing closed on an
   ambiguous case beats guessing).
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
   - Everything here is asserted verbatim against `readSchemaContract` in
     `tests/integration/migrations.test.ts`, so a mismatch (in either
     direction) fails that test rather than passing silently.
4. Update `tests/integration/migrations.test.ts` if the migration has
   behaviour beyond the schema diff: a migration that seeds or transforms data
   unconditionally (as 0028 and 0033 do for their singleton tables) needs an
   assertion on that seeded state in the "migrates every current migration
   into a fresh PostgreSQL 18 database" test, and a migration that can fail on
   existing data (as 0022 does) needs its own scenario, following the
   `document_openable_scan_status_valid` test below it.

`tests/integration/fixtures/migration-baseline.json` freezes the supported
upgrade starting point (`migrationPrefix`, currently through 0017) and is not
touched by an ordinary new migration.

## CI relationship

Pull requests run planning governance, lint, type checking and the complete unit
suite. Separate read-only workflows retain dependency-diff and CodeQL evidence.
They do not run a production build, PostgreSQL integration, source secret scan
or container build. Every push to protected `preview` (or a bounded
`hotfix/**` source) runs the complete source-policy, PostgreSQL, exact-image,
browser, security, recovery, installer and publication path. A pull request to
`main` verifies the already-tested preview digest, embedded identity and
attestations without rebuilding it.

When selected, the two concurrent integration invocations prove that
independent runs do not share PostgreSQL state or Docker resources. The command
remains reusable as a single isolated run during local development.

If Docker is unavailable, the command fails clearly. If a run is interrupted,
inspect only the uniquely named `orbit-integration-*` container reported by the
run; do not use broad Docker prune or delete commands.

## Authenticated accessibility acceptance

The exact-image browser job runs `authenticated-accessibility.spec.ts` against
the production container with the disposable OIDC profile. The automated
matrix is deliberately representative rather than device certification:

| Contract | Automated evidence |
| --- | --- |
| WCAG A/AA | Axe on the authenticated dashboard/navigation, item editor and detail, document draft review, notifications, personalisation, mailbox review and administrator surfaces |
| Keyboard and focus | Initial focus, tab containment, Escape dismissal, visible focus and return to desktop and mobile invoking controls; nested camera review is pointer-shielded |
| Responsive layout | Chromium at 1440×900, 820×1180 and 412×915 with document and core-overlay overflow/bounds assertions |
| Text and colour | Every Orbit text-size setting on every tested viewport, plus representative light, dark and system modes across After Dark, Verdant and Coast |
| Feedback and recovery | Authenticated lifecycle, document-assisted item, IMAP review and online-workspace-policy journeys cover success, validation/conflict, provider failure and failed online mutation announcements |

Fixtures use disposable synthetic households, items, documents and mailbox
metadata. The acceptance spec does not create screenshots; the standard
Playwright trace is retained only on the first retry. Representative physical
device and assistive-technology checks remain release acceptance and are not
implied by the automated Chromium evidence.
