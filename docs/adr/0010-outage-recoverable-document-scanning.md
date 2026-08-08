# ADR-0010: Outage-recoverable document scanning

**Status:** Accepted
**Date:** 2026-08-08

## Context

The document upload contract is synchronous for ordinary outcomes, but a
scanner outage should not force a user to upload the same validated bytes
again. The recovery path must not turn scanner failure into an unscanned or
downloadable document, add a second queue, or expose private staged content.

## Decision

Keep the existing synchronous route and lifecycle. Clean uploads continue to
return `201` and `available`; invalid structure and malware remain immediate
terminal rejection with secure discard. Only scanner adapter errors classified
as `unavailable`, `timeout`, or `protocol` create recovery state. The generic
adapter `scanner` error remains fail-closed `503` with no durable stage.

For a retryable result, Orbit encrypts the already validated bytes with the
existing envelope primitive but binds the authenticated data and wrapped-key
purpose to `scanner_recovery`. The ciphertext is written under the separate
`staging/` namespace, never served, parsed, drafted, or exposed through a
route. One PostgreSQL transaction records the document, staging row, and
`document_jobs` scan job; the route returns `202` with `Cache-Control:
no-store`.

The document remains in lifecycle `scanning` with `scan_status=error` and one
of the fixed recovery codes `scanner_unavailable`, `scanner_timeout`, or
`scanner_protocol`. No lifecycle enum is added. The scan job uses the existing
PostgreSQL queue with a ten-minute lease, lease token and generation fencing,
five automatic attempts, and delays of 60 seconds, 2 minutes, 4 minutes, 8
minutes, then 15 minutes before automatic attempts 1 through 5 respectively.
Stage creation is not an attempt: it persists the job at `attempts=0`, and the
worker increments the count only when it claims an automatic scan. Recovery expires after
`DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS` (default 24); manual retry resets
automatic attempts but never the expiry.

After automatic exhaustion the job remains operator-recoverable. Recovery
expiry or operator discard rejects metadata with `scan_recovery_expired` and
securely purges the stage. Malware, terminal scanner errors, and invalid
staging data use terminal codes `malware_detected`, `scanner_failed`, or
`staging_object_invalid`. If deletion fails, the stage becomes inaccessible
`purge_pending`, the document is already terminal, and an administrator
backlog retries deletion idempotently; no surface claims deletion succeeded.

`X-Orbit-Document-Id` is an authenticated client UUID idempotency identity.
The same identity, content, and household/item scope replays the same result;
scope or content reuse returns `409`. Clean reviewed direct intake keeps its
existing synchronous completion and success response. Only a retryable scanner
outage records the document ID, stays `pending_attachment`/`recoverable` with
`202`, and lets the scan worker attach it transactionally after a clean scan;
the route never compensating-deletes that outage document. Existing reviewed
operation idempotency remains separate.

Backups include encrypted in-flight stages and their correspondence. A clean
recovery first makes the available document and durable `purge_pending` stage
handoff visible, then removes the staging ciphertext idempotently; a crash or
deletion failure leaves only that bounded purge backlog. Restore validates the
staging namespace, preserves attempts and failed/manual job state, and only
clears leases/requeues live pending, retry, or processing jobs. Plaintext
quarantine is never backed up. Public health remains
content-free; administrator health exposes only safe counts, categories,
retry/expiry and purge backlog. User views distinguish active retry,
recoverable outage, terminal rejection and success. No raw path, filename,
content, hash, signature, provider response, or key is persisted in logs or
diagnostics.

## Consequences

- A temporary scanner outage is recoverable without re-upload while normal
  upload latency and status contracts remain unchanged.
- The document volume and database gain a bounded encrypted staging object and
  one durable scan job per recovery document; no external queue is introduced.
- Operators must retain the KEK and backups together with their recovery
  procedure. Automatic retries are bounded, and expired data cannot be kept by
  repeatedly pressing retry.
- The restore contract in ADR-0004 is extended: scanner-recovery stages are
  valid transient correspondence when their database rows and encrypted
  `staging/` objects agree; restore requeues live leases without resetting
  attempts or reviving failed/manual jobs.

## Alternatives rejected

- Queueing every upload asynchronously would change the established `201`
  route and user contract for no outage benefit.
- Persisting plaintext quarantine or ordinary document ciphertext in the
  staging namespace would widen the threat boundary and make recovery bytes
  downloadable or parseable by mistake.
- Treating generic scanner-reported errors as retryable would hide scanner
  protocol or policy failures and weaken fail-closed behavior.
- Adding Redis, a worker service, or a second queue would violate the
  single-instance PostgreSQL operational boundary.
