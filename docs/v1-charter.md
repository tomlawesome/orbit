# Orbit v1 charter

## Purpose

Orbit v1 is a professional, focused, self-hosted home-operations application.
It helps a household record recurring responsibilities, see what is due, retain
supporting documents, and recover its data without depending on a proprietary
hosted service.

The initial audience is a technically supported household or small trusted
group running one Orbit instance. Multiple authenticated users and households
may exist inside that instance. Managed SaaS tenancy is not part of v1.

## Supported deployment

The supported core topology is:

- one Orbit application container;
- one standard PostgreSQL 18 service;
- one private encrypted document volume;
- an external, standards-compliant OIDC provider;
- the isolated ClamAV service when document scanning is enabled.

Tika, IMAP, SMTP, Web Push, and future local model services are replaceable,
optional integrations. An unavailable optional provider must not make
unrelated core records inaccessible.

The binding deployment decision is
[ADR-0001](adr/0001-self-hosted-single-instance.md).

## Release requirements

Requirement identifiers are stable. GitHub issues and tests should cite them.

### Identity and privacy

- **V1-ID-01:** A user can sign in and out through standards-compliant OIDC.
  Sessions are opaque, revocable, rotated safely, and protected from cross-site
  state changes.
- **V1-ID-02:** Signed-out users and users outside a household cannot discover
  that household's records, membership, documents, archives, or operations.
- **V1-ID-03:** An instance administrator can disable and safely re-enable an
  account without allowing an ownerless household or an administrator-less
  instance.

### Households and records

- **V1-HH-01:** A first-time user explicitly creates a household; reads never
  create records as a side effect.
- **V1-HH-02:** Owners can manage existing registered members and transfer
  ownership without leaving a household ownerless.
- **V1-HH-03:** Household removal is immediately private, recoverable for the
  documented retention period, and irreversibly purged only through an
  authorized, audited workflow.
- **V1-ITEM-01:** An authorized member can create, edit, search, schedule,
  complete, reschedule, archive, restore, and review the history of household
  items.
- **V1-ITEM-02:** Display preferences remain consistent across sessions and do
  not compromise item access or history. **Sections leave navigation** (owner,
  2026-08-14; issue #413): no ratified v19 screen presents a section list, and
  search plus the manifest carry navigation instead. A section remains an
  attribute of an item and is still printed on each manifest row as its
  category, so nothing about item access or history changes. The `sections`
  table and `items.sectionId` are untouched — retiring them would be a
  migration against a shipped v1.2.0 and is not a front-end matter.

### Documents and reminders

- **V1-DOC-01:** An authorized member can upload, scan, encrypt, download,
  delete, restore, and recover a supported document without exposing it to
  another household or public storage.
- **V1-DOC-02:** An optional uploaded document may produce bounded,
  best-effort field suggestions, but the user can edit every field and must
  explicitly submit the item. Manual entry remains fully supported without a
  document.
- **V1-DOC-03:** When an administrator configures a dedicated mailbox, Orbit
  ingests bounded, authenticated messages and attachments idempotently into
  the same private review flow used for direct uploads. The user selects the
  household, can correct every suggested field, and must explicitly approve
  creation or attachment; receipt of a message never writes or merges an item
  automatically.
- **V1-REM-01:** Due-date calculations and reminder preferences are
  deterministic across calendar and daylight-saving boundaries.
- **V1-REM-02:** Notification delivery is idempotently scheduled, bounded on
  failure, diagnosable without private content, and optional when a provider is
  not configured.

### User experience

- **V1-UX-01:** Core authenticated and signed-out journeys are keyboard
  accessible, have no known automated WCAG A/AA violations, and work at common
  mobile and desktop viewport sizes.
- **V1-UX-02:** If offline snapshots or queued changes are advertised, their
  privacy boundary, conflict behaviour, and recovery from failed sync are
  verified. Otherwise the unsupported behaviour is removed from v1 claims.
- **V1-UX-03:** User feedback is readable, non-blocking, and persists only as
  long as needed to understand the result.

### Installation, operation, and recovery

- **V1-OPS-01:** A new installation can be configured without placing secrets
  in Git, ordinary environment output, logs, or process arguments.
- **V1-OPS-02:** Health and administrator diagnostics distinguish
  configuration, dependency, provider, queue, and storage failures without
  exposing private content or credentials.
- **V1-OPS-03:** A documented update applies migrations safely and proves both
  fresh-install and supported-upgrade paths.
- **V1-OPS-04:** Backup and restore preserve PostgreSQL data and encrypted
  documents, detect corruption or mismatched key material, and document the
  separate recovery-key requirement.
- **V1-REL-01:** CI tests the exact production image that may be published.
  Development and versioned-release previews, and stable versions, are
  identified and deployed by immutable digest. Stable promotion accepts only
  the matching tested release-branch preview after its exact source reaches
  protected `main` and `dev`, and never rebuilds it.

## Quality attributes

- **Security:** fail closed, least privilege, server-side authorization,
  hostile-input handling, safe logging, and negative privacy tests.
- **Data integrity:** transactional state changes, idempotent jobs, versioned
  migrations, authenticated encryption, and verified recovery.
- **Reliability:** bounded retries and resources, explicit failure states, and
  no hidden dependency on optional providers.
- **Accessibility:** keyboard operation, readable focus and contrast, text
  scaling, and automated plus manual checks on authenticated workflows.
- **Operability:** actionable health, deterministic update and rollback
  guidance, backup scheduling, and real restore exercises.
- **Maintainability:** issue-led vertical slices, durable ADRs, replaceable
  adapters, and tests at the cheapest layer that proves the requirement.

## Non-goals for the stable v1 gate

- Managed multi-tenant SaaS, billing, or fleet administration.
- Public document sharing or anonymous access.
- S3-compatible storage or horizontal application scaling.
- Automatic AI writes to household data.
- Requiring Ollama or any cloud model.
- Automatic duplicate merging or any inbound-mail path that bypasses explicit
  user review and approval.
- A numerical test-count target or an arbitrary coverage percentage.

Optional preview features may ship disabled or explicitly experimental only
when they cannot weaken the supported core.

## Release acceptance

Stable v1 requires:

1. Every requirement above to map to an open gap issue or passing evidence in
   the [engineering baseline](engineering-baseline.md).
2. All release-blocking issues closed with linked tests and review evidence.
3. The [quality strategy](quality-strategy.md) and required CI gates passing.
4. A versioned-release preview deployed by digest and exercised on a
   representative self-hosted test bed, including update, sign-in, core
   records, documents, backup, restore, and restart.
5. The exact accepted digest promoted through the protected production
   environment.
