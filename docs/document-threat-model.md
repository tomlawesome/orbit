# Secure document threat model

This document defines the security boundary for `ORB-FUT-003`. It is a
version-controlled implementation requirement, not an aspirational checklist.

## Scope and decisions

Orbit will attach encrypted documents to household items using a local
persistent volume. The first release supports:

- PDF, JPEG, and PNG content identified from file signatures;
- a 25 MiB maximum file size;
- a 5 GiB default quota per household;
- a 20 GiB default quota per instance;
- 30-day soft deletion before irreversible purge;
- ClamAV scanning enabled by default and fail-closed when configured;
- an explicit administrator override that disables scanning, persistently
  warns administrators, and marks accepted documents as unscanned;
- a named Docker volume mounted at `/var/lib/orbit/documents`;
- container access only by Orbit's non-root UID/GID 1001;
- application-level envelope encryption from the first stored document.

The limits are administrator-configurable within safe integer bounds. Raising a
quota never bypasses per-request limits.

## Protected assets

- original document bytes and derived metadata;
- filenames and media types, which may themselves reveal private information;
- household/item associations and document existence;
- document encryption keys and the instance key-encryption key (KEK);
- scan results, retention state, audit events, and access history;
- availability and integrity of PostgreSQL, encrypted storage, and backups.

## Trust boundaries

1. **Browser to Orbit:** an authenticated but potentially malicious client
   submits metadata and bytes over HTTPS.
2. **Orbit authorization:** server-side session, household membership, and item
   ownership checks decide whether an operation is allowed.
3. **Quarantine:** untrusted plaintext exists temporarily while Orbit validates
   and scans it. It is never served to users from this state.
4. **ClamAV:** Orbit sends bounded plaintext over an internal-only Compose
   network using `clamd`'s streaming protocol. ClamAV receives no filesystem
   mount containing Orbit documents, database credentials, application
   secrets, or Docker socket.
5. **Encryption boundary:** only clean—or explicitly scan-skipped—content is
   encrypted for durable storage. Plaintext is removed after successful
   finalisation.
6. **Persistent storage:** the document volume contains ciphertext only.
   PostgreSQL contains metadata and wrapped per-document keys, not plaintext
   document keys or document bytes.
7. **Secrets:** the KEK is supplied through a dedicated Compose secret file.
   Because file-backed Compose secrets retain host ownership, a root-only
   bootstrap copies mounted secrets into a private in-memory filesystem,
   assigns them to UID/GID 1001 with mode `0400`, and immediately drops to that
   identity before starting Orbit. Secrets are not stored in Git,
   `.env-orbit`, PostgreSQL, the document volume, logs, or ordinary backups.
8. **Download:** Orbit re-authorizes each request, streams decryption through
   the application, and returns restrictive attachment headers.

## Threat actors

- unauthenticated internet clients;
- authenticated users attempting cross-household access;
- household members submitting malicious files;
- compromised or malicious documents targeting validators, ClamAV, browsers,
  parsers, or future AI processors;
- an attacker who copies PostgreSQL data, the document volume, or an ordinary
  backup without obtaining the KEK;
- operational mistakes, interrupted writes, disk exhaustion, stale membership,
  lost keys, and partial restores;
- a compromised optional processing container.

A fully compromised running Orbit process can access plaintext for authorized
operations and is outside the confidentiality guarantee of application-level
encryption. The design still limits lateral access and preserves auditable,
recoverable state.

## Required controls

### Authentication and authorization

- Every metadata, upload, download, delete, restore, and administration route
  requires a valid server-side session.
- Every operation verifies current household access and item ownership in the
  same server-side query/transaction used for the operation.
- Instance administrators retain the product's agreed super-user access,
  including document download. Every such access is authorized server-side and
  audited; administrators still receive no public or reusable URLs.
- Unauthorized and nonexistent document identifiers produce the same
  non-disclosing response.
- Membership removal takes effect on the next request; prior access does not
  create a durable capability.

### Upload and validation

- Reject requests exceeding 25 MiB before buffering the complete body where
  platform support permits, and enforce the limit again while streaming.
- Normalize display filenames, remove path components/control characters, and
  cap their encoded length. Storage keys never derive from user filenames.
- Identify supported types using magic bytes. Supplied media type and extension
  are advisory only.
- Reject archives, executables, polyglot signatures detected by validation,
  truncated signatures, empty files, and unsupported formats.
- Calculate a SHA-256 content hash while receiving bytes.
- Quotas are reserved transactionally before durable finalisation to prevent
  concurrent uploads from exceeding limits.
