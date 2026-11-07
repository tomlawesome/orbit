/**
 * #1437, detection note decision 3: every document stored before
 * `documents.content_index` existed has its `content_sha256` and no blind
 * index, so "you already hold this document" cannot match it yet. This fills
 * them, a bounded batch per maintenance cycle and never at boot, as
 * `rollBackUnfinishedPortableImports` and the other sweeps run (ADR-0010).
 *
 * Resume-safe because the predicate is the work list: a row is written only
 * while it still has no value, so a crash mid-batch loses nothing, a second
 * pass is a no-op, and a value an upload already wrote is never replaced.
 * Until a row is reached it is simply not matched. Nothing is decrypted: the
 * value is keyed from the household DEK over the plaintext hash.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { log } from "@/lib/logger";
import { openMetadataWriter } from "@/server/metadata/fields";
import { MetadataKeyLockedError } from "@/server/metadata/keys";

/** Fills at most `limit` rows; returns how many it filled. */
export async function backfillDocumentContentIndexes(limit = 200): Promise<number> {
  const rows = await getDb().select({
    id: documents.id,
    householdId: documents.householdId,
    contentSha256: documents.contentSha256,
  }).from(documents)
    .where(isNull(documents.contentIndex))
    .orderBy(asc(documents.householdId))
    .limit(limit);
  if (rows.length === 0) return 0;

  const byHousehold = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byHousehold.get(row.householdId);
    if (group) group.push(row); else byHousehold.set(row.householdId, [row]);
  }

  let filled = 0;
  for (const [householdId, group] of byHousehold) {
    let metadata;
    try {
      /* The writer mints the household key if it has none yet, as an upload would. */
      metadata = await openMetadataWriter(householdId);
    } catch (error) {
      if (!(error instanceof MetadataKeyLockedError)) throw error;
      /* No usable key: the instance is locked (#1405) and nothing can be keyed. */
      log.warn({ event: "document.lifecycle", state: "degraded", reason: "key_unavailable", action: "contact_operator", impact: "worker_degraded" });
      return filled;
    }
    for (const row of group) {
      const contentIndex = metadata.contentIndex(row.contentSha256);
      if (!contentIndex) continue;
      const updated = await getDb().update(documents).set({ contentIndex })
        .where(and(eq(documents.id, row.id), isNull(documents.contentIndex)))
        .returning({ id: documents.id });
      filled += updated.length;
    }
  }
  if (filled > 0) log.info({ event: "document.lifecycle", state: "ready", action: "none" });
  return filled;
}
