/**
 * The KEK rewrap worker (#932, ADR-0017's rewrap contract, ADR-0024 decision
 * 4): unwraps every wrapped key under the current document KEK and rewraps it
 * under the next one, transactionally, one row (or one small batch of rows)
 * at a time, and never touches a ciphertext column.
 *
 * Three populations share one KEK (ADR-0017's reasoning: a second key buys no
 * isolation inside one host boundary): `document_crypto` (one row per
 * document, driven through the existing `document_jobs` lease/claim queue —
 * kind `"rewrap"` already existed with no worker), `metadata_keys` (one row
 * per household plus one instance row, #931/ADR-0024), and `mail_in_secrets`
 * (ADR-0017). Each is handled by its own small, resumable batch so a crash or
 * an operator Ctrl-C mid-run loses at most one in-flight batch's progress —
 * every row a batch's transaction did not commit is exactly as it was before
 * the batch started, and every row a transaction did commit is fully wrapped
 * under the next key. A row is therefore always readable under the current
 * key or the next one, never neither and never a mix of the two, because one
 * SQL statement changes `key_id` and the wrap columns together.
 *
 * This module takes both keys as explicit arguments rather than reading them
 * from configuration: it is driven by one operator invocation
 * (`src/db/rewrap-kek.ts`, `pnpm rewrap-kek`), which supplies the current key
 * from the live configuration and the next key from an operator-provided
 * file, and `src/server/metadata/crypto.ts`'s `rewrapMetadataKey` was already
 * built to be called this way. The worker's shape does not depend on whether
 * the running application also holds the next key: #954 (ADR-0024 decision 4)
 * settled that the application separately loads `DOCUMENT_KEK_NEXT` for the
 * duration of the rotation precisely so that a row this worker has already
 * moved, and a row it has not reached yet, are both readable the whole time —
 * genuinely online, no unreadable window. See `docs/administrator-operations.md`
 * for the full procedure, including when the second key is supplied and
 * removed.
 */
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentJobs, mailInSecrets, metadataKeys } from "@/db/schema";
import { log, operationalDetail } from "@/lib/logger";
import { rewrapDocumentKey, type DocumentCryptoEnvelope } from "@/server/documents/crypto";
import { rewrapMetadataKey, type MetadataKeyContext } from "@/server/metadata/crypto";
import { rewrapMailInSecret } from "@/server/mail-in/core/secret-crypto";
import { operationalDocumentReason } from "@/server/document-maintenance/claims";

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export interface RotationKeys {
  currentKek: Buffer;
  currentKeyId: string;
  nextKek: Buffer;
  nextKeyId: string;
}

export interface ClaimedRewrapJob {
  id: string;
  documentId: string;
  generation: number;
  leaseToken: string;
}

const REWRAP_MAX_ATTEMPTS = 5;
export const METADATA_KEY_ROTATION_BATCH = 100;
export const MAIL_IN_SECRET_ROTATION_BATCH = 100;
export const DOCUMENT_REWRAP_CLAIM_LIMIT = 25;

/**
 * Finds every `document_crypto` row not already on the next key and gives it
 * a `document_jobs` row to be claimed and processed, reusing the resurrection
 * trick a schema with no per-rotation generation counter needs: `kind =
 * 'rewrap'` always uses generation 1, and a terminal row (`completed` or
 * `failed` from an earlier rotation) is reset to `pending` rather than
 * inserted afresh, because `document_job_once` already guarantees at most one
 * row per document and kind. A row still `pending`/`processing`/`retry` from
 * an in-flight rotation is left untouched.
 */
export async function enqueueDocumentRewrapJobs(nextKeyId: string): Promise<number> {
  const rows = await getDb().execute(sql<{ id: string }>`
    insert into document_jobs (document_id, kind, generation)
    select crypto.document_id, 'rewrap', 1
    from document_crypto crypto
    where crypto.key_id <> ${nextKeyId}
    on conflict (document_id, kind, generation) do update
      set status = 'pending',
          attempts = 0,
          next_attempt_at = now(),
          locked_at = null,
          lease_expires_at = null,
          lease_token = null,
          last_error = null,
          completed_at = null,
          updated_at = now()
      where document_jobs.status in ('completed', 'failed', 'cancelled')
    returning document_jobs.id
  `);
  return (rows as unknown as Array<{ id: string }>).length;
}

