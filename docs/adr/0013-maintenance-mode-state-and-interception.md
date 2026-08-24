# ADR-0013: Maintenance mode state, interception and 503 semantics

**Status:** Accepted
**Date:** 2026-08-22
**Relates to:** issue #235 (maintenance mode);
[ADR-0001](0001-self-hosted-single-instance.md) (single instance, PostgreSQL
as the only coordinator);
[ADR-0004](0004-supported-upgrades-and-recoverable-restore.md) (restore is a
stopped-application protocol);
[ADR-0012](0012-front-end-leaves-react.md) (two frameworks until the cut);
#263 (instance authority singleton);
#580 (window/update data model, ratified 2026-08-23)

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

Three tables, migrated in house style under `drizzle/` — the slimmed
`instance_maintenance` singleton, and two new tables, `maintenance_windows` and
`maintenance_updates`, that separate closure state from narrative (amended
2026-08-23, see Amendments).

`instance_maintenance` is slimmed to the guard's closure record and concurrency
token. It keeps `singleton boolean PRIMARY KEY DEFAULT true` with `CHECK
("singleton")`, the stable `id uuid NOT NULL DEFAULT gen_random_uuid()` for
`audit_log.entity_id`, `active boolean NOT NULL DEFAULT false`,
`expected_end_at timestamptz`, `version bigint NOT NULL DEFAULT 1`, and
`updated_at timestamptz NOT NULL DEFAULT now()`. It gains `current_window_id
uuid REFERENCES maintenance_windows(id)` and drops `message`,
`message_published_at` and `activated_at` — that narrative now lives in
`maintenance_updates`, and `started_at` moves to the window. Unlike
`instance_authority` it has no foreign key of its own, so the migration seeds
the inactive row unconditionally; the guard read is always a plain primary-key
lookup.

`maintenance_windows` holds one row per maintenance episode, covering all three
tenses at once: `id uuid PRIMARY KEY`, `status text NOT NULL CHECK (status IN
('scheduled', 'open', 'resolved', 'cancelled', 'absorbed'))`,
`scheduled_start_at timestamptz` (null when opened immediately), `started_at
timestamptz`, `expected_end_at timestamptz`, `ended_at timestamptz`,
`cancelled_at timestamptz`, `absorbed_into_id uuid REFERENCES
maintenance_windows(id)`, `created_at timestamptz NOT NULL DEFAULT now()`,
`updated_at timestamptz NOT NULL DEFAULT now()`. All times are stored UTC
(`timestamptz`) and rendered in the viewer's locale, as before. A partial
unique index permits at most one `open` window at a time. A partial index on
`scheduled_start_at WHERE status = 'scheduled'` serves the effective-state
probe exactly as the retired notice index did.

