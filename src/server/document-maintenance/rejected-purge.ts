/**
 * Retention sweep for refused uploads (#1786).
 *
 * A `rejected` document row is deleted once it has been rejected for
 * REJECTED_DOCUMENT_RETENTION_MS and none of its staged bytes remain: no
 * `document_staging_objects` row at all, since both of that table's states
 * (`pending`, and `purge_pending` with or without a failure code) mean the
 * staged ciphertext may still exist. Its crypto, job and staging rows go by
 * their `on delete cascade`; reviewed-intake operations and mail-in
 * attachments keep their row with the reference set null; the audit log has no
 * foreign key to documents, so the `document_rejected_*` record stays. A final
 * object a rejected row still names is already unreferenced to storage
 * reconciliation (it only keeps the keys of available and pending-deletion
 * documents), so deleting the row changes nothing about its reclamation.
 *
 * Standard batched retention delete: each batch picks its rows with
 * FOR UPDATE SKIP LOCKED, so two workers running at once take disjoint rows
 * and neither waits on or errors over the other's.
 */
import { sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { REJECTED_DOCUMENT_RETENTION_MS } from "@/server/retention-windows";

const BATCH_SIZE = 100;
const MAX_BATCHES = 10;

export async function purgeExpiredRejectedDocuments(
  db: ReturnType<typeof getDb>,
  { now }: { now: Date },
): Promise<number> {
  const cutoff = new Date(now.getTime() - REJECTED_DOCUMENT_RETENTION_MS);
  let purged = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const deleted = await db.execute(sql`
      delete from documents
      where id in (
        select candidate.id from documents candidate
        where candidate.lifecycle = 'rejected'
          and candidate.updated_at <= ${cutoff.toISOString()}::timestamptz
          and not exists (
            select 1 from document_staging_objects stage where stage.document_id = candidate.id
          )
        order by candidate.updated_at
        limit ${BATCH_SIZE}
        for update skip locked
      )
      and lifecycle = 'rejected'
      returning id
    `);
    purged += deleted.length;
    if (deleted.length < BATCH_SIZE) break;
  }
  return purged;
}