/** The purge/scan lease-claim pattern (`document-maintenance/purge-jobs.ts`), reused for `kind = 'rewrap'`. */
export async function claimRewrapJobs(limit = DOCUMENT_REWRAP_CLAIM_LIMIT): Promise<ClaimedRewrapJob[]> {
  const rows = await getDb().execute(sql<ClaimedRewrapJob>`
    with claimable as materialized (
      select job.id
      from document_jobs job
      where job.kind = 'rewrap'
        and (
          job.status in ('pending', 'retry')
          or (job.status = 'processing' and job.lease_expires_at < now())
        )
      order by job.created_at
      for update of job skip locked
      limit ${limit}
    ), claimed as (
      update document_jobs as job
      set status = 'processing',
          attempts = job.attempts + 1,
          locked_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          lease_token = gen_random_uuid(),
          updated_at = now()
      from claimable
      where job.id = claimable.id
      returning job.id, job.document_id, job.generation, job.lease_token
    )
    select claimed.id, claimed.document_id as "documentId", claimed.generation,
      claimed.lease_token as "leaseToken"
    from claimed
  `);
  return rows as unknown as ClaimedRewrapJob[];
}

interface DocumentCryptoRow {
  keyId: string;
  envelopeVersion: number;
  contentIv: string;
  contentAuthTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
}

async function completeRewrapJob(transaction: Transaction, job: ClaimedRewrapJob): Promise<void> {
  await transaction.update(documentJobs).set({
    status: "completed",
    completedAt: new Date(),
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(documentJobs.id, job.id),
    eq(documentJobs.status, "processing"),
    eq(documentJobs.leaseToken, job.leaseToken),
  ));
}

/**
 * Processes one claimed `rewrap` job: unwraps the document's DEK under the
 * current KEK and rewraps it under the next one, inside the transaction that
 * also re-verifies the lease and marks the job completed — so a crash between
 * computing the new envelope (pure, in-process) and this commit leaves the
 * row exactly as it was, never partially rewrapped.
 */
export async function processRewrapJob(job: ClaimedRewrapJob, keys: RotationKeys): Promise<"completed" | "stale"> {
  return getDb().transaction(async (transaction) => {
    const active = await transaction.execute(sql<{ id: string }>`
      select id from document_jobs
      where id = ${job.id}
        and status = 'processing'
        and generation = ${job.generation}
        and lease_token = ${job.leaseToken}::uuid
      for update
    `);
    if (active.length === 0) return "stale";

    const rows = await transaction.execute(sql<DocumentCryptoRow>`
      select key_id as "keyId", envelope_version as "envelopeVersion", content_iv as "contentIv",
             content_auth_tag as "contentAuthTag", wrapped_dek as "wrappedDek",
             wrap_iv as "wrapIv", wrap_auth_tag as "wrapAuthTag"
      from document_crypto
      where document_id = ${job.documentId}
      for update
    `);
    const crypto = (rows as unknown as DocumentCryptoRow[])[0];
    // The document was purged between claim and processing, or a previous
    // attempt already finished the row (a resurrected job from a later
    // rotation, or a race with another worker): nothing left to rewrap.
    if (!crypto || crypto.keyId === keys.nextKeyId) {
      await completeRewrapJob(transaction, job);
      return "completed";
    }
    if (crypto.keyId !== keys.currentKeyId) {
      throw new Error("document_crypto row is wrapped under neither the current nor the next key");
    }

    const envelope: DocumentCryptoEnvelope = {
      envelopeVersion: crypto.envelopeVersion as 1,
      algorithm: "aes-256-gcm",
      keyId: crypto.keyId,
      contentIv: crypto.contentIv,
      contentAuthTag: crypto.contentAuthTag,
      wrappedDek: crypto.wrappedDek,
      wrapIv: crypto.wrapIv,
      wrapAuthTag: crypto.wrapAuthTag,
    };
    const rewrapped = rewrapDocumentKey(job.documentId, envelope, keys.currentKek, keys.nextKek, keys.nextKeyId);
    const updated = await transaction.update(documentCrypto).set({
      wrappedDek: rewrapped.wrappedDek,
      wrapIv: rewrapped.wrapIv,
      wrapAuthTag: rewrapped.wrapAuthTag,
      keyId: rewrapped.keyId,
      updatedAt: new Date(),
    }).where(and(
      eq(documentCrypto.documentId, job.documentId),
      eq(documentCrypto.keyId, keys.currentKeyId),
    )).returning({ documentId: documentCrypto.documentId });
    if (updated.length === 0) throw new Error("Rewrap lost document_crypto ownership");

    await completeRewrapJob(transaction, job);
    return "completed";
  });
}

