# Orbit product direction register

This register captures detailed possible or agreed product directions that do
not belong in the concise release charter. An entry may be deferred or promoted
into a release contract; its roadmap disposition makes that explicit. Entries
describe intended outcomes and constraints, not implementation status or
permission to expand an active issue.

The [v1 charter](v1-charter.md) defines the release contract, the
[engineering baseline](engineering-baseline.md) records dated evidence, and
GitHub milestones/issues own live delivery status.

## Register conventions

Each entry records:

- **Priority:** relative product value, not an automatic implementation order.
- **Phase:** the earliest sensible delivery stage.
- **Dependencies:** foundations that must exist before implementation.
- **Decision status:** whether material architecture choices remain open.

Existing candidate code does not make a direction complete. Inclusion in the
v1 contract requires a scoped issue, acceptance evidence, and any necessary ADR
or threat-model update. Changes should use migrations and feature flags where
partial deployment could expose unfinished behaviour. Every feature must
preserve household isolation, signed-out privacy, auditability, and the
supported deployment shape in ADR-0001. Orbit must not require access to the
Docker socket.

## ORB-FUT-001 — Reviewed email and document ingestion

**Roadmap disposition:** Required for the stable v1 gate
**Priority:** Required core workflow
**Phase:** 3 — after secure document storage, parsing, extraction, and review
**Dependencies:** ORB-FUT-003, ORB-FUT-004
**Decision status:** v1 architecture accepted in
[ADR-0005](adr/0005-reviewed-ingestion-and-mailbox-staging.md)
**Objective:** Let a registered user forward household documents to Orbit, or
upload them directly, and turn them into reviewed items with the original
documents retained. Both sources use one editable draft-and-approval flow.

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

Potential matches must produce a comparison screen. For v1 the explicit
choices are to create a separate item or attach the documents without changing
existing fields. Field-level merge remains deferred; if introduced later it
must be separately reviewed and must never silently merge uncertain records.

### Security and privacy requirements

- A matching `From` address alone is not proof of identity because email can be
  spoofed. Provider authentication results, a dedicated forwarding address or
  token, and user confirmation should form the trust boundary.
- Treat message bodies and documents as hostile input, including possible
  prompt injection. This applies to every supported direct-upload format—PDF,
  JPEG, and PNG—as well as mailbox PDFs and any text recovered through
  OCR. ClamAV, parsers, and OCR reduce different risks but do not make content
  trustworthy. Extraction must not grant documents access to application
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

### Architecture decisions

[ADR-0005](adr/0005-reviewed-ingestion-and-mailbox-staging.md) defines the v1
boundary:

- one dedicated instance mailbox using bounded polling and verified TLS;
- a provider-preserved envelope-recipient header plus versioned HMAC per-user
  aliases, with visible mail headers excluded from identity;
