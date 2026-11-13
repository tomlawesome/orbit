/**
 * The kept-preview worker (#1433 D12, D13): every page of every available
 * document is drawn once, in the background, and kept.
 *
 * Standard pattern: derived renditions generated at ingest by a background
 * job queue with leases (Paperless-ngx's thumbnails, Nextcloud's preview
 * cache), fair by cooperative round-robin. One pass claims each due `preview`
 * job once, oldest first; each claim decrypts its document once to an
 * unlinked quarantine file, draws up to ten pages in the `background` pool
 * (one slot, nice 10), and either completes the job or puts it back at the
 * end of the line. A 100-page scan therefore gets ten pages, then every
 * one-page bill behind it gets its turn. Only the first 100 pages are drawn
 * ahead; a document stored under the old 1,000-page cap has its later pages
 * drawn when viewed (owner answer 10a).
 */
import { open, rm, type FileHandle } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { documentCrypto, documentJobs, documents } from "@/db/schema";
import { log } from "@/lib/logger";
import { completeJob, failJob, holdsJobLease, jobFailureCode } from "@/server/document-maintenance/claims";
import { getDocumentConfig, keyEncryptionKeyFor } from "@/server/documents/config";
import { createDocumentUnsealer, envelopeOf } from "@/server/documents/crypto";
import { readPdfPageCountInSandbox } from "@/server/documents/pdf-structure-sandbox";
import { drawImagePage, drawPdfPage, type PreviewDraw } from "@/server/documents/preview";
import { listPreviews, type PreviewOwner, storeDrawnPreview, storeRefusedPreview, type PreviewRow } from "@/server/documents/preview-store";
import { type LocalDocumentStorage, openDocumentStorage } from "@/server/documents/storage";
import { enqueuePreviewJobIfIncomplete, PREVIEW_PAGES_DRAWN_AHEAD, previewWorkerState } from "@/server/document-maintenance/preview-queue";

export { enqueuePreviewJob, notifyPreviewWorker } from "@/server/document-maintenance/preview-queue";

/** Pages one claim draws before the job goes to the back of the line. */
export const PREVIEW_PAGES_PER_SLICE = 10;
/** A decrypt that fails this many claims running ends the job as `failed`, visible in health, until an administrator retries it or a restore, sweep repair or read repair queues a new generation (failed does not block `enqueuePreviewJob`); a busy wait is not an attempt. */
const PREVIEW_MAX_ATTEMPTS = 5;
/** A full quarantine tmpfs, or a renderer that cannot start, is a wait, not a failure. */
const PREVIEW_SPACE_RETRY_MS = 60_000;
/** Sleep when a pass found nothing to claim; `notifyPreviewWorker()` cuts it short. */
const PREVIEW_IDLE_MS = 30_000;

type ClaimedPreviewJob = { id: string; documentId: string; generation: number; leaseToken: string };

/** Claims the oldest due preview job not yet claimed in this pass (`next_attempt_at` up to the pass's start). */
async function claimPreviewJob(passStart: string): Promise<ClaimedPreviewJob | undefined> {
  const rows = await getDb().execute(sql`
    with claimable as materialized (
      select job.id
      from document_jobs job
      where job.kind = 'preview'
        and (
          (job.status in ('pending', 'retry') and job.next_attempt_at <= ${passStart}::timestamptz)
          or (job.status = 'processing' and job.lease_expires_at < now() and job.updated_at <= ${passStart}::timestamptz)
        )
      order by job.next_attempt_at, job.created_at
      for update of job skip locked
      limit 1
    )
    update document_jobs as job
    set status = 'processing',
        attempts = job.attempts + 1,
        locked_at = now(),
        lease_expires_at = now() + interval '5 minutes',
        lease_token = gen_random_uuid(),
        updated_at = now()
    from claimable
    where job.id = claimable.id
    returning job.id, job.document_id as "documentId", job.generation, job.lease_token as "leaseToken"
  `);
  return (rows as unknown as ClaimedPreviewJob[])[0];
}

/** Back to the end of the line after a slice that made progress (attempts reset) or a wait (the claim's attempt is undone); the attempt count only counts failures. */
async function releaseForNextSlice(job: ClaimedPreviewJob, delayMs = 0): Promise<void> {
  await getDb().update(documentJobs).set({
    status: "retry",
    attempts: delayMs === 0 ? 0 : sql`greatest(${documentJobs.attempts} - 1, 0)`,
    nextAttemptAt: sql`now() + ${`${delayMs} milliseconds`}::interval`,
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    updatedAt: sql`now()`,
  }).where(and(holdsJobLease(job), eq(documentJobs.kind, "preview")));
}

async function finish(job: ClaimedPreviewJob): Promise<void> {
  await completeJob(getDb(), and(holdsJobLease(job), eq(documentJobs.kind, "preview")));
}

/**
 * Ends a job whose slice found the document not available. A restore may
 * commit while this job is still `processing`, when its own enqueue adds
 * nothing (one open job per document), so the job is completed and the
 * document read again in one transaction (#1433, 12a). The read takes a share
 * lock on the document row, which a restore holds until it commits: either
 * the restore committed first and this queues the owed pages, or it commits
 * after and its enqueue sees this job completed.
 */
