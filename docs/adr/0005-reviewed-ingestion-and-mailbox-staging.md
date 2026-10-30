# ADR-0005: Private reviewed ingestion and mailbox staging

**Status:** Accepted
**Date:** 2026-07-28
**Amended:** 2026-10-30 — mailbox approval is an idempotency-key operation
with a stored request; see the amendment at the end (#1396).

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
- Rotation supports the current and one previous alias generation for a
  bounded transition. Users see the new alias; the old generation expires
  explicitly. Emergency rotation may invalidate the previous generation
  immediately. **Amended by [ADR-0017](0017-mail-in-credential-ownership-and-per-user-relay.md)
  decision 2 (slice 3, orbit#744):** generations are per user, not per
  instance, and the transition is fixed by the product at 14 days rather than
  selected by an administrator. What an administrator retains is the
  instance-wide emergency alias-key rotation, whose grace they do choose, up
  to the same 90-day ceiling.
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
  PDF must pass the malware scan and then open in pdf.js after bounded
  download, or the receipt fails safely (ADR-0033). A message with no PDF candidate reaches a bounded
  private `no_supported_pdf` outcome and cannot produce a review draft or
  household mutation. Direct upload continues to support PDF, JPEG, and PNG.
  All supported direct-upload formats remain subject to the same
  hostile-content, parser/OCR isolation, bounded-output, and indirect prompt
  injection controls as mailbox PDFs.
- Archives are not decompressed or previewed. Active content inside an
  accepted PDF is never run: the preview renderer has scripting and XFA off
  (ADR-0033). Extracted PDF input is bounded to the existing parser character
  limit.
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

## Amendment (#1396, 2026-10-30): approval keeps the request it accepted

Decided 2026-10-30 (#1396, decision note and owner answer 7a). It amends the
review and approval boundary for mailbox approvals; direct uploads
(`reviewed_intake_operations`, ADR-0010's document idempotency) are unchanged.

**The pattern.** A mailbox approval is an idempotency-key operation with a
stored request fingerprint, as in the IETF httpapi `Idempotency-Key` draft and
Stripe's documented behaviour. `operationId` is the key and
`approval_request_sha256` the fingerprint. The same key with the same request
continues or replays the original; the same key with a changed request, or a
different key on a bound receipt, is refused 409 `reviewed_intake_conflict`
("That approval identity was already used"). The created item's id is the
operation id.

**The stored request.** The claim stores the accepted request beside its hash,
in `imap_ingestion_messages.approval_request_enc`, Tier 1 metadata keyed as
`proposal_enc` is (ADR-0024). It is the parsed request less its key, with the
attachment selection sorted, so sent back verbatim with its key it hashes to
the stored fingerprint. It is cleared wherever the hash is cleared.

**Validation precedes the claim.** The request's checks run before anything
is recorded, and the selected-attachment check (`attachment_not_found`), which
ran after the item was created, now runs with them. A request refused there
binds no key and creates no item, so the next tap sends afresh with what the
review lists now. A failure after the claim keeps the key, so the same
request finishes it.

**The review read returns the pending pair to its owner.** ADR-0006 forbids
the browser holding a workspace command across a reload, so it cannot keep the
key and request itself. Instead `GET /api/imap-inbox/:receiptId` reports
`approval: { operationId, request }` for a `recoverable` receipt whose
approval its owner may retry, and for nothing else; the route's ownership
check is the only authorisation. The client sends a reported pair verbatim,
whatever it holds or was given; otherwise it mints a key and builds the
request once, keeping the whole request in memory for in-tab retries. While a
pair is pending, the review sheet hides its amend fields and says it is
finishing the earlier approval, since an amendment would not apply (owner
decision 7a).

**The reclaim remembers the item.** An `approving` receipt abandoned for more
than 10 minutes is reclaimed by the next approval or by its owner's review
read. If its item was already created, it becomes `recoverable` with the
retryable failure code `approval_interrupted` and keeps its key, hash and
request, so the review reports the pair and a tap finishes it; a fresh key
would be a second item. Only a receipt with no item yet is reset to
`pending_review` and forgets its key, as before.

**Not taken.** Keeping the pair in browser storage (ADR-0006, and another
device cannot see it); accepting a changed request under the same key (it
defeats the fingerprint); releasing the claim after a refusal past the claim,
or a fresh key after the claim (the item already exists, and a second key is a
second item).
