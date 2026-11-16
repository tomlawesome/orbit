# ADR-0045: The portable archive is a stream of independently authenticated segments, imported by staging every document and switching once

**Status:** Proposed (#1390)
**Date:** 2026-11-07
**Relates to:** #1390 (archives bounded by disk, not memory); #1316 finding
PQ1-16 (the 128 MiB archive); #1506, #1521, #1566, #1607 (the streamed
export, decrypt, upload and payload reader of format v1); #1605 items
SEC-D3/1, RANGE-R2/1, RANGE-R2/2, PR-5/PR-52, AR2-1; ADR-0010
(outage-recoverable scanning); ADR-0024 decision 6 (the archive is the
plaintext escape hatch); ADR-0034 (the engine owns every rule). Amended by
the #1390 review round (issue note 55214, rulings 1 to 10).

## Context

A household's portable archive (format v1) is one JSON document — metadata,
and every document as base64 — encrypted as one AES-256-GCM message under a
passphrase-derived key, with one authentication tag over the whole. Export,
download and upload were made to stream (#1506, #1521, #1566), and the
payload is read in pieces with resource budgets (#1607). One thing could not
stream: with a single tag, no decrypted byte may be used until the last byte
has arrived and the tag has verified, so the import decrypts the whole
archive into a private scratch file first. That scratch is a 320 MiB tmpfs,
which is memory. The archive is therefore capped at 256 MiB of plaintext,
about 192 MiB of documents, while a household may hold 5 GiB of documents by
default. The owner called the cap "a tiny amount of size" and asked for
exports bounded by disk, not memory (#1390).

Three limits around the archive assume the same small size: the image's
server-wide body limit (343 MiB), Node's five-minute limit on receiving a
whole request, and the one-hour import lease measured from when the import
started. The import also commits metadata first and restores documents
afterwards, undoing both on failure; four audit findings (#1605 RANGE-R2/1,
RANGE-R2/2 and the three AR2-1 lines) are about the cracks in that undo.

## Decision

1. **Format v2 is the STREAM construction over AES-256-GCM**, as Google
   Tink's streaming AEAD and `age` instantiate it: a 64-byte plaintext header
   (magic, version, scrypt parameters, salt, 7-byte nonce prefix, segment
   size, manifest length, total length), then 1 MiB segments, each an
   independent AES-256-GCM message whose nonce is the prefix, a 32-bit
   big-endian segment counter and a last-segment flag, with the header as
   associated data. The key is scrypt of the passphrase, derived
   asynchronously, with N = 16 384, r = 8, p = 5: the OWASP Password Storage
   Cheat Sheet's listed equivalent of N = 2^17, r = 8, p = 1, at 16 MiB of
   memory (review ruling 5; the first build wrote v1's p = 1, and those files
   still open). The header is checked before any key derivation: a header
   whose scrypt memory, as OpenSSL counts it (128·r·(N + 2 + p)), is over
   the derivation's 64 MiB bound, or whose p is over 5, is refused as
   `archive_invalid` with a 400, and any parameters scrypt itself still
   refuses map to the same 400 (second review, F2), so a
   crafted file can neither make scrypt fail as a 500 nor cost more than
   Orbit's own files times the memory bound's headroom. The
   counter refuses reordering and substitution, the flag refuses truncation,
   the header's total length lets the reader know the final segment without
   look-ahead, and nothing from a segment is used until its own tag has
   verified.

2. **The plaintext is a manifest followed by raw document bytes, unframed.**
   The manifest is the v1 payload without base64, plus `body[]`: the
   documents whose bytes follow, in order, each with its length and SHA-256.
   The manifest is capped at 64 MiB and read with the existing budgeted
   reader. Documents travel as their own bytes, not base64.

3. **Export stays on disk.** The file is written to private storage and
   renamed, then downloaded by GET with the recorded hash checked, as today.
   Documents are read as streams. Its rows are read in one REPEATABLE READ,
   read-only transaction, so they come from one snapshot and a document never
   ships without its item (review ruling 8); a document deleted before its
   bytes are read fails the export. The export refuses when the disk has no
   room (a free-space check first, and ENOSPC during the write). It no
   longer refuses an archive over the import's own ceiling (decision 6;
   review ruling 6, superseded by #1799, owner answer 46a): a household over
   a limit lowered later can still take a full backup, and restoring it here
   is refused until an administrator raises the limit. The plaintext it handles is
   zeroed once used, on every path: the manifest buffer once sealed, each
   decrypted document piece once pushed or refused, and the segment parked
   in the writer once sealed or when a write fails (review ruling 7). A
   string the manifest was built from cannot be zeroed and is left to the
   collector.

4. **Import stages every document, then switches once** (two-phase stage
   then switch). A start record is written under the household lock, after
   the manifest's checks pass as a dry run; every restorable document is then
   uploaded as a staged document sealed to a pre-generated item id, through
   the same path a direct upload takes; and one final transaction under the
   household lock inserts sections and items, binds the staged documents and
   marks the import complete. Until that transaction commits, a member can
   see nothing of the import; a crash anywhere leaves only a start record
   and staged rows, which the boot sweep, the next import, and a fifteen-
   minute worker sweep remove. The rollback takes the household lock. A
   document the scanner cannot check now is a restore failure, not an
   exception to all-or-nothing. An ambiguous commit is settled by reading the
   import record back.

5. **The import lease is a heartbeat lease, held as an optimistic lock.** The
   one-hour lease is measured from the last heartbeat, not from the start, so
   a long import neither reopens the household early nor is rolled back as
   stale while it is alive. The heartbeat runs after every document and, on a
   five-minute timer, while one document is staging, since one large document
   on a slow scanner could outlast the lease. Every change the import makes
   to its start record (each heartbeat, and the switch's close) applies only
   while the record is still open (`finished_at` null) and still carries the
   `lease_renewed_at` this import last wrote, its fencing token; a renewal is
   also never attempted once the import's own clock says the lease ran out.
   If any of them changes no row, the lease is lost (the sweep rolled the
   import back, or it was taken for stale): the import stops staging, never
   switches (the switch's transaction is undone), removes the documents it
   staged since, and answers `archive_import_failed` (review ruling 1). Phase
   0 refuses with a 409 `archive_import_in_progress` while another live start
   record of the household is open, whether or not this process's archive
   slot is held (another tab, another instance; review ruling 9). The stale
   sweeps choose their rows before the household lock, so inside it they
   check the lease again and leave a row whose heartbeat renewed meanwhile
   (second review, F3).

6. **The archive ceiling is the household's document quota plus the manifest
   cap**, computed from configuration and served to the browser through the
   session's `limits`, so the card and the import's refusal agree. The
   export is not held to it (#1799, owner answer 46a): it writes what the
   household stores, and an archive over the ceiling is refused on restore
   with 413 `archive_over_quota`. The server-wide body limit is turned off in favour of
   the per-route limits that already exist, and the whole-request time limit
   is replaced by a stall limit (no byte for thirty seconds), as the archive
   slot already applies to its routes, and by a rate floor of 30 KiB per
   30 s in the start-up shim. Both measure the client only while the server
   is waiting for its bytes (review ruling 2): the stall clock runs only
   while the route has a read outstanding, so a scan, a structure check or
   the encryption of a segment is never taken for a client that stopped, and
   the rate floor, like Kestrel's MinRequestBodyDataRate, counts only the
   time the request is not paused, added up across pauses: every 30 s of
   that waiting time must bring 30 KiB (second review, F1; skipping any
   window that held a pause let a route's brief pauses shield a silent
   client). The one archive slot is taken by the route only after its
   household role check (review ruling 4): a signed-in person who may not
   export or import that household never holds it.

7. **Preview reads only the header and the manifest**, and the browser sends
   only that much of the file for a preview. A v1 file is still sent whole.

8. **v1 archives import unchanged**, through the scratch tmpfs, with their
   own named limits (a file of about 341 MiB, 357979480 bytes; 256 MiB of
   plaintext). Orbit no longer writes v1. The v1 reader's two low-grade
   findings about field order (#1605 W-F1, W-Q1) stay open; v2 has no field order and names its version in byte 8.

## Consequences

- An export's size is bounded by the documents volume; an import's by the
  household quota. Memory in either direction is a few megabytes of
  buffers, the manifest, and one document's working set in the document
  path — the same as a single upload.
- A v2 archive is about a quarter smaller than the v1 archive of the same
  household (no base64), and is a binary file (`.orbit`), not JSON. Nobody
  can read it with a text editor; nobody could read v1 without the
  passphrase either.
- Three kinds of tampering that v1 caught only after the whole file had
  arrived are now caught at the first bad segment, with nothing after it
  decrypted.
- A failed or crashed import leaves no half-imported items, so the "items
  already in use, not rolled back" guard has nothing to guard in normal
  operation; it stays as defence in depth.
- Export still runs inside the request; a very large household waits on the
  button for tens of seconds. A background export is a separate decision
  (follow-up issue).
- The scratch tmpfs stays for v1 imports only; a later release may drop it
  once v1 is retired, which needs its own decision.
- The segment size is fixed at 1 MiB in this release; the header field
  exists so a later version can change it without a new format.

## Alternatives considered

- **Raise the limit and the tmpfs.** Memory, not disk; gigabytes of RAM per
  import. Rejected in #1390.
- **Streaming to a disk scratch instead of tmpfs, keeping one tag.** Bounded
  by disk, but still parks a full decrypted copy before use and doubles the
  disk needed; one tag over gigabytes also means a corrupt byte is found
  only at the end. Rejected.
- **Encrypt each document as its own GCM message, no segments.** A 100 MiB
  document is still one message that must be parked until its tag verifies
  (the document path needs the whole file in quarantine anyway, so this is
  tempting), but the manifest and small documents would each need their own
  nonce bookkeeping and the reader would need a second framing layer. STREAM
  gives one rule for every byte. Rejected.
- **libsodium secretstream / XChaCha20-Poly1305.** The same construction;
  Node has no XChaCha20 and the rest of Orbit is AES-GCM. Rejected on
  dependency grounds.
- **HKDF between scrypt and the segment key**, as Tink does. Needed when the
  outer key is long-lived; the salt here is fresh per archive. Rejected as a
  second KDF with no gain.
- **Export streamed straight to the HTTP response.** Loses the hash-checked,
  re-downloadable, audited file for no memory gain (the file is on disk
  either way). Rejected.
- **Keep commit-then-restore and patch the undo.** The four #1605 findings
  are the cracks in exactly that shape; staging first removes the shape.
  Rejected.

## Addendum, 2026-11-09 (#1792)

- **Uploads are stored before the slot is taken.** An archive check or
  import first writes the whole upload to
  `<storage root>/portable-archives/<id>.upload.tmp`, one upload per account
  at a time, and only then waits for the archive slot, up to
  `ORBIT_ARCHIVE_SLOT_WAIT_MS` (10 minutes). The slot now covers processing
  only, so how fast a client sends no longer decides how long others wait.
  An export still gets "busy" at once. The upload is refused with 507 when
  the disk cannot hold it, and its file is removed when the request ends.
- **Kept exports are bounded.** The one-day lifetime is replaced by three
  administrator settings (`instance_archive_retention`, migration 0013): how
  long an export is kept (default 6 hours), how many each household keeps
  (default 2; a newer one replaces the oldest) and the space for all exports
  together (default twice the household quota, rounded up to whole GiB, at least 1 GiB; downloaded
  exports go first, oldest first). See `docs/administrator-operations.md`,
  "Exports kept".

## Addendum, 2026-11-10 (#1797)

- **The upload is checked as it arrives.** The spool file is the system of
  record for the bytes; the check reads its start back from the file while
  the rest is still arriving. A v2 header is checked at byte 64. Once the
  manifest's segments are on disk, the manifest is decrypted and the
  import's own dry run (`fitImport`: sections, duplicates, the documents the
  plan restores, household and instance quota) runs without the household
  lock, under the archive slot. A refusal aborts the spool and is answered
  with the same code and message the final check gives, so an over-limit
  archive is refused seconds after its manifest has arrived, not after the
  whole file. v1 archives are not checked early.
- **Best effort, and it can only refuse.** An unexpected error in the early
  check is logged and the upload goes on; a slot not had before the spool
  ends leaves the request to the normal path. The phase-0 check under the
  household lock stays and still runs, because the household's usage can
  change in between; `archive_import_in_progress` and the stale rollback stay
  there only, so while the household has any unfinished import, live or
  stale, the early check is skipped and the final path decides. The body is still read away after the refusal (decision 4's
  draining contract), not cut.
