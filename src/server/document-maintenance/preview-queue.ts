/**
 * The light half of the kept-preview worker (#1433 D12): enqueueing a job and
 * waking the loop. Kept apart from preview-jobs.ts so the upload and import
 * paths that enqueue do not import the renderer.
 */
import { sql } from "drizzle-orm";
import type { getDb } from "@/db";

/**
 * Enqueues a document's preview job: generation 1 for a new document, or the
 * next generation when its pages must be drawn again. At most one open job per
 * document: none is added while one is pending, retrying or processing.
 * `db` may be a transaction, so the job commits with what made the document
 * available.
 */
export async function enqueuePreviewJob(db: Pick<ReturnType<typeof getDb>, "execute">, documentId: string): Promise<void> {
  await db.execute(sql`
    insert into document_jobs (document_id, kind, generation, status)
    select ${documentId}::uuid, 'preview', coalesce(max(generation), 0) + 1, 'pending'
    from document_jobs
    where document_id = ${documentId}::uuid and kind = 'preview'
    having count(*) filter (where status in ('pending', 'retry', 'processing')) = 0
    on conflict (document_id, kind, generation) do nothing
  `);
}

/**
 * Pages drawn ahead of any view: the structure check's page cap (100). A
 * document stored under the old 1,000-page cap has its later pages drawn
 * when viewed (owner answer 10a). Written out rather than imported, so this
 * light module does not pull in the validation code.
 */
export const PREVIEW_PAGES_DRAWN_AHEAD = 100;

/**
 * Enqueues the document's preview job again if any page it should have drawn
 * ahead has no row: its count is unknown, or one of its first 100 pages is
 * missing. Used on restore, since a job that ran while the document was
 * pending deletion, or a deletion in the middle of a slice, ended with pages
 * undrawn (#1433, owner answer 12a). A refused page counts as there, except
 * a timeout or crash with its retry still left (attempts < 2, D18), which is
 * owed. Also called by the worker after a slice that saw the document gone,
 * so a restore that commits while that slice is finishing is not lost.
 */
export async function enqueuePreviewJobIfIncomplete(db: Pick<ReturnType<typeof getDb>, "execute">, documentId: string): Promise<void> {
  const rows = await db.execute(sql`
    select d.page_count as "pageCount",
           (select count(*)::int from document_previews p
             where p.document_id = d.id and p.page <= least(coalesce(d.page_count, 1), ${PREVIEW_PAGES_DRAWN_AHEAD})
               and not (p.status = 'refused' and p.refusal in ('timeout', 'crash') and p.attempts < 2)) as "kept"
    from documents d
    where d.id = ${documentId}::uuid
  `) as unknown as Array<{ pageCount: number | null; kept: number }>;
  const [row] = rows;
  if (!row) return;
  if (row.pageCount === null || row.kept < Math.min(row.pageCount, PREVIEW_PAGES_DRAWN_AHEAD)) await enqueuePreviewJob(db, documentId);
}

export const previewWorkerState = globalThis as typeof globalThis & {
  __orbitPreviewWorkerStarted?: boolean;
  __orbitPreviewWorkerWake?: () => void;
};

/** Wakes the preview worker in this process, if it is sleeping; a no-op where none was started. */
export function notifyPreviewWorker(): void {
  previewWorkerState.__orbitPreviewWorkerWake?.();
}