async function finishGone(job: ClaimedPreviewJob): Promise<void> {
  await getDb().transaction(async (transaction) => {
    if (!await completeJob(transaction, and(holdsJobLease(job), eq(documentJobs.kind, "preview")))) return;
    const [row] = await transaction.select({ lifecycle: documents.lifecycle }).from(documents)
      .where(eq(documents.id, job.documentId)).for("share").limit(1);
    if (row?.lifecycle === "available") await enqueuePreviewJobIfIncomplete(transaction, job.documentId);
  });
}

async function isAvailable(documentId: string): Promise<boolean> {
  const [row] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId)).limit(1);
  return row?.lifecycle === "available";
}

/** Whether a page still needs a drawing: no row, or a timeout or crash tried only once (D18). */
function needsDrawing(row: PreviewRow | undefined): boolean {
  if (!row) return true;
  if (row.status === "drawn") return false;
  return (row.refusal === "timeout" || row.refusal === "crash") && row.attempts < 2;
}

/** Records one page's drawing; answers false when the document went away under it. */
async function keep(storage: LocalDocumentStorage, owner: PreviewOwner, page: number, draw: PreviewDraw): Promise<boolean> {
  if (draw.outcome === "drawn") {
    try {
      return (await storeDrawnPreview(storage, getDocumentConfig(), owner, page, draw)) !== undefined;
    } finally {
      draw.bytes.fill(0);
    }
  }
  if (draw.outcome === "refused") {
    if (!await isAvailable(owner.documentId)) return false;
    await storeRefusedPreview(owner.documentId, page, draw.refusal);
  }
  return true;
}

type SliceSource =
  | { kind: "pdf"; handle: FileHandle; sizeBytes: number }
  | { kind: "image"; bytes: Buffer; mediaType: "image/jpeg" | "image/png" };

/** One claim's work: draw up to ten pages, then complete the job or put it back. */
async function runSlice(job: ClaimedPreviewJob): Promise<void> {
  const config = getDocumentConfig();
  const storage = openDocumentStorage();
  const [record] = await getDb().select({
    householdId: documents.householdId,
    itemId: documents.itemId,
    sealedItemId: documents.sealedItemId,
    mediaType: documents.mediaType,
    sizeBytes: documents.sizeBytes,
    lifecycle: documents.lifecycle,
    pageCount: documents.pageCount,
    crypto: documentCrypto,
  }).from(documents)
    .leftJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
    .where(eq(documents.id, job.documentId))
    .limit(1);
  const itemId = record?.sealedItemId ?? record?.itemId;
  // Gone, deleted or never openable: nothing to draw, ever, for this generation.
  if (!record || record.lifecycle !== "available" || !record.crypto || !itemId) {
    await (record && record.lifecycle !== "available" ? finishGone(job) : finish(job));
    return;
  }
  const owner: PreviewOwner = { documentId: job.documentId, householdId: record.householdId, itemId };
  const kek = keyEncryptionKeyFor(config, record.crypto.keyId);
  if (!kek) {
    await failJob({ db: getDb(), owns: holdsJobLease(job), code: "key_unavailable", maxAttempts: PREVIEW_MAX_ATTEMPTS, retryDelayMs: retryDelay });
    return;
  }

  const kept = new Map((await listPreviews(job.documentId)).map((row) => [row.page, row]));
  const knownCount = record.pageCount ?? undefined;
  if (knownCount !== undefined && !Array.from({ length: Math.min(knownCount, PREVIEW_PAGES_DRAWN_AHEAD) }, (_, index) => index + 1).some((page) => needsDrawing(kept.get(page)))) {
    await finish(job);
    return;
  }

  const unsealer = createDocumentUnsealer({
    documentId: job.documentId,
    householdId: record.householdId,
    itemId,
    mediaType: record.mediaType,
    plaintextSize: record.sizeBytes,
  }, envelopeOf(record.crypto), kek);
  let source: SliceSource;
  try {
    if (record.mediaType === "application/pdf") {
      // Decrypted once to the quarantine tmpfs, its tag verified before the
      // path is returned; opened and unlinked at once, so only the descriptor
      // holds the plaintext and a crash leaves nothing on disk.
      const { quarantinePath } = await storage.unsealToQuarantine(
        { kind: "object", storageKey: record.crypto.storageKey },
        job.documentId,
        { ciphertextSize: record.crypto.ciphertextSize, plaintextSize: record.sizeBytes },
        unsealer,
      );
      let handle: FileHandle;
      try {
        handle = await open(quarantinePath, "r");
      } finally {
        await rm(quarantinePath, { force: true });
      }
      source = { kind: "pdf", handle, sizeBytes: record.sizeBytes };
    } else if (record.mediaType === "image/jpeg" || record.mediaType === "image/png") {
      const bytes = await storage.unsealIntoBuffer(
        record.crypto.storageKey,
        { ciphertextSize: record.crypto.ciphertextSize, plaintextSize: record.sizeBytes },
        unsealer,
      );
      source = { kind: "image", bytes, mediaType: record.mediaType };
    } else {
      await finish(job);
      return;
    }
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "document_upload_space_busy") {
      await releaseForNextSlice(job, PREVIEW_SPACE_RETRY_MS);
      return;
    }
    await failJob({ db: getDb(), owns: holdsJobLease(job), code: jobFailureCode(error, "preview_decrypt_failed"), maxAttempts: PREVIEW_MAX_ATTEMPTS, retryDelayMs: retryDelay });
    return;
  }

  try {
    let pageCount = knownCount;
    if (source.kind === "image") pageCount = 1;
    if (pageCount === undefined && source.kind === "pdf") {
      // A document from before #1436: pdfinfo reads its real count once, with
      // no page cap (it may have up to 1,000 pages), and the count is kept.
      const counted = await readPdfPageCountInSandbox({ handle: source.handle, sizeBytes: source.sizeBytes }, "background");
      if (counted.outcome === "failed" && counted.stop === "unavailable") {
        await releaseForNextSlice(job, PREVIEW_SPACE_RETRY_MS);
        return;
      }
      if (counted.outcome === "failed") {
        // A timeout, memory or crash stop of pdfinfo is a busy host as often
        // as the file: the job stays open and is tried again with backoff,
        // and ends `failed`, visible in health, only after its attempts.
        await failJob({ db: getDb(), owns: holdsJobLease(job), code: "preview_count_interrupted", maxAttempts: PREVIEW_MAX_ATTEMPTS, retryDelayMs: retryDelay });
        return;
      }
      if (counted.outcome !== "counted") {
        // pdfinfo refused the file (D18): nothing this generation can draw.
        await finish(job);
        return;
      }
      pageCount = counted.pageCount;
    }
    if (pageCount !== undefined && knownCount === undefined) {
      await getDb().update(documents).set({ pageCount }).where(and(eq(documents.id, job.documentId), sql`${documents.pageCount} is null`));
    }

    let drawn = 0;
    const ahead = Math.min(pageCount!, PREVIEW_PAGES_DRAWN_AHEAD);
    for (let page = 1; page <= ahead; page += 1) {
      if (!needsDrawing(kept.get(page))) continue;
      if (drawn === PREVIEW_PAGES_PER_SLICE) {
        await releaseForNextSlice(job);
        return;
      }
      // Deleted mid-slice: the job ends here, and no further page is drawn.
      if (!await isAvailable(job.documentId)) {
        await finishGone(job);
        return;
      }
      drawn += 1;
      const draw = source.kind === "pdf"
        ? await drawPdfPage({ handle: source.handle, sizeBytes: source.sizeBytes }, page, "background")
        : await drawImagePage(source.bytes, source.mediaType, "background");
      if (draw.outcome === "page_not_found") break;
      // Orbit's side, not the file's: try the document again in a minute,
      // and remember nothing about the page (D20).
      if (draw.outcome === "busy") {
        await releaseForNextSlice(job, PREVIEW_SPACE_RETRY_MS);
        return;
      }
      if (!await keep(storage, owner, page, draw)) {
        await finishGone(job);
        return;
      }
    }
    await finish(job);
  } finally {
    if (source.kind === "pdf") await source.handle.close().catch(() => undefined);
    else source.bytes.fill(0);
  }
}

