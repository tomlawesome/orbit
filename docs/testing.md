# Testing Orbit

Orbit has separate test layers so fast feedback does not depend on Docker while
database and HTTP boundary claims use real services.

## Commands

- `pnpm test` runs the fast unit/domain suite and does not require Docker.
- `pnpm test:integration` starts one disposable official `postgres:17-alpine`
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

CI runs two `pnpm test:integration` invocations concurrently after static/unit
checks and before the production-image build. This proves that independent
runs do not share PostgreSQL state or Docker resources. The command remains
reusable as a single isolated run during local development.

If Docker is unavailable, the command fails clearly. If a run is interrupted,
inspect only the uniquely named `orbit-integration-*` container reported by the
run; do not use broad Docker prune or delete commands.
