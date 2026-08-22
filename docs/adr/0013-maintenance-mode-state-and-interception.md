# ADR-0013: Maintenance mode state, interception and 503 semantics

**Status:** Accepted
**Date:** 2026-08-22
**Relates to:** issue #235 (maintenance mode);
[ADR-0001](0001-self-hosted-single-instance.md) (single instance, PostgreSQL
as the only coordinator);
[ADR-0004](0004-supported-upgrades-and-recoverable-restore.md) (restore is a
stopped-application protocol);
[ADR-0012](0012-front-end-leaves-react.md) (two frameworks until the cut);
#263 (instance authority singleton)

## Context

An administrator must be able to put Orbit into maintenance: block user-facing
access, publish a bounded message, and schedule future notices. The state must
survive restarts and be correct across more than one application process.
Maintenance presentation is never the authorization boundary — every existing
session, CSRF, household and administrator check stays exactly as it is.

Three existing facts shape the design. First, `instance_authority` (#263) is
the established shape for one row of instance-wide state: a boolean singleton
primary key with a `CHECK` constraint. Second, the request surface is in
transition: Next.js serves the product and the API routes today, the SvelteKit
front end in `web/` — which already contains the ratified v19 maintenance
screen at `web/src/routes/maintenance/` — takes over at the #411 cut, and
there is no `src/middleware.ts`. Third, nothing in Orbit caches authority
state: `readSession` reads the database on every request, and recurring work
is coordinated through PostgreSQL claims.

## Decision

### 1. Persistent state and versioning

Two tables, migrated in house style under `drizzle/`.

`instance_maintenance` follows the `instance_authority` singleton precedent:
`singleton boolean PRIMARY KEY DEFAULT true` with `CHECK ("singleton")`, plus
a stable `id uuid NOT NULL DEFAULT gen_random_uuid()` solely to satisfy
`audit_log.entity_id`. Columns: `active boolean NOT NULL DEFAULT false`,
`message text` with `CHECK (message IS NULL OR char_length(message) <= 500)`,
`message_published_at timestamptz`, `expected_end_at timestamptz`,
`activated_at timestamptz`, `version bigint NOT NULL DEFAULT 1`, `updated_at
timestamptz NOT NULL DEFAULT now()`. Unlike `instance_authority` it has no
foreign key, so the migration seeds the inactive row unconditionally; the
guard read is always a plain primary-key lookup.

`maintenance_notices` holds scheduled future notices: `id uuid PRIMARY KEY`,
`message text` (same length check), `starts_at timestamptz NOT NULL`,
`expected_end_at timestamptz`, `activated_at timestamptz`, `cancelled_at
timestamptz`, `created_at timestamptz NOT NULL DEFAULT now()`, and a partial
index on `starts_at` where `activated_at IS NULL AND cancelled_at IS NULL`.
All times are stored UTC (`timestamptz`) and rendered in the viewer's locale.
Display ordering is `starts_at ASC, id ASC` — deterministic, no tiebreak
ambiguity. Cancellation sets `cancelled_at`; rows are retained, not deleted.
The application additionally enforces at most 8 lines and no control
characters in messages, and at most 12 pending notices.

`version` is the expected-current-state token, and it versions the **whole**
maintenance configuration — singleton and notices together. Every
administrator mutation (activate, edit, schedule, cancel, end) carries the
version it read, and executes as one transaction whose singleton update is
`... SET version = version + 1 WHERE singleton AND version = $expected`. Zero
rows updated means the state moved underneath the administrator: the
transaction rolls back, the API returns `409 maintenance_state_stale`, and no
audit event is written — a stale write never produces a misleading audit
success. Successful mutations insert an `audit_log` row in the same
transaction (`entity_type` `instance_maintenance`, entity id as above, or the
notice id for notice events) with actor, prior/new state and timestamps.
Message text may appear in audit `changes` — it is instance state, visible to
administrators anyway — but ordinary structured logs record only lengths and
booleans, never the text.

### 2. Request interception boundary

One domain module, `src/server/maintenance.ts`, owns the effective-state read
and the guard decision. The guard rule is: a request passes if maintenance is
not effectively active, or if it carries a valid session whose user is an
active instance administrator. The read is uncached and per-request, matching
the session precedent — a primary-key row read plus a partial-index probe
(see decision 5) is the entire cost.

Enforcement binds to **route identity, not URL strings**. Every API route file
under `src/app/api/**/route.ts` calls the guard first, the same way routes
call `requireSession` today. A repository-wide route-contract test
(precedent: `src/app/api/auth/route-contract.test.ts`) enumerates every route
file and fails if a file neither invokes the guard nor appears in the exact
exemption set of decision 3. A new route is therefore guarded by default; the
test, not vigilance, is the enforcement.

Blocked API requests receive a bounded `503` with body
`{"error":"maintenance_active"}`, `Cache-Control: no-store`, and a
`Retry-After` header derived from `expected_end_at` when it is in the future.
The body never carries the message or configuration. Blocked page requests
receive the maintenance page, also with status `503` and `no-store`, and no
private workspace data is rendered or cached behind it. The page layer is
presentation only: even if only the page shell changed, no mutation can slip
through, because the API guard is independent.

Next middleware is rejected as the boundary: it matches URL path strings (the
exact class of normalization and prefix bugs the allowlist must exclude), its
default runtime cannot hold the PostgreSQL connection the state read needs,
and Next itself is leaving (ADR-0012). After the cut, SvelteKit's
`hooks.server.ts` `handle` becomes the single choke point — one function that
sees every request — calling the same domain module unchanged and serving the
already-built `/maintenance` screen.

### 3. Exempt-route allowlist

The exemption set is an exact list of route files. There is no pattern, no
prefix, and no URL comparison anywhere in the mechanism — exemption is
membership of a file set verified by the contract test — so a prefix bypass
is not merely disallowed, it has no place to exist. Static assets never reach
the guard at all: the guard binds to route modules, and asset serving is
outside them.

The exempt routes:

- `src/app/api/health/route.ts` — orchestrators must keep probing
  (decision 6).
- `src/app/api/auth/login/route.ts` — an administrator must be able to begin
  OIDC sign-in while maintenance is active.
- `src/app/api/auth/callback/route.ts` — and complete it.
- `src/app/api/auth/session/route.ts` — the client must read who it is and
  obtain the CSRF token before it can route an administrator to the control.
- `src/app/api/auth/logout/route.ts` — anyone may end a session cleanly;
  refusing sign-out serves nobody.

Plus the signed-out sign-in page, which reads no data (ADR-0012 prerendered it
static) and is the door the administrator walks through.

Deliberately **not** exempt: `session/refresh` and `sessions/revoke`
(administrators pass via the principal rule; a non-administrator's blocked
rotation fails safe — the existing token simply remains valid until expiry),
and the new maintenance administration API. That last one needs no path
exemption because administrators pass the guard everywhere; a
non-administrator probing it receives the same generic `503` as any other
path, so the control is neither discoverable nor invocable from outside.

### 4. Administrator recovery path

An administrator recovers through the front door. The sign-in page, `login`,
`callback` and `session` are exempt, so OIDC authentication works exactly as
normal while maintenance is active. Once authenticated, the instance-admin
principal passes the guard on every route: the administrator sees the real
application with a persistent maintenance banner, and reaches the maintenance
control under the existing admin surface. `requireInstanceAdministrator`,
same-origin and CSRF checks apply unchanged — the exempted `session` route is
what supplies the CSRF token. Non-administrators who sign in during
maintenance authenticate successfully and then receive the maintenance page
like everyone else.

If OIDC itself is down, the documented emergency path is an in-container
script under `scripts/` that calls the same repository deactivation function:
versioned write, audit event with `actor_user_id` null and
`changes: {"origin": "operator_shell"}`. Direct database editing is never the
procedure. Because the exemptions and the script are independent of the stored
state, restoring a backup that was taken in active maintenance retains this
recovery path.

### 5. Scheduled activation: lease and idempotency contract

Effective maintenance state is `active` **or** the existence of a due,
unclaimed, uncancelled notice (`starts_at <= now()`, `activated_at IS NULL`,
`cancelled_at IS NULL`, via the partial index). Activation therefore takes
effect at the scheduled instant on every process simultaneously, regardless of
worker timing or restarts — the clock, not a tick, is the trigger.

A maintenance worker tick (in-process interval started from
`instrumentation-node.ts` like the other workers, every 30 seconds) performs
the durable transition in **one transaction**: claim the due notice with
`UPDATE maintenance_notices SET activated_at = now() WHERE id = $1 AND
activated_at IS NULL AND cancelled_at IS NULL AND starts_at <= now()`; if zero
rows, another process already did it — stop, no duplicate audit. If the claim
succeeds, copy the notice's message and times into the singleton, set
`active = true`, increment `version`, and insert one audit event
(`maintenance_activated_scheduled`, actor null, notice id). The house worker
invariant of an owner token and expiry exists for long-running claims; here
the claim and the completion are the same transaction, so a crash before
commit leaves nothing durable and the next tick retries, and duplicate workers
are excluded by the conditional update alone. The worker does not use
`expected version`: its authority is the notice claim, and a concurrent
administrator edit either serializes behind the row locks or finds its own
token stale and re-reads.

### 6. Public health semantics

`/api/health` keeps its real dependency check and never hides genuine failure.
With the database reachable and maintenance active it returns **HTTP 200**
with `{"status": "maintenance", "service": "orbit", ...}` — the process is
healthy and must not be restarted, and traffic should keep routing to it so
people reach the maintenance page. With the database unreachable it returns
`503 degraded` exactly as today, maintenance or not. The body remains
content-free: no message, no schedule, no configuration, no version.
Orchestrators stay calm because the only thing that returns non-200 is the
only thing a restart could plausibly help.

### 7. Background workers

All workers continue during user-facing maintenance: the notification worker,
the document worker (scan recovery, purge backlog, reconciliation), the IMAP
receipt worker, and the new maintenance tick. The database is up and
authoritative; every worker already carries its own lease and expected-state
safety; and stopping them would build mail and delivery backlog and could push
leased recovery work past hard deadlines such as the 24-hour scan recovery
expiry (ADR-0010). Maintenance mode is explicitly not a quiesce mechanism —
the operation that needs a quiet system is restore, and ADR-0004 already stops
the whole application for it. Pretending maintenance provides that guarantee
while workers hold leases would be a false promise; refusing to pretend is the
safety reasoning. One visible consequence is accepted: a notification sent
during the window may lead a user to the maintenance page, which is the
correct experience. Startup, backup, restore and migration flows do not
auto-enter maintenance; the tables travel in backups like any others.

## Consequences

- Every guarded request pays one singleton read and one partial-index probe,
  uncached by design. At single-instance scale this matches the existing
  per-request session read and is accepted.
- Until the ADR-0012 cut, enforcement is a guard call per route file held
  honest by the route-contract test; after the cut it collapses into one
  `handle` hook calling the same module. The domain module survives the cut
  unchanged.
- The ratified v19 totality screen is the product maintenance experience and
  it lives in `web/`. Before the cut, blocked page requests on the Next
  surface receive a minimal bounded shell, not the artwork — a named cost,
  since retyping the screen into React is exactly what ADR-0012 forbids.
- Administrators can mutate data while maintenance is active. That is the
  point — the operator is working — but it means maintenance never implies
  "nothing changed during the window".
- One migration adds two tables; restore into active maintenance is safe
  because recovery depends on exempt routes and the operator script, not on
  the stored state.

Implementation slices, in order: (1) migration, schema and the
`src/server/maintenance.ts` domain module with versioned mutations and audit,
tested for stale tokens and restart persistence; (2) the guard, 503 semantics,
exact exemption set and the repository-wide route-contract test, plus the
health change, all negative-tested; (3) the administrator API and control UI,
the recovery drill and the emergency script; (4) scheduled notices, the worker
tick and duplicate-worker tests; (5) page presentation — the interim shell on
Next, and the `hooks.server.ts` wiring of the built `/maintenance` screen with
Playwright/axe evidence, landing with #411's cut.

## Alternatives rejected

- **An environment variable or process flag.** Not persistent, not shared
  across processes, and invisible to audit.
- **Next middleware as the boundary.** URL-string matching reintroduces the
  prefix-bypass bug class, the edge runtime cannot read the database, and the
  framework is being removed.
- **A cached maintenance flag with a TTL.** A stale window across processes
  for a feature whose whole job is an instance-wide truth; the codebase's
  session precedent is deliberately uncached.
- **A lease table with owner and expiry for scheduled activation.** Leases
  earn their complexity on long-running work; a single-transaction claim is
  strictly safer here.
- **A path exemption for the maintenance administration API.** It would make
  the control discoverable by probing; the principal rule covers
  administrators without revealing anything.
- **Stopping background workers during maintenance.** Creates backlog, risks
  blowing recovery deadlines, and sells a quiesce guarantee that only the
  ADR-0004 stopped-application protocol actually provides.
