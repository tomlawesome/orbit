/**
 * The lease/claim core the scan and purge seams share (#299).
 *
 * Every job the worker touches arrives as one of these claim records: the
 * job's identity, the document generation it was claimed against, and the
 * lease token that fences every subsequent write (ADR-0010). The claim
 * shapes reach nothing; `completeJob` and `failJob` below are the one place
 * a claimed job is finished, each under a predicate the caller states.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { documentJobs } from "@/db/schema";
import { asOperationalReason, log } from "@/lib/logger";
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

/** A database or a transaction: anything that can run a SELECT and an UPDATE. */
type JobWriter = Pick<ReturnType<typeof getDb>, "select" | "update">;

/**
 * The predicate every job write rests on: this row, still `processing`, still
 * under this lease token. A caller adds what else it must also be true of the
 * row (its document, kind and generation) with `and(...)`; the predicates
 * differ per caller on purpose and none of them is implied here (#1349,
 * engine-17).
 */
export function holdsJobLease(job: { id: string; leaseToken: string }): SQL {
  return and(
    eq(documentJobs.id, job.id),
    eq(documentJobs.status, "processing"),
    eq(documentJobs.leaseToken, job.leaseToken),
  ) as SQL;
}

/**
 * Ends a job: drops its lease and records its terminal status. Writes only
 * rows `owns` matches, and answers whether it matched any, so a caller whose
 * lease was lost can see that. `completedAt` is set for `completed` and
 * `cancelled`, and cleared for `failed`.
 */
export async function completeJob(
  db: JobWriter,
  owns: SQL | undefined,
  outcome: { status?: "completed" | "cancelled" | "failed"; lastError?: string | null; now?: Date } = {},
): Promise<boolean> {
  const status = outcome.status ?? "completed";
  const now = outcome.now ?? new Date();
  const changed = await db.update(documentJobs).set({
    status,
    completedAt: status === "failed" ? null : now,
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: outcome.lastError ?? null,
    updatedAt: now,
  }).where(owns).returning({ id: documentJobs.id });
  return changed.length > 0;
}

/**
 * A failure code that is safe to store and log: anything mentioning a key or
 * a secret is `key_unavailable` (the operator's remedy is the key, not the
 * job), everything else is the caller's own fixed `fallback`.
 */
export function jobFailureCode(error: unknown, fallback: string): string {
  return error instanceof Error && /key|secret/i.test(error.message) ? "key_unavailable" : fallback;
}

/**
 * Records one failed attempt on a job the caller still holds: back to `retry`
 * with its lease dropped, or `failed` once `maxAttempts` is reached. With
 * `retryDelayMs` the next attempt is also scheduled, that many milliseconds
 * after now, given the attempt number it will be; without it the claim query
 * decides when a retry is due.
 */
export async function failJob(options: {
  db: JobWriter;
  /** Which job: normally `holdsJobLease(job)`. */
  owns: SQL;
  /** A fixed code, never provider text. */
  code: string;
  maxAttempts: number;
  retryDelayMs?: (nextAttempt: number) => number;
}): Promise<void> {
  const [current] = await options.db.select({ attempts: documentJobs.attempts })
    .from(documentJobs)
    .where(options.owns)
    .limit(1);
  if (!current) return;
  const exhausted = current.attempts >= options.maxAttempts;
  log.warn({
    event: "document.job",
    state: exhausted ? "exhausted" : "retrying",
    reason: asOperationalReason(options.code),
    action: exhausted ? "inspect_admin_diagnostics" : "retry_job",
    impact: "document_processing_blocked",
  });
  const now = new Date();
  await options.db.update(documentJobs).set({
    status: exhausted ? "failed" : "retry",
    ...(options.retryDelayMs ? { nextAttemptAt: new Date(now.getTime() + options.retryDelayMs(current.attempts + 1)) } : {}),
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: options.code,
    updatedAt: now,
  }).where(options.owns);
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