- Plaintext quarantine files use opaque names, restrictive permissions, and a
  directory inaccessible through HTTP.

### Parsing, OCR, and indirect prompt injection

- Treat every supported manual-upload format—PDF, JPEG, and PNG—as
  hostile throughout parsing and review. The PDF-only mailbox rule narrows
  transport input; it does not make mailbox PDFs more trusted or manual image
  uploads less dangerous.
- ClamAV detects known file threats. Parsers and OCR engines extract content.
  Neither function proves that extracted text, metadata, or suggested values
  are safe, accurate, or authoritative.
- Parser and OCR output is bounded untrusted evidence. It may populate only
  allowlisted, type- and length-validated editable suggestions; it cannot
  select authority, read secrets or unrelated records, fetch URLs, invoke
  tools, approve a draft, associate a document, or perform a household write.
- Explicit authenticated review is required before any suggested value or
  document association becomes household-visible.
- Any future model-backed extraction remains a tool-free, secret-free,
  network-isolated proposer. Its schema-constrained output receives the same
  validation and trust level as parser or OCR output.

### Malware scanning

- Default deployment uses the official ClamAV `1.4.5` LTS image and its
  maintained signature updater.
- `clamd` is reachable only on an internal Compose network and is never
  published to the host. Its TCP protocol is unauthenticated and unencrypted,
  so it must not cross an untrusted network.
- Orbit uses `INSTREAM` with bounded chunks, connection/read timeouts, and a
  scan-size limit no larger than Orbit's upload limit.
- Malware, scanner errors, timeouts, oversized-stream responses, and unavailable
  scanner state never become clean documents.
- When scanning is explicitly disabled, validation continues, the document
  records `scan_status=skipped`, and administrators see a persistent warning.
- Scanner responses are normalized to safe classifications; raw filenames or
  document content are not logged.

### Envelope encryption

- Each document receives a cryptographically random 32-byte data-encryption key
  (DEK).
- Content uses AES-256-GCM with a fresh unpredictable 12-byte IV and a required
  16-byte authentication tag.
- The envelope authenticates immutable context as additional authenticated
  data: envelope version, document ID, household ID, item ID, media type, and
  plaintext size.
- Each DEK is wrapped independently with AES-256-GCM under the active KEK using
  a separate fresh 12-byte IV and required 16-byte tag.
- Ciphertext and key envelopes include explicit version, algorithm, and key ID.
- Decryption rejects unknown versions, wrong tag lengths, invalid metadata, and
  authentication failure before returning any bytes.
- Key rotation rewraps DEKs transactionally. It does not decrypt and rewrite
  document ciphertext.
- Sensitive key buffers are kept short-lived and never serialized to logs or
  exceptions.

### Storage and state integrity

- Lifecycle transitions are explicit and compare the expected previous state.
- Database metadata never claims `available` until encrypted bytes are durably
  written and verified.
- Writes use a temporary file in the target filesystem, restrictive mode, file
  sync where supported, and atomic rename.
- Deletion is a 30-day reversible metadata state. Purge removes ciphertext
  first and then records completion; reconciliation safely retries either side.
- A periodic reconciliation job detects stale quarantine data, interrupted
  states, missing ciphertext, orphaned ciphertext, quota drift, and expired
  deletion windows.
- Unknown or inconsistent states fail closed and surface a safe administrator
  health warning.

### Download safety

