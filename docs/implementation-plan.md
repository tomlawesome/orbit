# Orbit implementation plan

This document is the version-controlled source of truth for active delivery
work. Longer-term product directions remain in the
[deferred feature register](feature-register.md). Decisions that affect an
active phase must be recorded here or in a more focused document under
`docs/`; they must not depend on a particular Codex task or local assistant
memory.

## Planning conventions

- Keep only one active implementation phase.
- Record agreed architecture before writing migrations or production data.
- Mark completed work with the merge commit or pull request.
- Move newly proposed product work to the feature register rather than
  expanding the active phase silently.
- Preserve Orbit's supported deployment shape: one Orbit application container
  plus standard PostgreSQL. Established security or processing services may be
  separate, replaceable containers.
- Every phase must preserve household isolation, signed-out privacy,
  auditability, backup/restore, and local-only document processing.

## Current baseline

The operational hardening and CI-gating pass is complete as of pull request
[#1](https://github.com/tomlawesome/orbit/pull/1), merged as `5d6bbc8`.

`main` now requires:

- a pull request;
- successful `Static and unit checks`;
- successful `Compose smoke test`;
- resolved review conversations;
- protection from force-push and deletion.

Static analysis and unit tests run before container, browser, accessibility,
and privacy checks. Pull-request runs never publish images. ARM64 publishing is
reserved for versioned releases or an explicit manual request.

## Release promotion policy

`release/secure-documents` is Orbit's integration branch for accepted release
candidates. It may receive focused, CI-gated pull requests while the agreed
feature set is being completed. Do not promote changes to `main`, update the
public `latest` image, or declare a stable public release until the required
roadmap is complete through: reviewed Tika extraction, data portability,
household lifecycle/deletion, mobile capture, reviewed document drafts and
duplicate handling, IMAP ingestion with SMTP notifications, and final
operational polish. Local Ollama-assisted extraction is explicitly optional and
requires a fresh product decision at that stage.

## Completed phase: secure document management

**Register entry:** `ORB-FUT-003`
**Status:** Implementation complete and manually accepted as
`rc-2026.07.26.27` (digest
`sha256:16696e706eb7bee9aa07443d619ee1193e100e7475fdf1997cb9d46685ff8594`)
**Goal:** Attach durable, private, malware-scanned and encrypted documents to
household items before adding email ingestion or automated extraction.

### Architecture

1. Add a provider-neutral document storage interface.
2. Implement a persistent local-volume provider first.
3. Preserve an S3-compatible provider boundary without implementing S3 during
   this phase.
4. Store document metadata and lifecycle state in PostgreSQL.
5. Use established ClamAV as a separate default scanner service; do not build
   antivirus into the Orbit image.
6. Keep parsing, OCR, and semantic extraction out of this phase.

The binding security analysis is maintained in the
[secure document threat model](document-threat-model.md).

### Document lifecycle

```text
receiving -> validating -> quarantined -> scanning -> encrypting -> available
                  |              |           |
                  +--------------+-----------+-> rejected

available -> pending_deletion -> deleted
```

State transitions must be explicit, transactional where possible, idempotent,
and recoverable after container restarts. A reconciliation job handles
interrupted uploads, missing blobs, and orphaned storage objects.

### Envelope encryption

Application-level document encryption is required from the first production
document; it is not deferred work.

- Generate an independent random data-encryption key for every document.
- Use a reviewed authenticated encryption construction, initially
  AES-256-GCM.
- Validate and malware-scan plaintext while it is quarantined, then encrypt it
  before final durable storage.
- Wrap each data-encryption key with an instance key-encryption key.
- Store ciphertext in the document volume.
- Store only the wrapped data key and versioned cryptographic metadata in
  PostgreSQL.
- Supply the instance key through a dedicated secret file. Never store it in
  PostgreSQL or `.env-orbit`.
- Version the envelope format, algorithms, and key identifiers from the first
  release.
- Rotate the instance key by rewrapping document keys rather than re-encrypting
  all document bytes.
- Treat key backup and recovery as a mandatory part of backup/restore.

This protects copied document volumes and database backups. It does not claim
to protect plaintext from a fully compromised running Orbit instance.

### Upload and storage security

- Stream uploads with bounded memory and request time.
- Use generated opaque storage identifiers and prevent path traversal.
- Inspect content instead of trusting filenames or supplied media types.
- Start with a deliberately narrow supported set such as PDF, JPEG, PNG, and
  WebP.
- Apply configurable per-file, per-household, and instance storage limits.
- Reject executables, archives, MIME mismatches, decompression bombs, and
  unsupported active content.
- Keep unfinished and unscanned files unavailable to users.
- If ClamAV is unavailable, remain quarantined and fail closed.
- Never give scanner services database credentials, Orbit secrets, Docker
  socket access, or unrestricted host access.

### Authorization and delivery

- Require authentication and current household permission for every document
  operation.
- Recheck authorization when opening every byte stream.
- Do not issue public or reusable document URLs.
- Default downloads to safe attachment headers rather than inline rendering.
- Do not reveal document existence, identifiers, metadata, or error
  distinctions to signed-out or unauthorized callers.
- Audit upload, scan result, download, attachment, deletion, restoration,
  retention purge, and key-rotation events without logging document contents.

### Product scope

- Upload documents while creating or editing an item.
- Display bounded progress and clear validation/scan states.
- List document name, type, size, upload time, and safe operational state.
- Download, remove, and—where policy permits—restore documents.
- Support mobile file selection and camera capture without compromising the
  compact PWA layout.
- Give administrators scanner, storage, quota, reconciliation, and key-version
  health without exposing document content.

### Backup and retention

- Back up metadata and encrypted bytes consistently.
- Keep the key-encryption key outside ordinary database and document-volume
  backups, with an explicit recovery procedure.
- Verify restored document hashes and encryption metadata before availability.
- Test restoration with mixed document states.
- Implement a bounded soft-delete window followed by irreversible purge once
  the owner confirms the retention default.

### Test requirements

- Unit tests for state transitions, storage keys, validation, envelope
  encryption, authentication failure, and key wrapping/rotation.
- Authorization tests across households, roles, removed members, and signed-out
  callers.
- Tests for malicious names, traversal, MIME mismatch, oversized input,
  truncated input, unsupported content, scanner outage, malware detection, and
  interrupted processing.
- Container integration using ClamAV's standard antivirus test signature.
- Backup/restore round trip with byte hashes and encryption metadata.
- Playwright upload, state display, download, deletion, mobile capture, and
  signed-out privacy checks.
- Existing static, unit, Compose, browser, accessibility, and privacy gates
  remain required.

### Delivery sequence

1. Write the threat model and confirm the unresolved policies below.
2. Add schema migrations and the document lifecycle model.
3. Implement and test the versioned encryption and storage interfaces.
4. Add bounded quarantined uploads and content validation.
5. Add the ClamAV adapter and default Compose service.
6. Add authorized download, deletion, retention, and audit behaviour.
7. Add item and mobile document interfaces.
8. Extend backup, restore, reconciliation, health, and key-rotation tooling.
9. Complete security, integration, browser, and accessibility testing.
10. Deliver through a focused PR and the protected GitHub workflow.

### Confirmed implementation decisions

- 25 MiB maximum file size.
- 5 GiB default household quota and 20 GiB default instance quota.
- PDF, JPEG, PNG, and WebP identified from content signatures.
- 30-day soft deletion.
- ClamAV enabled by default and fail-closed. Administrators may explicitly
  disable scanning with persistent warnings and unscanned status.
- Missing encryption keys lock document operations without preventing the rest
  of Orbit from starting. A replacement key is never generated automatically.
- Recovery uses an explicit passphrase-encrypted bundle stored separately from
  ordinary backups.
- A named volume is mounted at `/var/lib/orbit/documents` and accessed only by
  Orbit's non-root runtime UID/GID 1001.

## Following phases

After secure documents are complete:

1. `ORB-FUT-004` administrator operations and job visibility, where not already
   delivered by the document phase.
2. `ORB-FUT-002` mobile/PWA information-density improvements.
3. `ORB-FUT-006` data portability, including encrypted document archives.
4. `ORB-FUT-007` refined mobile document capture.
5. `ORB-FUT-001` intelligent IMAP ingestion and outbound SMTP.

Email ingestion must not precede secure storage, malware scanning, review,
duplicate handling, and administrative job visibility.

## Completion checklist

Keep this ordered list stable and update its status in place so release progress
is visible without renumbering work already completed.

1. **Release integration and acceptance** — In progress: CI-gate and manually
   accept the current mobile, lifecycle and optional-Tika candidate.
2. **Reviewed Tika extraction** — In progress: optional private Tika profile,
   bounded adapter and a user-visible review draft are implemented. A
   representative-document trial and administrator acceptance remain.
3. **Data portability** — In progress: household-scoped, passphrase-encrypted
   JSON exports with optional bounded original-document bytes, 24-hour private
   storage, audited request/download and maintenance purge are implemented.
   Conflict-aware import preview and transactionally committed metadata import
   are implemented. Original document bytes are excluded from import pending
   normal scan/encryption.
4. **Household lifecycle** — In progress: typed-confirmation removal hides a
   household from every member immediately, while an owner or instance
   administrator can restore its minimal recovery record for 30 days before
   worker-driven purge; add integration coverage before acceptance.
5. **Mobile document capture** — In progress: direct camera/file capture,
   visual review/rotation, progress and retry are implemented; browser
   acceptance coverage remains.
6. **Document draft creation** — In progress: bounded evidence and a
   user-approved create-item path are implemented; acceptance coverage remains.
7. **Duplicate comparison** — In progress: household-scoped hash, reference,
   provider/title and date-overlap candidates with create, merge and attach-only
   choices are implemented; browser acceptance coverage remains.
8. **IMAP and SMTP workflow** — In progress: pnpm 11 and maintained ImapFlow
   are now in use. Dedicated-mailbox configuration is TLS-only, secret-backed,
   requires SMTP, and uses opaque per-user aliases verified against a
   provider-injected recipient header. The worker immediately scans and encrypts
   verified attachments, then creates a hidden archived review item as soon as a
   household is known (automatically for a sole membership, explicitly for a
   multi-household user). The recipient selects a section to make it visible.
   Users can discard review items safely and a durable SMTP receipt worker
   records retries/failures without retaining provider details. Live provider
   acceptance remains.
9. **Optional local Ollama extraction** — Optional infrastructure is available
   through the private `docker-compose.full.yml` overlay, with bounded local
   Ollama and no cloud-model fallback. Application-level, schema-constrained
   reviewed draft extraction remains a separate product decision after the
   Tika-based workflow has been tested on representative documents.
10. **Final operational and release polish** — Planned: provider diagnostics,
    documentation, acceptance testing and promotion to `main`/`latest`.

## Active phase: administrator operations

`ORB-FUT-004` is being developed on the stacked
`feature/admin-operations` branch, based on the accepted secure-document
release.

The phase adds bounded worker/provider health, safe queue summaries,
state-checked retry/discard actions, SMTP connection verification, and
cursor-paginated audit history. Its binding information-disclosure and
state-transition rules are in
[administrator operations](administrator-operations.md).
