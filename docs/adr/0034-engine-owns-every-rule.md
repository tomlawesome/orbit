# ADR-0034: The engine owns every rule; the browser sends intent and shows refusals

**Status:** Accepted
**Date:** 2026-10-08
**Relates to:** [ADR-0018](0018-engine-library-and-adapter-node-packaging.md)
(one process, one origin, which this keeps); issues #1324, #1325

## Context

Orbit is one repository and one process (ADR-0018), but it is meant to be two
distinct parts: an engine (`src/`) and a front end (`web/`). The browser never
imports engine code and talks to it only over the JSON API, so the seam is
real. What crosses it today is not only intent but rules.

An inventory on 2026-10-08 (#1325) found the browser deciding:

- **What state a change produces.** The next due date after a completion
  (`nextDateAfter`, copied again in `editing/calendar.js`); which schedule kind
  and subtype a chosen kind means (`scheduleOf`); which activity kind a
  completion or a status change records; that a new item is `active`.
- **Whether a change is allowed.** The "not yet —" refusals for a new or
  edited item (`refusalOf`, `editsOf`); that a snooze must land after today;
  the cost's format.

For most of these the engine enforces a weaker rule or none: it stores
whatever `nextDate`, `subtype` and `snoozedUntil` it is given, and a
completion sent without a next date silently stops the item repeating. Any
client other than this web app would have to copy the browser's maths and
wording exactly, and the two copies already drift.

The owner's position (2026-10-08): no rules should live in the browser.

## Decision

The standard pattern: **the server is the single authority; the client sends
intent and shows refusals.**

1. **A rule lives only in `src/`.** A rule is anything that decides whether a
   change is allowed, or what state results from it. Presentation — wording
   of dates, the corridor's bands and colours, sort order, what a row offers
   to choose from — stays in the browser.
2. **Commands carry intent, never derived state.** `item.complete` carries
   the completed date, cost and notes; the engine computes the next due date
   from the item's stored period (month-end clamp, as today's maths) in the
   transaction that records the completion, and refuses a next date sent by
   a client. `item.upsert` carries the kind the member chose; the engine maps
   it to schedule kind and subtype. A snooze carries the date; the engine
   refuses today or earlier. Status transitions and activity kinds are the
   engine's.
3. **Instant feedback uses the same rules, not a copy.** The command endpoint
   takes `dryRun: true` (the standard validate / preflight call): it runs the
   command through the same schema and checks, returns the refusal or an
   empty success, and writes nothing. The browser sends a debounced dry run
   as the member types and shows the answer where it shows refusals today.

   *Amended 2026-10-09 (#1325, MR !1047):* a dry run is a question, so its
   HTTP status says whether the question was answered and the body carries
   the answer: `200 {}` when the save would go through, `200 {"refusal":
   {"code","message"}}` when the engine would refuse it — the same code and
   words the real call puts in its `error` envelope, whose 4xx is unchanged.
   Only a dry run that could not be heard (maintenance, no session, a stale
   CSRF token, a fault) answers with a status. This is the validate-as-a-query
   pattern (a form's `checkValidity()`, a linter's report: the verdict is a
   successful answer). The alternative — Kubernetes-style `dryRun`, answering
   with the real call's status — suits a tool rehearsing one save; asked at
   every pause while a member types, it has every browser log each expected
   "not yet" as a failed request, so the console stops being a signal and the
   fidelity gate's "no console errors" check cannot hold.
4. **Refusals are worded once, in the engine**, in the member's words the
   front end uses now ("not yet — give it a name"). The API returns the
   words with the code; the browser never rewrites them.
5. **The seam is enforced**, not promised: an ESLint rule forbids any
   non-server file under `web/src` importing `orbit/*`, and a unit test pins
   that the named rule functions no longer exist in the browser.
6. The belt page (`item/[[id]]`) is not ported; it retires with #1319.

7. **What the engine stores, it validates, once** (#1333, #1328 macro M1).
   A date is a day that exists (`src/lib/calendar-date.ts`), a currency is a
   code in `Intl.supportedValuesOf("currency")` and a time zone one in its
   `"timeZone"` list plus `UTC`, which the runtime leaves off it
   (`src/lib/platform-lists.ts`): the standard "validate against the list the
   platform ships". The item bounds are named once in `src/lib/domain.ts`
   and every schema (command, archive import, reviewed intake, document
   suggestions) is built from them. A password or passphrase is counted one
   way, NFC code points (`src/lib/password-length.ts`), and its floor is held
   when one is made, never when one is opened. `tests/unit/engine-owns-every-rule.bounds.test.mjs`
   fails if a second copy of any of these comes back. Validation is on write
   only: the schemas that read stored rows (`storedHouseholdSchema`,
   `storedItemSchema`, `storedActivitySchema`) take a time zone, currency or
   date by shape, so a row the engine once accepted never stops reading. The
   one stored value known to be a mistake, "America/New York", is repaired by
   migration 0050.

## Consequences

- Every refusal costs a round trip. Same origin, one process, debounced: a
  few milliseconds, and the preview's refusals already arrive this way.
- The API's shape changes (`nextDate` leaves `item.complete`; `kind` joins
  `item.upsert`). Orbit has no installed base (ADR-0012, ADR-0018), so no
  version negotiation is needed, and the change lands in one batch.
- A second client (a CLI, a native app, a split front end) needs sign-in and
  the same-origin check, and nothing else.
- Engine tests gain what the browser's unit tests pinned: the month-end
  clamp, the reminder ceilings, the snooze floor.

## Alternatives rejected

- **A shared rules package imported by both sides.** One copy, but the
  browser still runs the rules, so the seam stays blurred and the package
  grows into a second engine. The owner's position rules it out.
- **A client-side mirror generated from a server-published schema.** Still
  a copy, with a generator to maintain, for a round trip that costs
  nothing here.
- **Leave the browser's copies and add server checks.** Two places to change
  for every rule; the drift that prompted this.
