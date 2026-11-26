# ADR-0047: The household export is a leased background job; its key is wrapped under the instance KEK for the job's life

**Status:** Proposed (#1774, design note 70448)
**Date:** 2026-11-25
**Amends:** [ADR-0045](0045-portable-archive-v2-streamed-segments.md) export
section ("Export still runs inside the request"; the export no longer does)
**Relates to:** #1774 (the household export as a background job), #1390
(follow-up, owner answer 6a); ADR-0010 (the lease pattern); ADR-0023 section 5
(re-challenge)

## Context

`createPortableArchive` runs inside the POST: snapshot, manifest, disk
preflight, key derivation, the segment writer, then one transaction recording
the `portable_archives` row, the audit line and the kept-export bound. The
route holds the process-wide archive slot for the whole write. The card's
export phases live in component state only, so a reload forgets a running or
finished export. `document_jobs.document_id` is NOT NULL, so an export cannot
borrow that table, and the app has no live channel to the browser.

Leaving the page must not cancel an export, and an export must survive an
update. The person types the passphrase once, under the step-up challenge,
and it must not be stored; the job needs the key after the request has
answered and after a restart.

## Decision

1. **A durable job row with a lease, in `document_jobs`' shape.** The pattern
   is ADR-0010's: a row per job; a claim that sets `processing`, bumps
   `attempts` and takes a fresh lease token; every later write fenced on
   `status = 'processing'` and the lease token; an idempotent re-run after a
   crash. The new table `portable_archive_exports` (migration 0024) reuses the
   `document_job_status` enum and carries the lease columns, `failure_code`
   and `failure_message`, `bytes_total` and `bytes_done`, `archive_id` and the
   key columns of item 3. It is the first job table outside documents. New
   kinds of job follow `document_jobs`' shape; they do not go onto a generic
   queue.
2. **One live export per household is a database constraint, not a lock.**

   ```sql
   create unique index portable_archive_exports_one_live
     on portable_archive_exports (household_id)
     where status in ('pending', 'processing', 'retry');
   ```

   The route's insert either succeeds or fails with the unique violation,
   mapped to 409 `archive_export_in_progress`; the card shows that job. The
   index holds across a restart and cannot be lost the way a lock can.
3. **The key is derived in the request and wrapped under the instance KEK for
   the job's life.** The pattern is envelope encryption of a job's secret
   under the service's key-encryption key, the shape every document's data
   key already has (`wrapKeyWithAad`/`unwrapKeyWithAad`). The route checks the
   passphrase floor, draws a 16-byte salt, derives the 32-byte key with the
   existing async scrypt, wraps it with AAD
   `"portable-archive-export:" + jobId`, stores `salt`, `key_wrapped` and
   `key_id`, zeroes the plaintext key, inserts the row and answers 202. The
   passphrase leaves the request with nothing written anywhere. The job
   unwraps the key on claim and zeroes it when it finishes however it
   finishes.
4. **The key's life.** On `completed` the three key columns are set null in
   the completing transaction. On `failed` they are kept for one hour from the
   failure, so "try again" is one tap and needs no second passphrase; the
   worker's cycle nulls them after that hour, and the card then offers "write
   it again" (the form). Retry is
   `POST /api/households/{id}/portable-archives/{jobId}/retry` with
   `expectedStatus: "failed"`, and requires the step-up re-challenge as the
   start does (ADR-0023 section 5: the archive is the whole household in
   plain); after the hour it answers 409 `archive_export_key_gone`. A KEK that
   cannot unwrap the key between start and claim fails the job with
   `key_unavailable`. The rewrap worker does not learn this table: the rows
   live minutes, the hour at most.
5. **A crash or restart re-runs the job from nothing.** Orbit is one process,
   so at boot every `processing` row is dead: `requeueInterruptedExports()`
   sets those rows to `retry`, due now, with `bytes_done = 0`, and the job
   runs again with a fresh storage key and nonce prefix; nothing from the
   first run is reused. The lease's own expiry covers a stall without a
   restart. Three interruptions in a row end the job `failed`. The orphaned
   temp file is removed by the existing storage reconcile. The completing
   transaction also sets the job `completed` and `archive_id`: there is never
   a finished file without a finished job, or the reverse.
6. **The archive slot moves into the engine.** The worker cannot import
   `$lib/server/archive-slot.js`. The slot core (holder, first-come queue,
   `claim`/`await`/`release`) moves to `src/server/archive-slot.ts`, exported
   as `orbit/server/archive-slot`; the web module keeps the request-bound
   parts and imports the core. This is a move, not a change of behaviour. The
   job claims the slot the way a spooled upload does; a wait that runs out
   puts the job back to `retry` in 60 seconds without counting an attempt. The
   route no longer claims the slot.
7. **Where it runs.** A new seam
   `src/server/document-maintenance/export-jobs.ts`, with its own poll loop
   started from `startDocumentWorker()` as the preview worker is, and woken by
   `notifyExportWorker()` after the route's insert. One claimed export at a
   time.

## Consequences

- `POST /api/households/{id}/portable-archives` answers 202 with the job, not
  the archive; ADR-0045's "Export still runs inside the request" no longer
  holds.
- An export survives leaving the page and an update; the card reads one small
  route and sees the job, or the finished file, after a reload.
- The database now holds, for minutes and for one hour after a failure at most,
  a key that opens a plain-text export of a household. Whoever holds the KEK
  and the database already holds every document, so this adds no capability.
- The finished file, its retention, the download route and the purge are
  unchanged.
- The slot's core is shared by the web process and the worker.
- A failed export cannot be retried one-tap after an hour, or after the KEK
  changes; the person writes it again.

## Alternatives considered

- **The key in process memory only; a restart means typing the passphrase
  again.** Leaving the page not cancelling the export, and surviving an
  update, both want the job to come back on its own. The wrapped key adds no
  capability beyond what the KEK and the database already give. Rejected.
- **Store the passphrase.** The key is what the job needs; the passphrase is
  the person's and is never written. Rejected.
- **A new generic queue.** The `document_jobs` shape already exists and is
  understood; a new table in the same shape is enough. Rejected.
- **Borrow `document_jobs`.** `document_id` is NOT NULL. Rejected.