`maintenance_updates` holds the ordered entries within a window: `id uuid
PRIMARY KEY`, `window_id uuid NOT NULL REFERENCES maintenance_windows(id) ON
DELETE CASCADE`, `kind text NOT NULL CHECK (kind IN ('scheduled', 'started',
'update', 'resolved'))`, `body text NOT NULL` under the same rules the retired
singleton message enforced (`CHECK (char_length(body) <= 500)`, plus the
application's existing 8-line and no-control-character checks), `published_at
timestamptz NOT NULL DEFAULT now()`, `created_at timestamptz NOT NULL DEFAULT
now()`, `edited_at timestamptz`. Display ordering is `published_at ASC, id ASC`
— the same deterministic tiebreak the retired notice index used.

`instance_maintenance.expected_end_at` is denormalised from the open window's
`expected_end_at`, written in the same transaction as any change to the window,
so the guard's per-request read stays a single primary-key lookup; the window
row is the source of truth, and an invariant test holds the two equal whenever
a window is open.

`version` continues to version the **whole** maintenance configuration —
singleton, windows and updates together — so the 409 `maintenance_state_stale`
contract below is unchanged by this amendment. Every administrator mutation
carries the version it read, and executes as one transaction whose singleton
update is `... SET version = version + 1 WHERE singleton AND version =
$expected`. Zero rows updated means the state moved underneath the
administrator: the transaction rolls back, the API returns `409
maintenance_state_stale`, and no audit event is written — a stale write never
produces a misleading audit success. Successful mutations insert an `audit_log`
row in the same transaction (`entity_type` `instance_maintenance` for
singleton-level changes, or `maintenance_window` with the window id for window
opened/updated/resolved/absorbed events) with actor, prior/new state and
timestamps. Update text may appear in audit `changes` — it is instance state,
visible to administrators anyway — but ordinary structured logs record only
lengths and booleans, never the text.

`maintenance_notices` is retired outright, along with the 12-pending-notice cap
and every "which message wins" arbitration: both defended a queue that does not
occur now that a due scheduled window is absorbed into an open one (decision 5)
rather than competing with it.

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

Effective maintenance state is `active` **or** the existence of a due
scheduled window (`status = 'scheduled'`, `scheduled_start_at <= now()`, via
the partial index — the status alone carries what the retired notice model
spelled out as unclaimed and uncancelled). Activation therefore takes
effect at the scheduled instant on every process simultaneously, regardless of
worker timing or restarts — the clock, not a tick, is the trigger.

A maintenance worker tick (in-process interval started from
`instrumentation-node.ts` like the other workers, every 30 seconds) performs
the durable transition in **one transaction**. It takes the singleton row lock
every administrator mutation already takes, which serialises it against a
concurrent edit and against a second worker, and reads whether a window is
currently open. It then claims the due window conditionally — `UPDATE
maintenance_windows SET status = $2, started_at = $3 WHERE id = $1 AND status =
'scheduled' AND scheduled_start_at <= now()`; if zero rows, another process
already did it — stop, no duplicate audit. Whether `$2` is `open` or `absorbed`
follows from that read (amended 2026-08-23, see Amendments, following #580's
ratified absorb rule and the #525 finding that motivated it).

If no window is open, the claimed window opens: `started_at` is set, a
`started` entry is appended to its timeline — its original `scheduled` entry is
retained, because decision 8 makes an entry's `kind` immutable —
`instance_maintenance` is updated to `active = true` with `current_window_id`
set and `expected_end_at` denormalised from it, `version` is incremented, and
one audit event is inserted (`maintenance_activated_scheduled`, actor null,
window id): the same shape as before, notice replaced by window.

If a window is already open, the due window is **absorbed** rather than opened:
it moves to `absorbed` with `absorbed_into_id` set to the open window's id and
`started_at` left null, its text is appended to the open window as an `update`
entry, and the open window's `expected_end_at` becomes the later of the two —
never the earlier. `expected_end_at` does not shorten automatically under any
circumstance; an administrator's stated `Retry-After` is never silently cut
short by a scheduled window coming due. `version` is incremented and one audit
event records the absorption (`maintenance_window_absorbed`, actor null, the
open window's id). Because an absorbed window never enters `open`, the partial
unique index on open windows is never even momentarily contended.

Either way, the claim and the completion are the same transaction, so a crash
before commit leaves nothing durable and the next tick retries; duplicate
workers are excluded by the conditional claim, and the singleton row lock keeps
the open-window read consistent with it. The house worker invariant of an owner
token and expiry exists for long-running claims and is not needed here. The
worker does not use `expected version`: its authority is the window claim, and
a concurrent administrator edit either serializes behind the row locks or finds
its own token stale and re-reads.

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

### 8. Editability and the timeline/audit boundary

This decision was added 2026-08-23 (see Amendments); the model it governs is
decision 1's.

An update's `published_at`, `kind` and `window_id` are immutable, as are the
system-set `started_at` and `ended_at` on a window. Re-dating an entry, or
re-stating what kind of entry it was, would falsify the narrative it exists to
record.

An update's `body` is editable, recording `edited_at`, with the prior text
preserved in the audit row — a public message with a typo in it should be
fixable without pretending it was never wrong. The open window's
`expected_end_at` is editable too: revising the estimate is the single most
common action an operator takes in a real window.

Nothing is ever deleted. A wrong entry is corrected by editing it or by a
following entry, matching the existing retain-rather-than-delete treatment of
cancelled notices. Scheduled windows may be rescheduled or cancelled only
before they open; once open, neither.

**The timeline is not the audit log.** The audit log stays private, append-only
and administrative, exactly as decision 1 describes. The timeline is public and
editable product surface: it is what a blocked user reads, and it is allowed to
be corrected the way any published copy is. The two are easy to conflate and
are stated separately on purpose.

Presentation is fixed here as constraints, not layout: newest entry first; only
the open window's entries are shown, never a resolved or scheduled one; the
screen must read well with exactly one entry, the overwhelmingly common case;
no private data reaches the body; the `503` status and `no-store` header are
unchanged from decision 2. The visual design itself belongs to #526's mockup
rounds, not to this ADR — the ratified v19 screen is deliberately minimal
artwork, and a rolling timeline is in genuine tension with that; this ADR fixes
only what the timeline must satisfy, not how it looks.

Resolved windows are retained in the database indefinitely — the rows are tiny,
they travel in backups, and they are the operator's own record — but are never
displayed: the maintenance screen is served only while the instance is closed,
so a resolved window has no audience. There is no public status-history surface
and no pruning job; both remain available to propose later, and neither is
needed for this decision.

## Consequences

- Every guarded request pays one singleton read and one partial-index probe,
  uncached by design. At single-instance scale this matches the existing
  per-request session read and is accepted.
- Until the ADR-0012 cut, enforcement is a guard call per route file held
  honest by the route-contract test; after the cut it collapses into one
  `handle` hook calling the same module. The domain module survives the cut
  unchanged.
- The ratified v19 totality screen is the product maintenance experience and
  it lives in `web/`. This originally accepted a named cost: before the cut,
  blocked page requests on the Next surface would receive a minimal bounded
  shell rather than the artwork, since retyping the screen into React is
  exactly what ADR-0012 forbids. That shell was dropped on 2026-08-24 (see
  Amendments) — it would never have served a real request, and no enforcement
  depends on it, because decision 2 makes the page layer presentation only
  and the API guard independent.
- Administrators can mutate data while maintenance is active. That is the
  point — the operator is working — but it means maintenance never implies
  "nothing changed during the window".
- The original migration adds `instance_maintenance` and
  `maintenance_notices`; a second migration (amended 2026-08-23, see
  Amendments) adds `maintenance_windows` and `maintenance_updates`, alters
  `instance_maintenance` to the slimmed shape in decision 1, and drops
  `maintenance_notices`. Restore into active maintenance is safe either way,
  because recovery depends on exempt routes and the operator script, not on
  the stored state.

Implementation slices, in order: (1) migration, schema and the
`src/server/maintenance.ts` domain module with versioned mutations and audit,
tested for stale tokens and restart persistence; (2) the guard, 503 semantics,
exact exemption set and the repository-wide route-contract test, plus the
health change, all negative-tested; (3) the administrator API and control UI,
the recovery drill and the emergency script; (4) scheduled notices, the worker
tick and duplicate-worker tests; (5) the window/update data model (decisions
1, 5 and 8, amended 2026-08-23): its migration, the absorb-on-collision worker
path, the editability rules and the new audit actions, with their own
stale-token, restart-persistence and duplicate-worker tests; (6) page
presentation — the `hooks.server.ts` wiring of the built `/maintenance`
screen with Playwright/axe evidence, landing with #411's cut and consuming
the timeline built in (5). The interim Next shell this slice originally
carried was dropped on 2026-08-24; see Amendments.

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
- **A single overwritable current message (the original decision 1).** Every
  administrator action and every scheduled activation overwrote whatever was
  published before it; there was no way to say "we are running late, here is
  why" as a follow-on rather than a replacement.
- **Arbitrating which message wins when a scheduled notice comes due during
  active maintenance.** #525 showed the failure mode directly: a scheduled
  notice activating mid-window could silently shorten an operator's stated
  `Retry-After`. Absorbing the notice into the open window, rather than
  picking a winner, removes the arbitration question instead of answering it.
- **A bounded pending-notice queue.** The 12-notice cap and its arbitration
  existed to defend against contention that does not occur in practice;
  retiring `maintenance_notices` for the window/update model removes the
  queue they were defending.

## Amendments

**2026-08-24 — the interim Next shell is dropped (issue #526).** Consequences
and slice (6) accepted a named cost: until the ADR-0012 cut, blocked page
requests on the Next surface would receive a minimal bounded shell instead of
the artwork. It was never going to be reached. Maintenance mode becomes
available to an operator at v1.3, v1.3 requires milestone M2 (#547), and M2
contains #411 — so the cut precedes any release in which maintenance can be
turned on, and the shell would have served no real request. Nothing is
weakened by removing it: decision 2 makes the page layer presentation only
and keeps the API guard independent, so a blocked page before the cut is
merely unstyled, never permissive. Slice (6) is now the `hooks.server.ts`
wiring alone.

**2026-08-23 — window/update data model, absorb-on-collision and timeline
editability (issue #580).** Decisions 1 and 5 originally modelled maintenance
narrative as a single overwritable message on the `instance_maintenance`
singleton, with a bounded queue of future notices waiting to become that
message. The singleton held **the** current message, so every administrator
action and every scheduled activation overwrote the previous one: there was no
way to publish "we are running late, here is why" as a follow-on rather than a
replacement. #525 surfaced the sharper failure: a scheduled notice coming due
during active maintenance silently shortened an operator's stated
`Retry-After`, because activation copied the notice over the singleton with no
arbitration against what was already published. Decision 1 is rewritten for
the `maintenance_windows`/`maintenance_updates` model that separates closure
state from narrative; decision 5's worker mechanism now absorbs a due window
into an already-open one instead of overwriting it, with `expected_end_at`
never shortening automatically; and decision 8 is added to fix the
editability boundary and the public-timeline/private-audit split that the new
model makes possible. Decisions 2, 3, 4, 6 and 7 are unaffected. Full trail on
issue #580.
