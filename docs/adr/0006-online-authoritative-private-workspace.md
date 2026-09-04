# ADR-0006: Online-authoritative private workspace

**Status:** Accepted
**Date:** 2026-07-30

## Context

Orbit preview builds retained a user-keyed IndexedDB workspace snapshot and
queued commands for later replay. User scoping prevents accidental
cross-account reads in the ordinary interface, but it cannot make an
authorization decision while disconnected. A removed household member could
retain previously cached private data until the browser next reached Orbit,
and logout clearing alone cannot enforce a remote membership or account
revocation.

The v1 charter requires the privacy, conflict and recovery boundaries of
advertised offline data to be verified, or the unsupported behaviour to be
removed from v1 claims. A revocable offline authorization lease, encrypted
browser store and complete conflict protocol would materially expand the v1
security and delivery scope.

## Decision

- PostgreSQL and the authenticated workspace API remain authoritative for all
  private workspace data. The browser does not persist workspace snapshots or
  commands in app-controlled durable storage.
- ~~The client deletes the legacy `orbit-workspace` IndexedDB database before
  session bootstrap and before local logout. A blocked or failed deletion
  fails closed and presents a bounded error instead of opening private state or
  claiming logout succeeded.~~ **Struck 2026-09-03 — see Superseded below.**
- Authenticated state is rendered only after a live session check and canonical
  workspace response. Signed-out or unavailable startup paths receive no
  cached household state.
- Workspace changes are sent immediately with the current session and CSRF
  token. A failed change is visible, is not retained for replay, and leaves the
  last server-confirmed in-memory state authoritative.
- The installable service-worker shell and Web Push handling remain supported.
  API and authentication responses stay outside the service-worker cache.
- Future private offline access requires a separate accepted security design
  covering revocation, encryption and key lifecycle, expiry, conflict
  semantics, upgrades, logout, multi-account isolation and recovery.

## Consequences

- Membership and account revocation cannot be bypassed through Orbit's former
  IndexedDB snapshot after the migration purge runs.
- Users need a live Orbit connection to view or change private workspace data.
  Failed commands must be retried explicitly after connectivity returns.
- Orbit remains installable and may receive push notifications, but v1 does
  not claim private offline workspace access or queued edits.
- ~~Preview users may need to close another Orbit tab if it blocks legacy
  database deletion; Orbit reports that condition without disclosing private
  content.~~ Struck with the clause above.

## Superseded

**The legacy-database purge, struck 2026-09-03 (owner decision).**

The purge existed to clear the `orbit-workspace` IndexedDB database that
earlier builds wrote. The code that wrote it was removed on 2026-07-30 — the
same day this ADR was accepted — and the first release tag, `v1.1.0`, is
2026-08-08. So no released Orbit ever wrote that database, and the only
browsers that can hold one ran a development build before 30 July. That is not
an installed base; it is a handful of the owner's own browser profiles.

The v19 cut (#735) deleted the React client and with it the only caller, which
is how this surfaced. Restoring the call would have kept a permanent migration
step running for a population of about one, so the clause is struck instead and
`src/lib/private-browser-storage.ts` is deleted with it (#776).

Nothing else in this ADR changes. The browser still persists no workspace
snapshots or commands, and future private offline access still requires its own
accepted security design.

## Alternatives considered

- **Keep the user-keyed IndexedDB cache:** rejected because a cached identity is
  not current authorization and cannot enforce remote revocation.
- **Clear only on logout:** rejected because administrator or household-owner
  revocation can occur while the device is disconnected.
- **Encrypt snapshots with a browser-held key:** deferred because encryption at
  rest does not itself provide revocation; a bounded offline authorization and
  key-lifecycle protocol is still required.
- **Remove the service worker entirely:** rejected because the static
  installable shell and push handling do not require caching private API or
  authentication data.