/** As `document-maintenance/purge-jobs.ts`'s `failJob`, for `kind = 'rewrap'`. */
export async function failRewrapJob(job: ClaimedRewrapJob, error: unknown): Promise<void> {
  const [current] = await getDb().select({ attempts: documentJobs.attempts })
    .from(documentJobs)
    .where(and(
      eq(documentJobs.id, job.id),
      eq(documentJobs.status, "processing"),
      eq(documentJobs.leaseToken, job.leaseToken),
    ))
    .limit(1);
  if (!current) return;
  const safeCode = error instanceof Error && /key|secret/i.test(error.message) ? "key_unavailable" : "rewrap_failed";
  const exhausted = current.attempts >= REWRAP_MAX_ATTEMPTS;
  log.warn({
    event: "document.job",
    state: exhausted ? "exhausted" : "retrying",
    reason: operationalDocumentReason(safeCode),
    action: exhausted ? "inspect_admin_diagnostics" : "retry_job",
    impact: "document_processing_blocked",
  });
  await getDb().update(documentJobs).set({
    status: exhausted ? "failed" : "retry",
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: safeCode,
    updatedAt: new Date(),
  }).where(and(
    eq(documentJobs.id, job.id),
    eq(documentJobs.status, "processing"),
    eq(documentJobs.leaseToken, job.leaseToken),
  ));
}

/**
 * Rewraps up to `batchSize` `metadata_keys` rows (households plus, at most,
 * the one instance row) still on the current key, in one transaction. Small
 * enough that a crash mid-batch costs almost nothing and the whole population
 * — O(households) per ADR-0024 — drains in a handful of batches.
 */
