# Orbit deferred feature register

This register captures agreed product directions that are intentionally deferred
until the initial completion pass is finished. Entries describe the intended
outcome and important constraints; they are not commitments to a particular
implementation.

## Register conventions

Each entry records:

- **Priority:** relative product value, not an automatic implementation order.
- **Phase:** the earliest sensible delivery stage.
- **Dependencies:** foundations that must exist before implementation.
- **Decision status:** whether material architecture choices remain open.

Changes should be delivered behind migrations and feature flags where partial
deployment could expose unfinished behaviour. Every feature must preserve
household isolation, signed-out privacy, auditability, and the supported
deployment shape of one Orbit container plus standard PostgreSQL. Optional
document or AI processors may be separate, administrator-selected services;
they are opt-in deployment profiles rather than required parts of the core
stack. Durable orchestration remains in Orbit's existing internal worker and
PostgreSQL queues. Orbit must not require access to the Docker socket.

## ORB-FUT-001 — Intelligent email and document ingestion

**Status:** Deferred
**Priority:** High
**Phase:** 5 — after secure document storage, parsing, extraction, and review
**Dependencies:** ORB-FUT-003, ORB-FUT-004
**Decision status:** Architecture choices remain open
**Objective:** Let a registered user forward household documents to Orbit and
turn them into reviewed items with the original documents retained.

### Intended experience

1. Orbit connects to an external mail server using IMAP to monitor a dedicated
   inbound mailbox.
2. Orbit associates the message with a registered user using a cryptographically
   unguessable per-user recipient alias or token verified against the SMTP
   envelope-recipient metadata preserved by the provider. The visible `From`
   or `To` headers alone are never sufficient. Messages whose forwarding path
   strips required identity evidence are quarantined for explicit association.
3. Orbit places accepted messages into that user's private, durable ingestion
   queue. IMAP UIDVALIDITY and UID plus a content hash make reconnects and
   retries idempotent.
4. It examines the subject, message body and attachments, prioritising the
   documents themselves when extracting policy, provider, reference, cost,
   coverage and schedule information.
5. Orbit presents the extracted item and its source evidence for confirmation
   before changing household data.
6. The user selects the destination household and section, corrects uncertain
   fields, and approves creation or attachment to an existing item.
7. Original documents remain available from the resulting item.

### Outbound email

Outbound SMTP is a first-class part of this feature, not merely an ingestion
implementation detail. An instance administrator should be able to configure:

- an external SMTP server, port and TLS mode;
- authentication credentials independently from the IMAP credentials;
- a custom sender display name and `From` address;
- an optional reply-to address;
- a connection and delivery test before enabling outbound messages.

Orbit should use this configuration for ingestion receipts, review prompts,
duplicate warnings and existing reminder emails. The interface must explain
that the configured mail provider may restrict or rewrite unverified sender
addresses.

### Duplicate handling

Before creating an item, Orbit should rank possible matches using:

- exact document hashes;
- policy, contract or account references;
- provider and product names;
- overlapping effective, expiry, renewal or service dates;
- similarity to existing item titles and attached documents.

Potential matches must produce a comparison screen with explicit choices to
create a separate item, merge new information, or attach the documents without
changing existing fields. Orbit must not silently merge uncertain records.

### Security and privacy requirements

- A matching `From` address alone is not proof of identity because email can be
  spoofed. Provider authentication results, a dedicated forwarding address or
  token, and user confirmation should form the trust boundary.
- Treat message bodies and documents as hostile input, including possible
  prompt injection. Extraction must not grant documents access to application
  tools, secrets or unrelated records.
- Apply message, attachment-count and decompressed-size limits; reject unsafe
  MIME types and archive bombs; and scan retained files for malware.
- Isolate every ingestion job by user and household. Never expose candidate
  matches across households the user cannot access.
- Encrypt or otherwise protect retained documents, define deletion and
  retention behaviour, and include document storage in backup and restore
  procedures.
