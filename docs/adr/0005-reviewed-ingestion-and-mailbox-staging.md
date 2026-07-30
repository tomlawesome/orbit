# ADR-0005: Private reviewed ingestion and mailbox staging

**Status:** Accepted
**Date:** 2026-07-28

## Context

Orbit supports manual item entry and optional document-assisted suggestions.
Dedicated-mailbox ingestion must provide the same editable, explicit-approval
experience without publishing automation mistakes to a household.

The prototype protects users by creating an archived household item and
attaching received documents before review. Although that item is hidden in
the ordinary interface, it is already household data and therefore conflicts
with the v1 rule that receipt alone never creates, attaches, or merges an item.
Conversely, forcing direct uploads into durable server-side drafts would retain
private data unnecessarily and would contradict their accepted transient
pre-submit behaviour.

Mailbox receipt is asynchronous, so it does need durable private staging until
the recipient reviews or discards it. The architecture must preserve that
safety property while giving both sources one approval boundary.

## Decision

### Review and approval boundary

- A mailbox receipt may create a private, user-owned ingestion draft. It is not
  an item, is not assigned to a household before the user chooses one, and is
  invisible to other household members and household queries.
- Supported clean attachments are held in encrypted staging storage. They are
  not ordinary Orbit documents and cannot be downloaded through item document
  routes before approval.
- Direct-upload inspection remains transient: Orbit scans and optionally
  parses the upload, returns bounded suggestions, and removes temporary
  plaintext. The browser retains the selected original until submission.
- Both sources converge on one reviewed-approval service contract containing
  the final user-edited fields, destination, explicit action, source identity,
  and an idempotency identity. The service re-authorizes the user and
  destination at approval time.
- Approval creates an item through the conflict-safe item command and transfers
  selected originals through the secure document lifecycle. A partial
  attachment failure is explicit and retryable; it never silently changes the
  reviewed item values.
- Discard, expiry, user disablement, or loss of destination authority prevents
  approval and purges staged bytes according to the lifecycle below.

### Mailbox and recipient identity

- v1 supports one administrator-configured dedicated mailbox per Orbit
  instance and bounded periodic polling. IMAP IDLE and multiple managed
  mailboxes are deferred.
- IMAP always uses verified TLS and a dedicated least-privilege account. Orbit
  reads messages without deleting them; the external mailbox remains the
  recovery source under the administrator's provider retention policy.
- The administrator configures one provider-preserved envelope-recipient
  header and verifies it with a setup test. Visible `From`, `Sender`, `To`, and
  `Cc` headers are never identity evidence.
- Each active user receives an opaque forwarding alias derived with
  HMAC-SHA-256 from a secret-backed alias key, stable user identity, and key
  generation. Alias digests and generations are indexed; user identifiers and
  alias secrets do not appear in addresses or logs.
- Rotation supports the current and one previous alias-key generation for a
  bounded administrator-selected transition. Users see the new alias; the old
  generation expires explicitly. Emergency rotation may invalidate the
  previous generation immediately.
- Missing, ambiguous, or unverified envelope identity produces a quarantined
  receipt with sanitized diagnostics. It cannot be manually associated by an
  administrator in v1.

### Receipt, hostile-input, and retention bounds

- Receipt uniqueness uses mailbox, UIDVALIDITY, and UID. Content identity is
  scoped to the verified recipient so the same legitimate document sent to two
  users is not suppressed. Cursor rollover, crash recovery, and repeated
  polling are idempotent.
- Defaults are a 25 MiB raw message limit, ten candidate PDF attachments, a
  25 MiB aggregate decoded-PDF limit, 100 MIME parts, and ten MIME nesting
  levels. Each PDF also obeys the configured document limit.
- Mailbox ingestion is PDF-only in v1. Non-PDF parts, including incidental
  inline logos and signatures, are not downloaded or staged; they still count
  toward the raw-message and MIME-structure bounds. A part represented as a
  PDF must be detected as a structurally valid PDF after bounded download or
  the receipt fails safely. A message with no PDF candidate reaches a bounded
  private `no_supported_pdf` outcome and cannot produce a review draft or
  household mutation. Direct upload continues to support PDF, JPEG, and PNG.
  All supported direct-upload formats remain subject to the same
  hostile-content, parser/OCR isolation, bounded-output, and indirect prompt
  injection controls as mailbox PDFs.
- Archives and active content are not decompressed or previewed. Extracted PDF
  input is bounded to the existing parser character limit.
- Raw messages, subjects, bodies, headers, and unsafe bytes are not durably
  stored by Orbit. Supported PDFs are scanned before encrypted staging;
  malware and incomplete staging are purged immediately.
- Provider and processing work uses leases, five bounded attempts, classified
  retry state, and the established delivery backoff conventions. Poison input
  becomes a visible failed or quarantined receipt rather than blocking the
  mailbox.
- Pending user drafts expire after 30 days by default. Completion, discard, and
  expiry purge staging promptly; sanitized receipt/audit metadata may remain
  for the configured audit period. Disabling ingestion stops new polling but
  preserves unexpired drafts and the durable cursor for safe re-enablement.

### Duplicate choices and outbound mail

- Duplicate candidates are searched only after the user selects a household
  and only within households they can currently access.
- v1 offers explicit `create separate` and `attach to existing` outcomes.
  Automatic merging and field-level merge are deferred.
- Outbound SMTP is configured and tested independently with verified TLS and
  secret-backed credentials, and is a prerequisite for enabling IMAP. Receipts
  and review notifications cannot approve a draft or write household data.

## Consequences

- Automated suggestions remain private until the recipient approves them, so
  mistakes cannot leak into household views or history.
- Mailbox staging requires a migration away from the prototype's
  `reviewItemId` ownership model and needs explicit receipt/draft/attachment
  lifecycle and reconciliation tests.
- The approval service can be tested once for authorization, idempotency,
  reviewed-value fidelity, and partial attachment recovery while preserving
  source-specific staging.
- Administrators must verify that their mail provider preserves the configured
  envelope-recipient header and plus-style alias before enabling ingestion.
- Polling has higher latency than IDLE but simpler reconnect, restart, and
  single-instance operational behaviour.

## Alternatives considered

- **Keep a hidden archived household item:** rejected because it creates
  household state before approval and complicates privacy, discard, audit, and
  duplicate semantics.
- **Persist every direct-upload draft:** rejected because it adds unnecessary
  private retention and contradicts the accepted transient inspection path.
- **Trust visible sender or recipient headers:** rejected because they are
  spoofable and commonly rewritten.
- **Use IMAP IDLE for v1:** rejected because polling meets the user outcome with
  less reconnect and lifecycle complexity.
- **Automatically merge likely duplicates:** rejected because a confidence
  error could silently corrupt household data.