- private user-owned encrypted staging rather than hidden household items;
- transient direct-upload inspection and one source-aware approval contract;
- PDF-only mailbox staging, bounded MIME/message limits, ignored non-PDF
  parts, safely rejected malformed PDF claims, five processing attempts, and
  45-day pending-draft retention (owner decision 2026-08-15, #434); direct upload separately retains PDF, JPEG,
  and PNG support under the same hostile-content and indirect-injection
  boundary;
- explicit create-separate or attach-to-existing duplicate outcomes, without
  automatic or field-level merge;
- separate secret-backed SMTP configuration as an IMAP enablement prerequisite.

Storage, scanner, and parser implementations remain replaceable through their
existing interfaces. A sender with multiple households chooses the destination
during review; receipt never guesses it.

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

**Roadmap disposition:** Basic responsive/accessibility quality is v1; enhanced PWA density remains future work
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

**Roadmap disposition:** Core v1 capability with incomplete acceptance evidence
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

- **Default stack:** no parser, OCR, or model service is required. Orbit stays
  as one application container plus PostgreSQL and its existing document
  protection profile.
- **First real-document trial:** an administrator may opt into one Apache Tika
  full container. Orbit restricts it to bounded PDF/JPEG/PNG text and metadata
  extraction; Tesseract OCR and embedded recursion are disabled even though
  their binaries may exist in the pinned image. Output remains editable review
  evidence, never an automatic write. Enabling OCR requires separate review
  and bounded acceptance evidence.
- **Advanced parser:** Docling Serve is a replacement parser, not a companion
  to Tika. It is considered only if representative documents prove that Tika's
  layout or table handling is insufficient; its large image excludes it from
  the default stack.
- **Local semantic extraction:** Ollama remains an optional later provider for
  schema-constrained draft fields after text extraction. It is neither OCR nor
  a default container. The `ai` Compose profile now supplies an opt-in,
  private local service for evaluation, but Orbit has no Ollama client yet and
  must not infer or write household data from a model response.
- All images are pinned to reviewed release tags, isolated on an internal
  egress-denied network, configured with request/page/size limits, CPU/memory
  quotas and timeouts, and updated independently of Orbit. Supported releases
  are recorded by immutable image digest; services run non-root with read-only
  filesystems where compatible and expose health/version state to Orbit.

## ORB-FUT-004 — Administrator operations and job visibility

**Roadmap disposition:** Core v1 operations capability with incomplete acceptance evidence
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

**Roadmap disposition:** Core v1 lifecycle capability with incomplete acceptance evidence
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

**Roadmap disposition:** Portable export/import is post-v1; disaster-recovery backup/restore remains v1
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

**Roadmap disposition:** Basic mobile upload is v1; enhanced capture workflow is post-v1
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

**Roadmap disposition:** Contingency only; GitHub-hosted validation remains the supported v1 path
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

## ORB-FUT-009 — Structured provider contact information

**Roadmap disposition:** Deferred until after v1
**Priority:** Medium
**Phase:** Post-v1 product enrichment
**Dependencies:** ORB-FUT-001 and a reviewed contact-data model
**Decision status:** Storage and presentation model requires a decision
**Objective:** Keep useful provider contact details with an item so household
members can quickly find the correct support channel.

### Intended direction

- Allow manual entry of labelled support telephone numbers, email addresses,
  business or registered addresses, and websites.
- Propose the same structured fields from supported document and email
  ingestion sources, with bounded source evidence and confidence.
- Require explicit review before extracted contact details are saved. Every
  proposed value remains editable or removable.
- Treat telephone numbers, addresses, email addresses, URLs, display labels,
  metadata, and OCR-derived text as hostile data. Extraction cannot initiate a
  call, message, navigation, lookup, or write.
- Present external links and contact actions with safe schemes, clear
  destinations, and no embedded credentials or automatic requests.
- Decide separately whether details belong to an individual item, a reusable
  provider record, or both before implementation.

## ORB-FUT-010 — AI-assisted item summaries and notes

**Roadmap disposition:** Deferred until after v1
**Priority:** Medium
**Phase:** Post-v1 product enrichment
**Dependencies:** ORB-FUT-001 and proven indirect-injection controls
**Decision status:** Summary lifecycle and model-provider contract require a
decision
**Objective:** Help users understand an item quickly through a concise summary
and useful notes without allowing generated text to become authoritative.

### Intended direction

- Provide a manually editable summary and notes section independently of
  whether AI assistance is configured.
- Optionally propose a concise summary or notes from the minimum necessary,
  user-authorized item and document evidence.
- Show provenance and make generated content visibly distinguishable until the
  user explicitly accepts, edits, or discards it.
- Treat source content and model output as hostile, fallible suggestions. The
  model receives no tools, secrets, unrelated records, ambient network access,
  authority decisions, or automatic write capability.
- Never infer missing contractual facts or silently replace user-authored
  notes. Regeneration must not erase prior accepted content.

## ORB-FUT-011 — Desktop navigation, settings and administration surfaces

**Roadmap disposition:** Post-v1; targeted at v1.1
**Priority:** High
**Phase:** Post-v1 experience
**Dependencies:** Existing authorization and session contracts
**Decision status:** Product direction agreed
**Objective:** Give settings and administration room to breathe on a desktop
viewport, and make account actions predictable to find.

Complements ORB-FUT-002, which covers mobile and installed-PWA density only.
Desktop navigation is not in scope there.

### Intended experience

- Settings and administration are addressable pages with their own layout,
  rather than panels constrained inside a modal dialog.
- Those surfaces are visually distinct from the workspace, so it is obvious
  when the user is configuring Orbit rather than using it.
- Available desktop width is used instead of a dialog-sized column.
- An account control exposes settings, administration where the user holds
  instance-administrator authority, and sign out.
- Sign out is reachable from that control rather than from the foot of a
  settings panel.

### Acceptance criteria

- Settings and administration are reachable by route and render with their own
  layout.
- Administration entry points are absent, not merely disabled, for
  non-administrators, and the route enforces authority server-side.
- Sign out completes through the existing logout contract.
- Focus management, visible focus and the authenticated accessibility checks
  continue to pass on the new surfaces.
- Signed-out privacy behaviour is unchanged.
- Mobile density behaviour defined by ORB-FUT-002 is unaffected.

## ORB-FUT-012 — Prebuilt, digest-pinned installation

**Roadmap disposition:** Delivered as a v1.1 installation foundation
**Priority:** High
**Phase:** Post-v1 operations
**Dependencies:** Immutable image publication and exact-digest promotion
**Decision status:** Accepted in
[ADR-0008](adr/0008-installer-resolved-release-digests.md)
**Objective:** Make a source-less, non-interactive prebuilt install the
supported default without ever deploying a mutable image reference.

### Required outcome

- Installation is one pasteable command that requires neither Git nor
  interactive input.
- The installer resolves the stable discovery tag, validates the returned
  digest and records that immutable identity before deployment.
- Deployment assets and the image come from the same release, while building
  from source remains a separate explicit developer workflow.
- Resolution fails closed rather than falling back to a mutable reference or a
  local build when the expected digest or release assets are unavailable.
- The installed image and compose configuration retain the existing secret,
  authorization, backup and upgrade contracts.

The accepted contract uses `latest` for stable discovery and `preview` for the
protected candidate lane. A moving `dev` tag and an interactive
stable/development installer choice are not part of this requirement; `dev`
remains reserved and unpublished unless a later protected product/release
decision explicitly adopts it.

## Foundations every future direction must preserve

- Per-user email and browser-push reminder preferences.
- Atomic household ownership transfer with an audit record.
- PostgreSQL backup and transactional restore scripts.
- Automated signed-out browser privacy and accessibility checks.