- Record source, extraction confidence, user corrections and the final action
  in the audit history.
- Require verified TLS for IMAP and SMTP with no downgrade to plaintext,
  least-privilege dedicated mailbox credentials, secret-backed credential
  storage, and redacted transport diagnostics.
- Retain or label accepted IMAP messages rather than deleting them. Poison
  messages move to a visible failed state after bounded retries.
- Logs and administrator errors may contain sanitized job identifiers, hashes,
  and technical classifications only—never message bodies, subjects, extracted
  text, sensitive filenames, prompts, or model responses.

### Architecture decisions required

- IMAP polling versus IDLE, including reconnect and mailbox-cursor behaviour.
- Separate IMAP and SMTP hosts, credentials and TLS requirements.
- Dedicated per-instance mailbox versus unique per-user forwarding addresses.
- Local-volume versus object-storage document backend, with a replaceable
  storage interface.
- OCR/document parsing service and structured extraction provider. These are
  separate replaceable HTTP adapters; either may be local or remote.
- Supported document types, maximum sizes and retention defaults.
- Behaviour when the sender belongs to multiple households.
- Instance-wide dedicated mailbox versus multiple administrator-managed
  mailboxes. The safest first release uses one dedicated instance mailbox.
- File-backed deployment configuration versus application-managed encrypted
  mailbox credentials.
- Whether SMTP must already be configured before IMAP ingestion is enabled.
  The first implementation treats outbound SMTP as a prerequisite for receipts
  and review notifications.

### Safest implementation sequence

1. Deliver manual upload, storage, download, deletion, quotas, and backup.
2. Add an administrator-selected document parser through a private HTTP
   adapter. Orbit uploads bytes directly; the parser does not receive arbitrary
   URLs and cannot call back into authenticated Orbit endpoints.
3. Add schema-constrained semantic extraction which receives only the parsed
   document and explicit field definitions. Treat its JSON as untrusted:
   validate and bound every field server-side and preserve page/source-span
   provenance for review.
4. Add review and duplicate comparison without automatic writes.
5. Add idempotent IMAP ingestion using a dedicated mailbox.
6. Add SMTP receipts and review notifications using Orbit's existing outbound
   transport.

No ingestion stage may create or merge an item until a user explicitly approves
the reviewed draft.

### Acceptance criteria

- An authenticated user's forwarded sample policy can produce a reviewable
  draft with its source document attached.
- Unknown or insufficiently authenticated senders cannot create drafts.
- Duplicate policy documents raise a comparison rather than silently creating
  or merging an item.
- Low-confidence fields remain visibly unresolved until confirmed.
- Failed parsing, unsafe files and provider outages are recoverable and visible
  to an administrator without exposing document contents in logs.

## ORB-FUT-002 — Mobile and installed-PWA information density

**Status:** In progress
**Priority:** High
**Phase:** 2 — independent mobile polish
**Dependencies:** Browser test coverage
**Decision status:** Product direction agreed
**Objective:** Make Orbit faster to scan on a phone without losing the richer
desktop presentation.

### Intended experience

- Replace the large desktop hero/focus treatment with a compact mobile summary
  that leaves upcoming items visible near the top of the first screen.
- Retain the brand and current sense of visual energy without allowing
  decorative elements to dominate limited vertical space.
- Increase the readability of essential item information and preserve generous
  touch targets.
- Keep search, household switching, notifications and add-item actions easily
  reachable in standalone PWA mode.
- Respect safe-area insets, browser text scaling, orientation changes and the
  on-screen keyboard.

### Acceptance criteria

- At common phone widths, the first upcoming item is visible without scrolling
  past a desktop-sized hero.
- Primary item text remains readable at a glance at every Orbit text-size
  setting.
- Interactive controls meet accessible touch-target and keyboard-focus
  requirements.
- Layout is verified in iOS Safari/installed mode and Android
  Chrome/installed mode, including light and dark themes.
- Desktop and tablet layouts retain their current richer composition.

