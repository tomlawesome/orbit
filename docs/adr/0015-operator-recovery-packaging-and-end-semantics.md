# ADR-0015: Operator recovery packaging and the meaning of "end"

**Status:** Accepted
**Date:** 2026-08-23
**Relates to:**
[ADR-0013](0013-maintenance-mode-state-and-interception.md) (maintenance mode)
decisions 4 and 5;
[ADR-0012](0012-front-end-leaves-react.md) (front end leaves React);
issue #524 (administrator control and recovery path); PR #539

## Context

ADR-0013 decision 4 requires an operator recovery path: an in-container script
under `scripts/` that calls the repository deactivation function and never
edits the database directly. PR #539 delivered the function
(`endMaintenanceFromOperatorShell` in `src/server/maintenance.ts`), but it
cannot yet be reached from a shell:

- The documented in-container operator pattern is the bundled CLI at
  `/opt/orbit/cli/orbit.js` — a single dependency-free file, invoked as a
  `docker compose run --rm --no-deps` one-off (`docs/engine-events.md`,
  `scripts/engine-check.sh`). It reaches databases by shelling out to `psql`,
  which is exactly what ADR-0013 forbids for this write.
- The domain function throws `AppError`, and `src/lib/app-error.ts` imports
  `NextResponse` from `next/server`, so bundling the function today would link
  the web framework into the operator artifact.
- That import is the **only** runtime framework edge in the function's module
  graph. `src/db` (drizzle + postgres-js, both pure JavaScript), the schema,
  the session reader, the auth primitives and the logger are framework-free,
  and every `next` import under `src/server/` is type-only.

Separately, the administrator's `endMaintenance` (#522) clears the singleton
but leaves due, unclaimed notices standing. Effective maintenance is `active`
**or** such a notice existing (ADR-0013 decision 5), so a due notice pins
maintenance on: before #525's worker exists, `end` cannot clear it at all, and
once that worker exists it would claim the stale due notice and **re-activate
maintenance up to 30 seconds after an administrator ended it**.

## Decision

### 1. Domain errors are framework-free

`AppError` and `MaintenanceActiveError` move to a new framework-free module,
`src/lib/errors.ts`. `src/lib/app-error.ts` keeps `appErrorResponse` (the Next
mapping) and re-exports both classes, so every existing import keeps working
unchanged. Domain modules that operator artifacts bundle import the classes
from `src/lib/errors.ts` directly.

### 2. The recovery command ships in the bundled CLI

`end-maintenance` joins the existing commands in `src/cli/orbit.ts`. It calls
`endMaintenanceFromOperatorShell`, reports `changed` and `cancelledNotices`,
and is idempotent — exit 0 whether or not anything changed, so an operator may
safely run it twice. It connects with the application's own driver via
`src/db`, reading `DATABASE_URL`/`POSTGRES_*` from the service environment the
one-off container already inherits — never `psql`, never secrets in argv.

`scripts/end-maintenance.sh` is the operator's entry point, wrapping the
documented one-off invocation in the `engine-check.sh` style. That satisfies
ADR-0013's "script under `scripts/`" while the logic travels inside the
already-published image; there is no second artifact to version or verify.
The database must be reachable — always true when maintenance mode is what
stands between users and the instance.

### 3. The boundary is enforced at the artifact

The bundle invocation gains `--external:next --external:next/*`, and
`scripts/bundle-orbit-cli.test.mjs` asserts the emitted bundle contains no
reference to `next`. Any future runtime framework import anywhere in the CLI's
graph then survives as a literal `require("next/...")` in the output and fails
the test. The test, not vigilance, is the enforcement — the same philosophy as
the route-contract test.

### 4. No wider domain-layer extraction now

The guard stays in `src/server/maintenance.ts`: 37 route files import
`assertOutsideMaintenance` from there and the route-contract test pins the
path. A general framework-free domain layer is not built now — Next leaves at
the #411 cut (ADR-0012), and its adapter surface is rewritten then anyway.
The standing principle this ADR sets is narrower and sufficient: domain code
reused by an operator artifact must be runtime-framework-free, and each new
operator command leans on decision 3's test rather than on a restructuring.

### 5. Ending maintenance ends effective maintenance

The administrator's `end` aligns with the operator path: in the same
transaction it cancels every due, unclaimed, uncancelled notice and clears the
singleton, and it succeeds when **either** the singleton is active **or** a
due notice is pinning maintenance on (no more `maintenance_not_active` in that
second state). It keeps the administrator contract otherwise: the expected
version is carried and a stale token still answers `409` having written
nothing, and the audit event records the cancelled-notice count.

Future, not-yet-due notices survive an `end`: a window scheduled for next week
is not cancelled by ending today's maintenance. Only the notices that would
keep the instance closed right now — or hand it back to the worker to close
again seconds later — are cancelled. This deliberately changes behaviour
delivered in #522; #524's stated outcome ("can always get back in to turn it
off") is the governing requirement.

## Consequences

- The bundled CLI stops being database-blind: `end-maintenance` carries
  drizzle-orm, postgres-js, the schema and the maintenance module into the
  bundle. It remains a single dependency-free file; it grows, and stays
  unminified and readable per the existing bundle policy.
- Existing `@/lib/app-error` imports keep working through the re-export; only
  bundled domain modules must import `src/lib/errors.ts` directly, and a
  mistake there fails decision 3's test rather than shipping.
- Tests that documented the due-notice pin on `end` now refuse it instead.
- Restore during active maintenance keeps its recovery path: the wrapper and
  the CLI are independent of stored state, as ADR-0013 requires.

## Alternatives rejected

- **`psql` from the CLI.** Forbidden by ADR-0013 decision 4 for exactly this
  write; it would bypass versioning and audit.
- **A second bundled artifact for operator domain commands.** Two artifacts to
  build, verify, document and support, with no gain over a command in the CLI
  that already ships inside the image.
- **Shipping `tsx` and source in the image.** The image deliberately ships
  only the standalone build, five scripts and the bundled CLI; adding a
  toolchain to production for an emergency path is attack and support surface
  without benefit.
- **A full domain/adapter extraction now.** Restructures a layer whose web
  adapter is replaced at the #411 cut; premature until the SvelteKit adapter
  exists.
- **Keeping `end`'s current semantics and letting #525 answer.** Post-#525,
  the worker would re-activate maintenance from a stale due notice up to 30
  seconds after an administrator ended it — baffling, and a contradiction of
  #524's outcome.