function retryDelay(attempt: number): number {
  return Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * One round-robin pass: claims, one at a time, each preview job due when the
 * pass began, at most once each, and runs its slice. Resolves to the number
 * of jobs claimed (falsy when there was nothing to claim).
 */
export async function runPreviewWorkerOnce(): Promise<number> {
  const [{ at: passStart }] = await getDb().execute(sql`select now()::text as at`) as unknown as Array<{ at: string }>;
  let claimed = 0;
  for (;;) {
    const job = await claimPreviewJob(passStart);
    if (!job) return claimed;
    claimed += 1;
    try {
      await runSlice(job);
    } catch (error) {
      await failJob({ db: getDb(), owns: holdsJobLease(job), code: jobFailureCode(error, "preview_failed"), maxAttempts: PREVIEW_MAX_ATTEMPTS, retryDelayMs: retryDelay });
    }
  }
}

/** Starts one preview loop per process; PostgreSQL leases coordinate replicas. */
export function startPreviewWorker(idleMilliseconds = PREVIEW_IDLE_MS): void {
  if (previewWorkerState.__orbitPreviewWorkerStarted) return;
  previewWorkerState.__orbitPreviewWorkerStarted = true;
  const loop = async () => {
    for (;;) {
      let claimed = 0;
      try {
        claimed = await runPreviewWorkerOnce();
      } catch {
        // The cause may carry paths or provider text; the bounded record is enough.
        log.error({ event: "document.worker", state: "retrying", reason: "worker_cycle_failed", action: "inspect_admin_diagnostics", impact: "worker_degraded" });
      }
      if (claimed > 0) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, idleMilliseconds);
        timer.unref();
        function done() {
          clearTimeout(timer);
          previewWorkerState.__orbitPreviewWorkerWake = undefined;
          resolve();
        }
        previewWorkerState.__orbitPreviewWorkerWake = done;
      });
    }
  };
  void loop();
}