## ORB-FUT-003 — Secure document-management foundation

**Status:** Complete
**Priority:** Critical foundation
**Phase:** 1
**Dependencies:** Backup/restore hardening
**Decision status:** Storage backend requires a decision
**Objective:** Give household items durable, private documents before adding
mailbox automation or AI extraction.

The active delivery architecture and sequence are maintained in the
[implementation plan](implementation-plan.md). Application-level envelope
encryption is required from the first production document and is part of this
foundation, not a deferred enhancement.

### Scope

- Manual upload from desktop and mobile file pickers, including camera capture
  where the platform supports it.
- A replaceable storage interface with local volume storage as a possible
  default and S3-compatible object storage as an optional backend.
- Database metadata for content hash, original name, media type, size, owner,
  household, item, storage key, scan state, and retention state.
- Authenticated streaming download without public storage URLs.
- Authorization is rechecked when every byte stream is opened; cached URLs or
  prior membership never confer continuing access.
- Explicit deletion, retention, per-file and per-instance limits, and orphan
  cleanup.
- Document events in the household audit history.
- Backup and restore coverage for both metadata and document bytes.

### Security requirements

- Inspect content rather than trusting filename extensions or supplied MIME
  types.
- Use generated opaque storage keys and prevent path traversal.
- Never serve active document content inline by default; use safe download
  headers and a restrictive content security policy.
- Quarantine documents until validation and any configured malware scan finish.
- Keep object buckets private with server-side encryption, explicit versioning
  and retention policy, and no anonymous or direct browser access.
- Coordinate storage writes and database metadata through staged states and
  reconciliation jobs so either side can recover from a partial failure.
- Parser services receive documents over a private network and have no database,
  secrets, Docker socket, or host-filesystem access.
- Malware scanning uses a replaceable service adapter. The official ClamAV
  container is a supported opt-in profile rather than a hidden dependency,
  because its signature engine has substantial memory requirements.

### Acceptance criteria

- A member can attach and later retrieve a permitted document from an item.
- Another household and a signed-out visitor cannot discover its metadata or
  bytes.
- Restore testing proves documents and their database metadata remain aligned.
- Interrupted uploads and deleted items do not leave permanent orphaned files.

### Processing-service direction

- **Baseline parser:** Apache Tika Server's official full container is the
  conservative option for broad text/metadata extraction and Tesseract OCR.
- **Advanced parser:** Docling Serve is an optional administrator-selected
  adapter for richer layout and structured document conversion. Its CPU image
  is materially larger, so it is not part of Orbit's default stack.
- **Local semantic extraction:** Ollama is a possible optional provider because
  its HTTP API supports schema-constrained structured outputs. Orbit also
  supports a remote provider through the same narrow extraction interface.
- All images are pinned to reviewed release tags, isolated on an internal
  egress-denied network, configured with request/page/size limits, CPU/memory
  quotas and timeouts, and updated independently of Orbit. Supported releases
  are recorded by immutable image digest; services run non-root with read-only
  filesystems where compatible and expose health/version state to Orbit.

## ORB-FUT-004 — Administrator operations and job visibility

**Status:** In progress on `feature/admin-operations`
**Priority:** High
**Phase:** 1
**Dependencies:** Existing administrator authorization
**Decision status:** Product direction agreed
**Objective:** Make background work diagnosable without exposing secrets or
document contents in logs.

The binding implementation and security contract is recorded in
[administrator operations](administrator-operations.md).

### Scope

- Health and last-success state for reminders, SMTP, Web Push, document parsing,
  extraction, malware scanning, and IMAP.
- Failed/retry/cancelled job counts with safe error summaries and explicit
  retry or discard actions.
- Test actions for configured SMTP, push, parser, storage, and extraction
  providers.
- Storage and queue usage, retention cleanup state, and version information.
- A filterable audit history for security- and data-affecting actions.

### Acceptance criteria

