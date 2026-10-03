/**
 * The lease/claim core the scan and purge seams share (#299).
 *
 * Every job the worker touches arrives as one of these claim records: the
 * job's identity, the document generation it was claimed against, and the
 * lease token that fences every subsequent write (ADR-0010). Nothing here
 * reaches the database, so a claim shape can be reasoned about on its own.
 */
import { sql } from "drizzle-orm";
import { operationalReasons, type OperationalReason } from "@/lib/logger";
import type { OwnedPurgeJob } from "@/server/documents/purge";

/**
 * The claim-update every job-claim query performs once it has picked its
 * rows: mark the job processing, bump its attempt count, and set a fresh
 * ten-minute lease and lease token (A2-Q3). purge-jobs.ts, scan-recovery.ts
 * and rewrap-worker.ts each spliced this same text into their own
 * `claimable`-scoped CTE; building this fragment does not reach the
 * database any more than constructing a WHERE clause does -- composing it
 * into a caller's own `sql` template is what runs the query.
 */
export const JOB_CLAIM_UPDATE = sql`
      update document_jobs as job
      set status = 'processing',
          attempts = job.attempts + 1,
          locked_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          lease_token = gen_random_uuid(),
          updated_at = now()
      from claimable
      where job.id = claimable.id
      returning job.id, job.document_id, job.generation, job.lease_token`;

export function operationalDocumentReason(value: string): OperationalReason {
  return (operationalReasons as readonly string[]).includes(value)
    ? value as OperationalReason
    : "unexpected_failure";
}

export interface ClaimedDocumentJob extends OwnedPurgeJob {
  /** The job's status immediately before this claim; distinguishes an expired-lease reclaim from a fresh pending/retry claim. */
  previousStatus: "pending" | "retry" | "processing";
}

/** Pure classification of a claim outcome from the pre-claim status, kept separate from the SQL for direct testability. */
export function purgeClaimOutcome(previousStatus: "pending" | "retry" | "processing"): "claimed" | "reclaimed" {
  return previousStatus === "processing" ? "reclaimed" : "claimed";
}

export interface ClaimedScanJob {
  id: string;
  documentId: string;
  generation: number;
  leaseToken: string;
  previousStatus: "pending" | "retry" | "processing";
}

export interface ScanRecoveryRecord {
  householdId: string;
  itemId: string;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
  contentSha256: string;
  stagingStorageKey: string;
  ciphertextSize: number;
  envelopeVersion: 1;
  contentIv: string;
  contentAuthTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
  recoveryExpiresAt: Date;
}