- Downloads recheck current authorization immediately before opening storage.
- Responses use `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, a restrictive content security policy,
  and `Content-Disposition: attachment` with a safely encoded filename.
- Range requests and inline previews are not supported in the first release.
- Authentication-tag verification must complete successfully; corrupt content
  is not partially returned as a successful download.

### Availability and resource controls

- Bound upload duration, concurrent scans, scanner connections, database work,
  temporary disk use, and worker retries.
- ClamAV receives explicit memory/CPU guidance because signature loading is
  resource-intensive. Orbit reports scanner unavailability without making the
  rest of the application unhealthy.
- Disk exhaustion, quota exhaustion, and key unavailability return distinct
  administrator diagnostics but non-sensitive user errors.
- The application remains usable when the KEK is missing, but all document
  upload/download/rotation operations remain locked. Orbit never generates a
  replacement key automatically.

## Key generation, recovery, and loss

- `scripts/configure.sh` generates the KEK once using a cryptographically secure
  random source and writes it under `.orbit-secrets/document-kek` with
  user-only permissions.
- Compose mounts it only into Orbit at `/run/secrets/orbit-document-kek`.
  The startup bootstrap copies it to `/run/orbit-secrets/orbit-document-kek`
  on a private `tmpfs`, restricts it to Orbit's UID 1001, and then permanently
  drops root privileges before application code executes.
- An explicit recovery command creates a versioned encrypted recovery bundle.
  It reads a recovery passphrase twice from an interactive terminal, derives a
  wrapping key with a memory-hard KDF, and writes only encrypted key material.
  The passphrase is never accepted as a command argument or environment
  variable.
- Ordinary database/document backups exclude the plaintext KEK and state
  clearly that recovery requires the separately protected recovery bundle.
- Restore validation checks key ID and a non-sensitive verification value
  before enabling document access.
- If both the KEK and recovery bundle/passphrase are lost, encrypted documents
  are unrecoverable by design. Orbit must state this plainly during setup and
  backup.

The recovery-bundle implementation must use a reviewed, available primitive in
the supported runtime. It must not introduce a custom cipher construction.

## Backup and restore

- A complete ordinary backup contains a PostgreSQL custom-format dump plus the
  encrypted document tree and a signed or authenticated manifest of document
  IDs, storage keys, sizes, hashes, envelope versions, and key IDs.
- Backup creation uses restrictive permissions and a temporary path followed by
  atomic publication.
- Restore validates the archive and manifest before stopping Orbit, restores to
  staged storage, verifies database/blob correspondence, and only then switches
  the active document tree.
- Restore never silently overwrites an existing KEK.
- Mixed lifecycle states, missing blobs, corrupt tags, and a wrong KEK are
  covered by restore tests.

## Logging and audit

- Application logs contain opaque document/job IDs, safe state names, bounded
  error classifications, and timings only.
- Logs never contain filenames, document content, extracted text, hashes usable
  as cross-system identifiers, raw ClamAV responses, keys, IVs, tags, or
  recovery material.
- Household audit history records actor, action, document ID, item ID, safe
  state transition, and time. It does not copy document contents or secrets.

## Security tests

- signed-out and cross-household enumeration attempts;
- removed-member access and concurrent membership changes;
- traversal names, control characters, MIME mismatch, empty/truncated files,
  oversized requests, unsupported types, and malformed images/PDFs;
- EICAR detection, scanner timeout, scanner outage, malformed response, and
  explicit scan-disabled operation;
- encryption round trips, AAD mismatch, corrupt ciphertext/tag/wrapped key,
  unknown version, wrong KEK, and key rewrap;
- quota races, interrupted state transitions, missing/orphaned files, retention
  purge, and disk errors;
- backup/restore with mixed states and key verification;
- browser tests proving attachment-only delivery and signed-out privacy.

## Planned v1 intake extensions

Bounded document parsing and dedicated-mailbox ingestion are required v1
inputs to the same private, editable review flow. Direct upload accepts the
four document types above, while mailbox ingestion deliberately accepts only
PDF candidates. Incidental non-PDF MIME parts are ignored without download or
staging; a claimed PDF must pass bounded structural detection, malware
scanning, and encryption. A message with no PDF reaches a content-free private
terminal outcome rather than an empty review draft. Before mailbox enablement,
this model must cover authenticated envelope identity, hostile MIME and archive
limits, receipt idempotency, quarantine, retry/reconnect behaviour, cross-
household draft isolation, retention, redacted diagnostics, and explicit user
approval before any item write or attachment.

[ADR-0005](adr/0005-reviewed-ingestion-and-mailbox-staging.md) establishes that
boundary. Mailbox input is identified only through a configured
provider-preserved envelope-recipient header and a versioned HMAC alias. Orbit
does not persist raw messages, active content, archives, malware, or incomplete
staging. Supported clean PDFs are encrypted into user-owned staging
that is neither household data nor downloadable through item routes. Receipt
identity, recipient-scoped content identity, leases, bounded retries, expiry,
and purge must remain idempotent across polling, restart, UIDVALIDITY rollover,
approval, discard, and alias-key rotation.

Approval rechecks the user, selected household, section, existing-item target,
draft version, and staged source identity. Only that explicit command may
create an item or transfer a staged attachment through the secure document
lifecycle. Quarantined and failed views expose technical classifications and
opaque identifiers only.

Inline previews, OCR, model-dependent semantic extraction, public sharing, S3
storage, archive uploads, and automatic duplicate merging remain deferred.
Each must extend this threat model before implementation.