- An administrator can distinguish invalid configuration, provider outage,
  unsafe input, and exhausted retries without opening container logs.
- Operational views never reveal credentials, session tokens, full message
  bodies, or retained document contents.

## ORB-FUT-005 — Account and household lifecycle

**Status:** In progress
**Priority:** Medium
**Phase:** 2
**Dependencies:** Export and backup tooling
**Decision status:** Destructive-operation policy remains open
**Objective:** Define safe ownership, departure, disabling, and deletion
behaviour.

Ownership transfer to an existing household member is delivered. Remaining
scope includes:

- administrator account disable/enable with immediate session revocation;
  **delivered** — disabled accounts cannot sign in or retain an Orbit session,
  remain available to administrators for safe re-enablement, and cannot be used
  to leave the instance without an active administrator;
- user departure from households they do not own; **delivered** — members can
  leave their own household, while owners remain protected from leaving it
  ownerless;
- protection against leaving any household without an owner;
- protected household deletion with typed confirmation and a retention window;
- rules for identities removed or renamed by the OIDC provider;
- document, delivery, audit, and backup retention after deletion;
- prevention of deleting the last instance administrator.
- cancellation or reassignment rules for pending ingestion drafts and jobs when
  a user is disabled or removed, plus an explicit administrative/legal-hold
  exception to normal retention where deployment policy requires it.

## ORB-FUT-006 — Data portability

**Status:** Deferred
**Priority:** Medium
**Phase:** 2
**Dependencies:** ORB-FUT-003 for document-inclusive archives
**Decision status:** Export format requires a decision
**Objective:** Ensure users can move and recover their household records without
being locked to Orbit.

### Scope

- A human-readable export plus a versioned machine-readable archive.
- Optional inclusion of original documents with a manifest and content hashes.
- Validated import with preview, duplicate handling, and no partial commits.
- Household-scoped authorization and an audit record for every export/import.
- Clear distinction between disaster-recovery backups and portable exports.
- Encrypted-at-rest generated archives with short expiry, rechecked
  authorization at download, audited retrieval, and automatic purge.

## ORB-FUT-007 — Mobile document capture

**Status:** Deferred
**Priority:** Medium
**Phase:** 3
**Dependencies:** ORB-FUT-002, ORB-FUT-003
**Decision status:** Product direction agreed
**Objective:** Make adding a paper policy, receipt, or service record from a
phone quick and readable.

### Scope

- Camera and file-picker capture with preview, rotation, removal, and retry.
- Upload progress that survives transient connectivity.
- Clear size/type feedback before transfer and preservation of the original.
- A compact review screen that works with the on-screen keyboard and safe-area
  insets.

## ORB-FUT-008 — CI and release-host portability

**Status:** Deferred fallback
**Priority:** Low
**Phase:** Operational, if GitHub-hosted validation becomes constrained
**Dependencies:** Portable test scripts and container build
**Decision status:** Direction agreed; no migration currently required
**Objective:** Keep routine validation independent of one hosted CI provider
while retaining GitHub as Orbit's public source and release channel.

### Intended fallback

- Run branch and merge-request validation on the self-hosted GitLab instance.
- Keep the same fast-check-before-container-build ordering and required quality
  gates used by GitHub Actions.
- Push only approved releases, tags, source mirrors, and public container images
  to GitHub and GHCR.
- Keep provider-specific YAML thin: test, build, and deployment behaviour must
  remain in the versioned `scripts/` entry points wherever practical.
- Use short-lived, narrowly scoped credentials for any GitLab-to-GitHub release
  publication, with no general GitHub account access.

This option should only be activated if GitHub availability, policy, storage,
or runner constraints provide a material reason. Standard GitHub-hosted runners
for the public repository remain the simpler default.

## Recently delivered hardening foundations

- Per-user email and browser-push reminder preferences.
- Atomic household ownership transfer with an audit record.
- PostgreSQL backup and transactional restore scripts.
- Automated signed-out browser privacy and accessibility checks.
