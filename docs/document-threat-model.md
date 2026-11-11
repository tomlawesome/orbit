# Secure document threat model

This document defines the security boundary for `ORB-FUT-003`. It is a
version-controlled implementation requirement, not an aspirational checklist.

## Scope and decisions

Orbit will attach encrypted documents to household items using a local
persistent volume. The first release supports:

- PDF, JPEG, and PNG content identified from file signatures;
- a 50 MiB default maximum file size, which an administrator can change
  in Administration within hard bounds of 1 to 100 MiB (#1285);
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
3. **Quarantine:** untrusted plaintext exists temporarily while Orbit types it
   by magic bytes, scans it and then opens it to find a page. It is never
   served to users from this state, and nothing opens it until the scan has
   passed ([ADR-0033](adr/0033-document-safety-standard-patterns.md)). The
   server holds one copy of the file for the open check, and encrypts it from
   the quarantine file in pieces, verifying its digest as it goes (#1567).
4. **ClamAV:** Orbit sends bounded plaintext over an internal-only Compose
   network using `clamd`'s streaming protocol. ClamAV receives no filesystem
   mount containing Orbit documents, database credentials, application
   secrets, or Docker socket.
5. **Encryption boundary:** only clean—or explicitly scan-skipped—content is
   encrypted for ordinary durable storage. A retryable scanner outage may
   create only authenticated-encrypted recovery ciphertext in the separate
   private `staging/` namespace; its purpose is bound into the envelope and it
   is never downloadable, draftable, parseable or actionable. Plaintext is
   removed after the synchronous attempt or worker recovery.
   The recovery worker decrypts a staging object into a quarantine file and
   verifies its authentication tag before the scanner or anything else reads
   it; the recovered bytes must match the upload's recorded digest.
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

- Reject requests exceeding the effective size limit (the administrator's
  setting, or `DOCUMENT_MAX_BYTES` when none is set; never over 100 MiB)
  before buffering the complete body where platform support permits, and
  enforce the limit again while streaming.
- Normalize display filenames, remove path components/control characters, and
  cap their encoded length. Storage keys never derive from user filenames.
- Identify supported types using magic bytes. Supplied media type and extension
  are advisory only.
- Reject archives, executables, polyglot signatures detected by validation,
  truncated signatures, empty files, and unsupported formats. A file that is
  not a PDF, JPEG or PNG by magic bytes is refused before it is scanned or
  opened.
- Calculate a SHA-256 content hash while receiving bytes. It is stored sealed
  under the household key (#1771); a row uploaded while that key was locked,
  or stored before #1771, keeps it plain until the maintenance backfill
  reaches it.
- Quotas are reserved transactionally before durable finalisation to prevent
  concurrent uploads from exceeding limits.
- Plaintext quarantine files use opaque names, restrictive permissions, and a
  directory inaccessible through HTTP.

### Parsing, OCR, and indirect prompt injection

- Treat every supported manual-upload format—PDF, JPEG, and PNG—as
  hostile throughout parsing and review. The PDF-only mailbox rule narrows
  transport input; it does not make mailbox PDFs more trusted or manual image
  uploads less dangerous.
- Scan first: ClamAV scans every file before anything opens it. The order on
  every route in (upload, the create form's inspection, mail-in and the
  pre-attachment preview) is magic-byte typing, then the ClamAV scan, then
  the open check below, then reserving durable upload metadata. No poppler
  tool, image decoder or Tika call sees a byte of a file that has not passed the
  scan. An upload held for a scanner outage is opened only after its recovery
  scan; one the open check then refuses is rejected as
  `unsupported_structure` with scan status clean and is never encrypted for
  durable storage or published. The reading card tells the reader it is
  scanning, then that it has moved on to generating the preview
  ([ADR-0033](adr/0033-document-safety-standard-patterns.md)).
- The open check is pattern E of ADR-0033: the program that will draw the
  file opens it and finds a page. For a PDF, poppler's `pdfinfo` opens it with
  no password and must read a page count between one and 100 and a size for
  page one (`password_required` when it needs a password to open,
  `unsupported_structure` for anything else). For a JPEG or PNG, the
  dimensions declared in the header are read first and must be within 20,000
  pixels a side and 40 million in all, then the preview renderer's own decoder
  must read the image in the sandbox child. These limits are Orbit's own
  because no library sets them. Magic bytes alone are not proof that a file
  opens. The page count is stored on the document (#1436).
- PDF files are opened only by poppler, a C++ program the server process
  never links ([ADR-0046](adr/0046-poppler-renderer-and-kept-previews.md),
  amending [ADR-0038](adr/0038-pdf-structure-check-in-a-sandboxed-worker.md)).
  Every check is a `pdfinfo` process and every page draw a `pdftoppm`
  process, started through `/bin/sh` so the kernel limits apply before the
  program runs: `RLIMIT_CPU` at the job's wall clock plus five seconds,
  `RLIMIT_AS` at the memory ceiling plus 128 MiB. The child has an empty
  environment, reads the plaintext through an inherited read-only descriptor
  to a file on the memory-backed quarantine (unlinked before the child starts
  when the server wrote it for the job, so a crash leaves nothing on disk),
  writes its answer to stdout and its messages to a 4 KiB in-memory tail that
  is never logged. The server polls the child's resident memory every 25 ms
  and kills it past the ceiling (64 MiB for a check, 256 MiB for a draw) or
  past the clock (5 s, 15 s). poppler survives a refused allocation by
  printing `Out of memory` and drawing a blank, so that message is read as a
  memory stop whatever the exit code.
- A stop is not a verdict. A check that is killed, crashes, cannot start or
  cannot open its file answers `structure_check_unavailable`, the request
  fails with 503 `document_check_unavailable` ("please try again", #1593),
  scan recovery checks a staged copy again rather than purge it, and nothing
  is stored. Boot warns if `/bin/sh`, `ulimit -v` or `/proc`, which the
  sandbox relies on, is missing. The child still shares the server's files
  and network.
- What a hostile PDF can do is spend CPU, and only up to the clock: a content
  stream of 128 MB, a 900 megapixel image, 150 shading fills or a tiling
  pattern that never ends were measured at 13-19 MiB of memory each; the
  pattern was killed by the clock. A damaged 97 MB cross-reference table is
  rebuilt by poppler inside 13 MiB in under a second, so no model of the
  reader's index walk is kept in the server (the bound ADR-0033 and ADR-0038
  described is retired). The one legitimate image kind that needs memory,
  JPEG 2000, is decoded whole by OpenJPEG before poppler scales it; the
  ceiling admits it to about 18 megapixels and refuses it beyond.
- Jobs are slotted: two for checks (uploads, mail-in, the create form), two
  for pages someone is looking at, one at `nice 10` for background drawing. A
  burst of page turns therefore cannot delay an upload check. Memory in the
  worst case is five children: about 900 MiB resident and 1.5 GiB of address
  space, inside the 2 GB default limit.
- The parser is a GPL program in the image, executed over argv, a descriptor
  and pipes; Orbit links none of it. Its updates arrive with the base image's
  Alpine release; an unbackported poppler CVE is the trigger to rebuild early
  (`docs/supply-chain.md`).
- Orbit does not refuse a PDF for what it contains. JavaScript, open and
  link actions, XFA forms, embedded files, owner-password-only encryption
  ("no editing" certificates) and encrypted object streams are all accepted
  when poppler opens the file. A PDF that needs a password to open is refused,
  as a product limit rather than a safety one: nothing in Orbit could show,
  read or scan it. Nothing in a PDF runs in Orbit: `pdftoppm` draws the page
  as a raster and runs no document JavaScript, follows no link or action and
  fetches nothing. Orbit shows people only a picture it draws on the server.
- The original is kept as it arrived and is downloadable. A downloaded PDF
  carries whatever it carries, scripts and attachments included, and a person
  who opens it in another reader is in the same position as with any email
  attachment. Orbit serves downloads as attachments under
  `default-src 'none'; sandbox` and `nosniff`, and has no in-browser PDF
  viewer. If one is ever added it gets PDF.js with scripting off and a page
  content security policy.
- ClamAV detects known file threats. Parsers and OCR engines extract content.
  Neither function proves that extracted text, metadata, or suggested values
  are safe, accurate, or authoritative.
- Parser responses must be content-type checked, strictly decoded, and bounded
  before allocation. Redirects and arbitrary request URLs or options are
  rejected. Parser errors expose no provider or document content.
- poppler and the image decoder are the parsers of untrusted bytes in
  Orbit's own code, and they open only files ClamAV has passed. Neither runs
  in the server's process: a PDF page is one `pdftoppm` process under the
  limits above, returning a JPEG under the render budget (fifteen seconds);
  an image document is decoded in a Node sandbox child with its own
  process-memory ceiling (768 MB), heap cap and empty environment (ADR-0038,
  as amended for #1427). Running out of memory, timing out or crashing
  answers `document_preview_failed` and logs one record with no file detail.
  Source checks (`tests/unit/pdf-no-parser-in-server.test.mjs`,
  `tests/unit/pdf-no-in-process-reader.test.mjs`) fail if anything on the
  server names a PDF parser or loads the canvas backend outside the sandbox.
  Keeping them patched is the standing cost. The optional Tika service
  remains the separately isolated parser/OCR boundary described below.
- The optional Tika service shares only a dedicated internal network with the
  Orbit application. It has no network path to PostgreSQL, default-network
  services, or external networks. The pinned image runs as UID/GID 35002,
  drops all capabilities, uses a read-only root filesystem and a bounded
  private tmpfs, and mounts only its read-only configuration.
- Orbit sends bytes only to the fixed `/tika` endpoint with fixed
  no-embedded-recursion and no-OCR headers. The server configuration also
  excludes `TesseractOCRParser` and also sets Tika 4.1's `text-recognizers: []`,
  so two independent settings keep OCR off. OCR is disabled in v1 and
  requires a separate opt-in design with bounded pages, languages, resources
  and adversarial evidence before it can be enabled.
- Parser and OCR output is bounded untrusted evidence. It may populate only
  allowlisted, type- and length-validated editable suggestions; it cannot
  select authority, read secrets or unrelated records, fetch URLs, invoke
  tools, approve a draft, associate a document, or perform a household write.
- Raw processor responses are discarded after proposal derivation. An
  authorised reviewer may receive only a 2,000-character, normalized
  plain-text evidence excerpt with markup delimiters, controls and bidi
  formatting removed. Logs, errors, diagnostics, audits and test artifacts do
  not contain that excerpt or the raw response.
- Explicit authenticated review is required before any suggested value or
  document association becomes household-visible.
- Any future model-backed extraction remains a tool-free, secret-free,
  network-isolated proposer. Its schema-constrained output receives the same
  validation and trust level as parser or OCR output.

### Malware scanning

- Default deployment uses the official ClamAV `1.4.5` LTS image and its
  maintained signature updater.
- `clamd` is reachable from Orbit only on the internal document-processing
  network and is never published to the host. FreshClam receives a separate
  signature-update network with no route to PostgreSQL or default-network
  services. The unauthenticated, unencrypted clamd TCP protocol never crosses
  an untrusted network.
- Orbit uses `INSTREAM` with bounded chunks, connection/read timeouts, and a
  scan-size limit no larger than Orbit's upload limit.
- Malware, scanner-reported errors, timeouts, oversized-stream responses, and
  unavailable scanner state never become clean documents. Only adapter
  `unavailable`, `timeout`, and `protocol` outcomes enter bounded recovery;
  generic `scanner` errors fail closed without a durable stage.
- Recovery uses `scanning` plus `scan_status=error`, a PostgreSQL `scan` job,
  ten-minute lease/token/generation fencing, five automatic attempts, fixed
  60-second/2-minute/4-minute/8-minute/15-minute delays, and immutable 24-hour
  retention. Manual retry does not extend retention. Terminal purge failure
  leaves an inaccessible `purge_pending` backlog and never claims success.
- The scan precedes every parser (see "Parsing, OCR, and indirect prompt
  injection"). Scanner-unavailable behaviour is unchanged: the upload is held
  for recovery, and inspection, preview and mail-in are refused.
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
- Scanner-recovery stage deletion follows the same fail-closed rule. Malware,
  invalid staging, operator discard and expiry reject metadata immediately;
  encrypted stage bytes are removed idempotently, and deletion failure is
  recorded as `purge_pending` for the administrator purge backlog.
- A refused upload's `rejected` row (no bytes, only its name, size, hash and
  refusal reason) is kept for 45 days from the rejection, so the item can still
  show it was refused, and is then deleted by the document worker in small
  batches (#1786). A row whose staged bytes may remain (any staging row, a
  failed stage purge included) is kept until they are gone. While it is kept, a
  repeat upload of a malware verdict under the same id is refused without a
  fresh scan; after it goes, a repeat is scanned again and refused again. The
  `document_rejected_*` audit events are kept.
- A periodic reconciliation job detects stale quarantine data, interrupted
  states, missing ciphertext, orphaned ciphertext, quota drift, and expired
  deletion windows.
- Unknown or inconsistent states fail closed and surface a safe administrator
  health warning.
- A file staged for an item that has not been saved yet (#1406, see
  [the design note](adr-notes/1406-stage-then-bind.md)) is an unbound
  `available` document, held for at least 24 hours (longer when scanner recovery
  keeps rows for longer; see the design note) and counted against the household's
  quota while it is held. A member of the household can create one without ever
  saving an item. The storage sweep moves an expired unbound document to
  `pending_deletion` for the normal purge. Binding it to an item requires the
  same household, a document that is not rejected, deleted or pending
  deletion, and a sealed item id that matches the item being saved; anything else is refused with one identical 422.

### Download safety

- Downloads recheck current authorization immediately before opening storage.
- Responses use `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, a restrictive content security policy,
  and `Content-Disposition: attachment` with a safely encoded filename.
- Range requests are not supported in the first release.
- Authentication-tag verification must complete successfully; corrupt content
  is not partially returned as a successful download. The tag is verified in
  one pass over the stored ciphertext before the first plaintext byte is sent;
  the plaintext is then decrypted again in pieces into the response, never
  written to disk and never held whole (#1571).

### Page preview safety

- `GET /api/documents/{documentId}/preview` renders one page of a stored
  document as an image so a person can recognise and read it (#476): page one,
  or any requested page `?page=N` up to the document's stored page count,
  itself at most 1,000 (#1300, #1433 answer 10a). A malformed, zero, negative
  or past-1,000 page is refused with a 400 before the
  document is read; a page past the document's stored page count is a 404
  answered after authorization and readiness but before storage is read
  (#1433), and, for a document whose count is not stored yet, only after
  every check below has passed. The response's `X-Orbit-Page-Count`
  header is the page count stored from the open check, or `pdfinfo`'s
  count beside the draw for a document from before it was stored (1 for an
  image). It is
  reachable exactly where a download is: it obtains plaintext through the same
  authorization, readiness and integrity path, and refuses everything a
  download refuses with the same non-disclosing response.
- The read is audited as `document_previewed`, with the item and the page,
  distinct from `document_downloaded`, so an image request is never recorded
  as a whole-document export. Every authorized read is audited once, whether
  it is served from the kept pages, drawn on demand, or answered from a
  remembered refusal (below).
- A PDF page is drawn by `pdftoppm` under the limits above (15 s, 256 MiB,
  `RLIMIT_AS` 384 MiB), one process per page, from the plaintext on an
  owner-only file in the memory-backed quarantine that is unlinked before the
  child starts; the child reads it through descriptor 4. The plaintext is
  decrypted from the stored object straight into one buffer, with the tag
  verified before it is used (#1571), and that buffer is zeroed on every
  exit, including failures. The answer is accepted only if the process exited
  0 without `Out of memory` and stdout is a JPEG between 3 bytes and 4 MiB
  whose declared size is at most 1,200 px a side; anything else is a failed
  render. The browser never receives poppler's messages or any detail of why
  a drawing failed beyond the fixed codes. Images are drawn in the image
  sandbox child.
- Bytes are re-identified and re-inspected before rendering rather than trusted
  from the stored media type. Anything the open check refuses answers
  `document_preview_unsupported`; a render that fails or exceeds its wall-clock
  budget answers `document_preview_failed`. Neither becomes a server error.
- Output is bounded to a 1200-pixel long edge and carries the download
  response's headers: `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff` and a restrictive content security policy.
- `GET /api/imap-inbox/{receiptId}/attachments/{attachmentId}/preview` draws
  a page of an attachment still waiting in a mail receipt (#1155), for the
  mail's recipient only, through the same renderer, `page` parameter and
  headers.
- `POST /api/households/{householdId}/item-document-preview` draws the same
  page (one, or `?page=N`) from a file the create form has just been given, before any item
  exists for it (#1245). It takes the inspection route's temporary-upload
  shape and retains nothing: the bytes are received into quarantine,
  identified, scanned by ClamAV where the instance scans (a scanner refusal
  answers exactly as the inspection and upload paths do, and malware is
  refused before anything is drawn), drawn from the quarantine copy through the
  renderer above, then zeroed and discarded. The answer is a private, unsniffed NDJSON
  stream: a line saying whether the scan passed or scanning is off, so a
  screen says "scanned clean" only when something scanned it, then the page
  and the page count, or an error line. Household membership is required, as for inspection.

#### Kept pages (#1433, ADR-0046 Part B)

**Kept pages.** Each drawn page is stored once, as the originals are: one
object under `previews/` per page, AES-256-GCM with its own random data key
wrapped under the active document KEK, in the same envelope and with the same
sealer and unsealer. The authenticated data binds the page to its document,
household, item, page number and purpose (`preview`), and the key wrap to the
purpose `orbit-document-preview-dek`, so a preview object cannot be opened
as a document, a document as a preview, or page 3 as page 4, by anyone with
the KEK and the storage. A row in `document_previews` holds the envelope, the
storage key and the sizes; a stored object without its row, or a row without
its object, is found by reconciliation and the page redrawn. Integrity
failure on a kept page is reported as it is for a document and logged once.
KEK rotation rewraps previews as a population of its own and is not complete
until they are on the new key. Backups carry previews with the documents;
portable archives do not (derived, redrawn after import).

**Deletion.** Purge deletes every preview object before the document object
and before the document's row is finalised, so a terminal row never points
at bytes; `pending_deletion` keeps them for restore but readiness refuses to
serve them. Deleting a household deletes them with its documents. After an
import rollback, or a household delete racing a worker, preview objects stay
until the 24 h orphan sweep, unreadable because their key rows are gone.

**Refusals.** A page whose drawing is stopped or invalid is remembered as
`refused` with its reason; the next request answers the same error without
starting a process, so a hostile file costs one bounded drawing per page,
ever, and cannot be used to keep a renderer busy by repeated viewing. A
timeout or crash is retried once by the background drawer (a busy host is the
likely cause); a memory or parser refusal is final until the renderer changes.
A failure on Orbit's side (no space, a missing tool) is the file's fault in
no way and is never stored: the view answers 503 `document_preview_busy` with
Retry-After, and the drawer releases the job and tries again later.

**Scheduling.** The background drawer draws every available document's pages
once, ten pages per turn at the lowest priority in its own slot, so an
upload check or a viewer's page turn never waits for it and a hundred-page
document does not hold back a one-page one. It holds at most one decrypted
document at a time on the memory-backed quarantine, unlinked before the child
starts. A full quarantine is a retry, not a refusal.

**What this does not protect against.** A member who may download the
document may of course see every page of it; previews add no information a
download would not. The kept pages double the ciphertext footprint of a
scanned document by roughly a fifth per page, which an administrator sees in
document health. A page the renderer draws wrongly (a poppler bug) is kept
until the renderer constant is bumped, which redraws everything.


### Availability and resource controls

- Bound upload duration, concurrent scans, scanner connections, database work,
  temporary disk use, and worker retries.
- ClamAV receives explicit memory/CPU guidance because signature loading is
  resource-intensive. Orbit reports scanner unavailability without making the
  rest of the application unhealthy.
- Disk exhaustion, quota exhaustion, and key unavailability return distinct
  administrator diagnostics but non-sensitive user errors.
- An instance with no usable KEK locks itself to everyone until the key is
  restored (#1405, ADR-0024 amendment; see "Household metadata encryption"
  below). Orbit never generates a replacement key automatically.

## Household metadata encryption (Tiers 1 and 2)

ADR-0024 extends the same envelope encryption to household metadata, in the
tiers #365 names.

**Tier 1** is `items.notes`, `items.reference`,
`imap_ingestion_messages.proposal`,
`imap_ingestion_messages.field_evidence` and, since #1396, the approval
request a mailbox approval accepted, `imap_ingestion_messages.approval_request`
(ADR-0005 amendment), under the same key as the receipt's draft.

**Tier 2** is `items.title`, `items.provider` (a provider *name*), the cost
`items.cost_minor`, the invited member address `household_invitations.email`,
and, since #969, every account address: `users.email` and the mail-forwarding
sender address `mail_in_sender_addresses.address`. Those two account addresses
sit under the instance key rather than a household one, because a person
belongs to several households and a forwarded message is matched to its sender
before any household is known. Since #1316 the identity provider's ID token
kept for sign-out, `sessions.id_token`, sits under the instance key too, bound
to its own session row and deleted with it. Everything else in Tier 2 uses the same
household key as Tier 1, and all of it the same envelope and the same rotation
path — no second cipher. What it costs is queries: the database can no longer search titles,
match provider names or add up costs, so Orbit does all three in the
application over one household's decrypted rows. Measured on a seeded
database, that decrypt-and-scan takes about 4.5 ms for a 100-item household
and about 28 ms at 500 items, the most one household's item list can hold —
against a whole workspace read of roughly 48 ms and 105 ms respectively.

**Tier 3 stays deliberately in plaintext**: due dates, statuses, recurrence,
and household and member relationships. That is the scheduling engine's
operating data — the dial, the reminder workers and the due-window queries all
run on it in SQL — and encrypting it would move those queries into the
application for no gain the threat model recognises. Host-disk encryption is
the answer for Tier 3, not this. It is a decision, not an omission.

**The boundary this buys, stated plainly.** It protects against leakage of the
database file: an exfiltrated volume, a SQL dump, a filesystem backup, a stolen
disk. It does **not** protect against live compromise of the host, because the
key-encryption key lives there and a running Orbit can read every value. It is
the same boundary document encryption already has, no stronger, and no Orbit
surface may describe it as more than this.

- One random 32-byte metadata data-encryption key per household, wrapped under
  the existing instance KEK (`DOCUMENT_KEK`), plus one instance-scope key for
  mail-in receipts that are not attributed to a household yet, account
  addresses (#969), and the identity provider's ID token kept on each session
  that began at the provider so sign-out can name it (#1316). Deleting a
  household deletes its key, which crypto-shreds any stray copy of that
  household's ciphertext.
- Each value is one AES-256-GCM envelope, `mdv1.<iv>.<tag>.<ciphertext>`,
  bound to its table, column and row: a value moved to another row or column
  fails authentication instead of decrypting.
- Three columns carry a blind index, and only three: `items.reference`,
  `household_invitations.email` and `documents.content_sha256`. Nothing else
  does, because nothing else is looked up by exact match — titles, provider
  names and costs are compared by readers that already read every row of the
  household, so an index would serve no query while leaking equality for
  nothing. The invitation address has one because the database itself
  enforces "one open invitation per household and address", and clearing the
  plaintext would otherwise have retired that rule silently. The document
  fingerprint has one, `documents.content_index`, for one query: "you already
  hold this document" (#1437, ADR-0024 amendment), which looks for an
  available, filed document with the same bytes in the uploading household
  only. It reveals which of a household's documents are byte-for-byte equal,
  which that household can already see. The SHA-256 itself is sealed under the
  household key in `documents.content_sha256_sealed`, bound to its row
  (#1771, ADR-0024 amendment), so a database dump cannot confirm a known file
  or match equal files across households. Rows stored before #1771, or uploaded while
  the household key was locked, keep a plain `documents.content_sha256` only
  until the maintenance backfill reaches them; the column is dropped in a later release (#1779). The mail-in tables
  still hold plain attachment hashes (#1778).
- The blind index is HMAC-SHA-256 over the
  normalised value, keyed by a key derived from the household's own data key
  and never stored, and derived separately per column so two columns never
  correlate. Within one household it reveals which rows share an equal value
  and how many distinct values exist; it reveals nothing about the values
  themselves, and because the key is per-household, equal values in different
  households produce unrelated digests. That residual leak is accepted and is
  the stated price of exact-match lookup.
- A value that fails authentication is refused as `metadata_integrity_failed`:
  a distinct marker, never an empty value and never fabricated plaintext, while
  the rest of the row renders normally. Each failure logs an administrator
  diagnostic naming the column and row and nothing else. Writing to the field
  is the repair.
- An instance with no usable KEK (missing, unreadable, malformed, set in both
  forms, or not the key the instance-scope `metadata_keys` row was wrapped
  under) is locked as a whole (#1405, ADR-0024 amendment): every screen and
  API answers 503, nobody signs in, administrators included, and only the
  scheduled-maintenance worker runs, until the key is fixed on the host and
  the container restarted. Account addresses (`users.email`) are encrypted
  since #969, so a session could not even show who is signed in. A
  household-scope key wrapped under a key the instance does not hold is the
  narrower case: those fields read as locked rather than damaged, and writes
  to them are refused, exactly as document operations lock.
- A reminder whose item name will not decrypt is not sent with an empty or
  invented name: the delivery is retried, like any other transient fault,
  until the key or the value is repaired.
- Rows written before this release keep their plaintext until a resumable
  start-up job encrypts them. Two releases are needed before dumps stop
  carrying this plaintext: the expand release still holds the plaintext
  columns until the contract release drops them.
- The portable archive is the deliberate plaintext escape hatch: it exports
  decrypted values and therefore itself requires a working KEK.

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
  **and Tier 1 and Tier 2 household metadata** are unrecoverable by design. Orbit must
  state this plainly during setup and backup.

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
- Restore never silently overwrites an existing KEK, and requires the same KEK
  to read encrypted metadata as it does to read documents.
- Once the contract release has dropped the plaintext columns, an ordinary
  database dump no longer contains readable notes, references, mail-in
  extracts, item names, provider names, costs or invited addresses. During the
  expand release it still does.
- Mixed lifecycle states, missing blobs, corrupt tags, and a wrong KEK are
  covered by restore tests. In-flight scanner stages and their document/job
  correspondence are included; restore clears leases and requeues recoverable
  scan jobs. Plaintext quarantine is never included.

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
- same-identity content/scope idempotency and `409` mismatch;
- unavailable/timeout/protocol versus generic scanner-error classification;
- staging privacy and purpose-bound AAD, duplicate workers, lease expiry,
  restart recovery, five-attempt exhaustion, immutable retention expiry,
  terminal stage-purge failure, reviewed pending attachment, and admin
  redaction/authorization;
- encryption round trips, AAD mismatch, corrupt ciphertext/tag/wrapped key,
  unknown version, wrong KEK, and key rewrap;
- quota races, interrupted state transitions, missing/orphaned files, retention
  purge, and disk errors;
- backup/restore with mixed states and key verification;
- kept page previews (#1433): a kept page does not unseal with a document
  context or another page number; the preview route for a member without
  access, a signed-out request and a pending-deletion document answers as
  the download route does and writes no audit; a remembered refusal starts no
  child; purge deletes preview objects before the document object; rotation
  leaves no preview on the older key; the drawing child's environment is
  empty and its `RLIMIT_AS` is set; a 128 MB content stream, a 900 megapixel
  image and a never-ending tiling pattern are each drawn or stopped inside the
  ceilings and the clock;
- browser tests proving attachment-only delivery and signed-out privacy.

## Planned v1 intake extensions

Bounded document parsing and dedicated-mailbox ingestion are required v1
inputs to the same private, editable review flow. Direct upload accepts the
three document types above, while mailbox ingestion deliberately accepts only
PDF candidates. Incidental non-PDF MIME parts are ignored without download or
staging; a claimed PDF must pass magic-byte typing, malware scanning, the
bounded open check, and encryption, in that order. A message with no PDF reaches a content-free private
terminal outcome rather than an empty review draft. Before mailbox enablement,
this model must cover authenticated envelope identity, hostile MIME and archive
limits, receipt idempotency, quarantine, retry/reconnect behaviour, cross-
household draft isolation, retention, redacted diagnostics, and explicit user
approval before any item write or attachment.

[ADR-0005](adr/0005-reviewed-ingestion-and-mailbox-staging.md) establishes that
boundary. Mailbox input is identified only through a configured
provider-preserved envelope-recipient header and a versioned HMAC alias. Orbit
does not persist raw messages, archives, malware, or incomplete staging. Supported clean PDFs are encrypted into user-owned staging
that is neither household data nor downloadable through item routes. Receipt
identity, recipient-scoped content identity, leases, bounded retries, expiry,
and purge must remain idempotent across polling, restart, UIDVALIDITY rollover,
approval, discard, and alias-key rotation.

Approval rechecks the user, selected household, section, existing-item target,
draft version, and staged source identity. Only that explicit command may
create an item or transfer a staged attachment through the secure document
lifecycle. Quarantined and failed views expose technical classifications and
opaque identifiers only.

Inline previews, OCR, public sharing, S3 storage, archive uploads, and
automatic duplicate merging remain deferred. Each must extend this threat
model before implementation. Model-dependent semantic extraction is no longer
deferred as a design: its boundary is recorded below.

## Local model extraction boundary

[ADR-0025](adr/0025-local-model-extraction.md) sections 1-4 decide this
boundary; the client that implements it is
`src/server/documents/model-extraction.ts`.

Document text goes to one destination and no other. The endpoint is the
compile-time constant `http://orbit-ollama:11434`: Orbit has no base-URL,
host, port, proxy or API-key setting for it, so no deployment, environment
variable or administrator can point document text at a different host. The
only knob is the model name, and the Compose `ai` profile that supplies the
service. Reaching anywhere else needs a code change to that constant, which
needs an ADR superseding ADR-0025. Confining `orbit-ollama` to the egress-free
processing network that already holds Tika and ClamAV is the matching
structural control: the service carries no default-network route and no
published port, so the container that holds document text has no path to the
internet whatever image or model is loaded into it. Compose validation refuses
a configuration that adds one. The server cannot fetch its own model as a
result, so a separate one-shot puller reaches the model registry on the
default network, writes into the shared model volume, and exits; it never
receives document text and never runs as a side effect of starting the stack.

At most two requests are made per document: a blind pass, for exactly one
JSON object, and an adjudicating pass that runs only where the blind reading
and the heuristic reading disagree on a field. Every axis of both passes is
bounded by the same constant in code: a fixed input character budget over the
same normalised text any other untrusted evidence gets, schema-constrained
decoding so the reply cannot be prose, temperature 0, a fixed seed, a
generation-token cap, a response-size cap checked before parsing, and a
wall-clock deadline - no pass relaxes any of them, and that deadline bounds
the whole flow rather than each pass, so two sequential passes cannot double
what the interactive path already waits for. A reply that is late, oversized,
refused, malformed or absent is discarded whole - no partial salvage, no
repair prompt, no retry. Where it is the blind pass that fails, the upload
keeps the heuristic proposal alone, exactly as before. Where it is the
adjudicating pass that fails, the heuristic value stands for the disputed
field, not the blind model value, because a failed adjudication is evidence
for neither reading. The adjudicating pass may instead return a field empty -
both readings rejected - and that is a result, not a failed pass, distinct
from the late, oversized, refused, malformed or absent reply above. Every
failure is a log record in the existing fixed vocabulary; no model output,
and no caught error text, ever reaches a log.

The system prompt tells the model that the document is untrusted data to be
read rather than obeyed, but the prompt is not the control. Two things are.
First, grounding: every value must arrive with a verbatim evidence span, and a
value is dropped unless that span occurs in the normalised document text and
itself carries the value. Numeric values must additionally show their digits in
the span, and a cost is proposed only when its span carries an explicit
currency symbol or code. The adjudicating prompt carries the heuristic and
blind readings inside it, but grounding stays against the document data block
and nothing else: a value present only in those supplied readings does not
ground on them, so the adjudicated answer is grounded against the document
exactly as the blind answer is. Second, the surviving values pass
`safeStoredDocumentProposal` exactly as a heuristic or stored proposal does, so
normalisation, length caps, markup rejection and the fresh-object rebuild that
discards unknown keys all apply unchanged.

Closed vocabularies do the rest. The model labels dates with a role from a
fixed list and never emits a schedule kind; the application derives that.
Unknown roles are dropped, and a recurrence with no scheduled date to repeat is
dropped with it.

The blast radius is therefore the same one a hostile document already has over
the heuristics: it can influence which candidate suggestions a reviewer is
shown, and it can waste at most two bounded inferences. A hostile document can
always manufacture a disagreement between the two readings and so force the
second pass, which is why the two-pass count is capped by a constant in code
rather than left to the agreement test between the readings - that test is a
cost optimisation, not a security control. It cannot cause a write, reach
another household, address a tool, or send anything outward. Review-first
ingestion ([ADR-0005](adr/0005-reviewed-ingestion-and-mailbox-staging.md)) is
unchanged - a model suggestion is still only a suggestion a person accepts.

Still to come, and out of this boundary until they land: wiring the model path
in as the default where the profile is present, and reporting model
availability to the administrator.

The reviewer surface is being built now. Where the blind and heuristic
readings disagreed, the reviewer sees the adjudicated value as the
suggestion, with the reading it rejected available behind a secondary
affordance beside the field; where the two readings agreed, nothing extra is
shown at all. The losing validated value is kept only for the life of the
pending review that offers it, and is discarded with everything else the
review held once the item is saved or the review is abandoned.
