# Testing Orbit

Orbit has separate test layers so fast feedback does not depend on Docker while
database and HTTP boundary claims use real services.

## Commands

- `pnpm test` runs the fast unit/domain suite and does not require Docker.
- `pnpm test:integration` starts one disposable digest-pinned official
  PostgreSQL 17 Alpine
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
