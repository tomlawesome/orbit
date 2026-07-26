# Architecture consolidation programme

## Status

Approved for implementation on `develop`. This programme replaces piecemeal
fixes for household recovery and addresses the architectural findings recorded
in the July 2026 codebase audit. It is intentionally sequenced so each phase
leaves a releasable, tested application.

### Delivered in the current consolidation branch

- Production dependency advisories have been remediated and the production
  audit is clean.
- Workspace reads no longer create a `My home` household. Household creation
  is server-first, recovery names are reserved only during the recovery window,
  and recovery/create/permanent-delete choices share one UI and API contract.
- IMAP receipt delivery now uses database leases, so concurrent replicas cannot
  send a duplicate receipt. A migration adds the receipt lease fields and claim
  index. IMAP polling now advances from its durable UID/UIDVALIDITY checkpoint
  rather than rescanning every unseen message.
- Household deletion removes database access before encrypted-file cleanup, so
  external filesystem work never runs while a database transaction is open.

The remaining work in this programme is intentionally still open: indexed
opaque-recipient lookup, the broader worker side-effect boundary, dashboard
and repository extraction, and authenticated browser coverage.

## Outcomes

1. Resolve production dependency advisories without loosening the lockfile or
   bypassing the existing CI gates.
2. Make household entry, creation, recovery, deletion and restoration one
   server-authoritative state machine. Reading a workspace must never create a
   household as a side effect.
3. Make command failures actionable. Structural household operations must not
   rely on optimistic offline replay.
4. Move recurring work behind durable, replica-safe coordination and remove
   unbounded IMAP mailbox rescans.
5. Split the dashboard and workspace repository at clear feature boundaries,
   then cover authenticated workflows with repeatable browser tests.

## Delivery phases

### Phase A — dependency security

- Upgrade Drizzle ORM, Nodemailer and the Next.js dependency chain to patched
  versions.
- Regenerate the lockfile deliberately and validate type checks, unit tests,
  Compose smoke tests and container build.

### Phase B — household lifecycle boundary

- Introduce an explicit server landing state: first use, recovery choice or
  active household.
- Remove automatic database creation of `My home` from workspace reads and
  remove browser-local fake-household rendering from authenticated flows.
- Use one recovery panel for creation, restoration and administrator-only
  permanent deletion.
- Reserve names only during the active recovery window and return structured,
  user-actionable conflicts.
- Preserve existing records safely; never infer that an existing `My home`
  household can be discarded.

### Phase C — command and worker durability

- Make structural commands server-first. Retain offline queuing only for
  commands with clear idempotency, revision and conflict semantics.
- Extract shared durable lease/claim handling for recurring work.
- Run worker responsibilities explicitly and ensure all external side effects
  occur after durable state changes.
- Add IMAP mailbox checkpointing and indexed opaque-recipient lookup.

### Phase D — maintainability and acceptance

- Split dashboard composition, household lifecycle UI, workspace query
  projection and command services into feature-scoped modules.
- Add authenticated Playwright fixtures and lifecycle, IMAP-review, push and
  failure-recovery coverage.
- Reconcile the handover, implementation plan and operational documentation
  with the delivered architecture.

## Acceptance gates

- A new user sees a create choice but no persisted household until they create
  one.
- A user with only recoverable households sees restore/create choices; an
  administrator also sees permanent deletion.
- Removal hides a household immediately from every member; restoration makes
  it active for the actor without creating or selecting another household.
- A reserved-name attempt identifies an eligible recovery option instead of
  becoming a generic sync failure.
- Worker replicas cannot duplicate SMTP receipts, push notifications, IMAP
  processing or irreversible storage cleanup.
- Authenticated browser tests cover the above paths, alongside the existing
  security, privacy, container and backup/restore gates.