export async function runMetadataKeyRotationBatch(keys: RotationKeys, batchSize = METADATA_KEY_ROTATION_BATCH): Promise<number> {
  return getDb().transaction(async (transaction) => {
    const rows = await transaction.select({
      id: metadataKeys.id,
      scope: metadataKeys.scope,
      householdId: metadataKeys.householdId,
      keyId: metadataKeys.keyId,
      wrappedDek: metadataKeys.wrappedDek,
      wrapIv: metadataKeys.wrapIv,
      wrapAuthTag: metadataKeys.wrapAuthTag,
    }).from(metadataKeys)
      .where(ne(metadataKeys.keyId, keys.nextKeyId))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    let rewrapped = 0;
    for (const row of rows) {
      if (row.keyId !== keys.currentKeyId) {
        throw new Error("metadata_keys row is wrapped under neither the current nor the next key");
      }
      const context: MetadataKeyContext = { scope: row.scope, householdId: row.householdId, keyId: row.keyId };
      const next = rewrapMetadataKey(row, keys.currentKek, keys.nextKek, context, keys.nextKeyId);
      const updated = await transaction.update(metadataKeys).set({
        wrappedDek: next.wrappedDek,
        wrapIv: next.wrapIv,
        wrapAuthTag: next.wrapAuthTag,
        keyId: keys.nextKeyId,
        version: sql`${metadataKeys.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(metadataKeys.id, row.id),
        eq(metadataKeys.keyId, keys.currentKeyId),
      )).returning({ id: metadataKeys.id });
      rewrapped += updated.length;
    }
    return rewrapped;
  });
}

/** As `runMetadataKeyRotationBatch`, for `mail_in_secrets` (ADR-0017's named population). */
export async function runMailInSecretRotationBatch(keys: RotationKeys, batchSize = MAIL_IN_SECRET_ROTATION_BATCH): Promise<number> {
  return getDb().transaction(async (transaction) => {
    const rows = await transaction.select({
      id: mailInSecrets.id,
      keyId: mailInSecrets.keyId,
      wrappedDek: mailInSecrets.wrappedDek,
      wrapIv: mailInSecrets.wrapIv,
      wrapAuthTag: mailInSecrets.wrapAuthTag,
    }).from(mailInSecrets)
      .where(ne(mailInSecrets.keyId, keys.nextKeyId))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    let rewrapped = 0;
    for (const row of rows) {
      if (row.keyId !== keys.currentKeyId) {
        throw new Error("mail_in_secrets row is wrapped under neither the current nor the next key");
      }
      const next = rewrapMailInSecret(row.id, row, keys.currentKek, keys.nextKek, keys.nextKeyId);
      const updated = await transaction.update(mailInSecrets).set({
        wrappedDek: next.wrappedDek,
        wrapIv: next.wrapIv,
        wrapAuthTag: next.wrapAuthTag,
        keyId: next.keyId,
        updatedAt: new Date(),
      }).where(and(
        eq(mailInSecrets.id, row.id),
        eq(mailInSecrets.keyId, keys.currentKeyId),
      )).returning({ id: mailInSecrets.id });
      rewrapped += updated.length;
    }
    return rewrapped;
  });
}

export interface RotationCycleResult {
  documentsEnqueued: number;
  documentJobsProcessed: number;
  metadataKeysRewrapped: number;
  mailInSecretsRewrapped: number;
}

/** One pass over all three populations: enqueue, claim and process a batch of each. */
export async function runKekRotationCycle(keys: RotationKeys, batchSize = DOCUMENT_REWRAP_CLAIM_LIMIT): Promise<RotationCycleResult> {
  const documentsEnqueued = await enqueueDocumentRewrapJobs(keys.nextKeyId);
  const claimed = await claimRewrapJobs(batchSize);
  let documentJobsProcessed = 0;
  for (const job of claimed) {
    try {
      const outcome = await processRewrapJob(job, keys);
      if (outcome === "completed") documentJobsProcessed += 1;
    } catch (error) {
      await failRewrapJob(job, error);
    }
  }
  const metadataKeysRewrapped = await runMetadataKeyRotationBatch(keys, batchSize);
  const mailInSecretsRewrapped = await runMailInSecretRotationBatch(keys, batchSize);
  return { documentsEnqueued, documentJobsProcessed, metadataKeysRewrapped, mailInSecretsRewrapped };
}

export interface RotationProgress {
  documentsRemaining: number;
  metadataKeysRemaining: number;
  mailInSecretsRemaining: number;
}

/** How many rows, in each population, are not yet wrapped under the next key. */
export async function rotationRemaining(keys: RotationKeys): Promise<RotationProgress> {
  const [[documentsRow], [metadataRow], [secretsRow]] = await Promise.all([
    getDb().select({ count: sql<number>`count(*)::int` }).from(documentCrypto).where(ne(documentCrypto.keyId, keys.nextKeyId)),
    getDb().select({ count: sql<number>`count(*)::int` }).from(metadataKeys).where(ne(metadataKeys.keyId, keys.nextKeyId)),
    getDb().select({ count: sql<number>`count(*)::int` }).from(mailInSecrets).where(ne(mailInSecrets.keyId, keys.nextKeyId)),
  ]);
  return {
    documentsRemaining: documentsRow.count,
    metadataKeysRemaining: metadataRow.count,
    mailInSecretsRemaining: secretsRow.count,
  };
}

export function rotationComplete(progress: RotationProgress): boolean {
  return progress.documentsRemaining === 0 && progress.metadataKeysRemaining === 0 && progress.mailInSecretsRemaining === 0;
}

/**
 * Drives `runKekRotationCycle` until every population reports zero remaining.
 * Guards against a row this rotation cannot resolve (wrapped under some third
 * key, for instance) by failing loudly once a full cycle makes no progress at
 * all, rather than spinning forever.
 */
export async function runKekRotationToCompletion(keys: RotationKeys, batchSize = DOCUMENT_REWRAP_CLAIM_LIMIT): Promise<RotationProgress> {
  let previousRemaining: number | undefined;
  for (;;) {
    const cycle = await runKekRotationCycle(keys, batchSize);
    const progress = await rotationRemaining(keys);
    if (rotationComplete(progress)) return progress;

    const totalRemaining = progress.documentsRemaining + progress.metadataKeysRemaining + progress.mailInSecretsRemaining;
    const madeProgress = cycle.documentJobsProcessed > 0 || cycle.metadataKeysRewrapped > 0 || cycle.mailInSecretsRewrapped > 0;
    if (!madeProgress && totalRemaining === previousRemaining) {
      throw new Error(`document_kek rotation stalled with ${totalRemaining} row(s) still unrewrapped`);
    }
    previousRemaining = totalRemaining;
  }
}

/** The one audit row a completed rotation leaves, matching ADR-0017's instance-level vocabulary (`householdId: null`). */
export async function recordRotationCompleted(keys: RotationKeys): Promise<void> {
  await getDb().insert(auditLog).values({
    householdId: null,
    actorUserId: null,
    entityType: "document_kek",
    entityId: randomUUID(),
    action: "document_kek_rotation_completed",
    changes: { previousKeyId: keys.currentKeyId, nextKeyId: keys.nextKeyId },
  });
  log.info({
    event: "document.kek_rotation",
    state: "completed",
    action: "none",
    detail: operationalDetail`previous key ${keys.currentKeyId} next key ${keys.nextKeyId}`,
  });
}
