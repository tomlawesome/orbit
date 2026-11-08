/**
 * The backfill step of two expand -> backfill -> contract migrations, a
 * bounded batch per maintenance cycle and never at boot, as
 * `rollBackUnfinishedPortableImports` and the other sweeps run (ADR-0010):
 *
 * - #1437, detection note decision 3: a document stored before
 *   `documents.content_index` existed has no blind index, so "you already
 *   hold this document" cannot match it yet;
 * - #1771, build note 55084: a document stored before
 *   `documents.content_sha256_sealed` existed has its SHA-256 in plain.
 *
 * The work list is every row that still has a plain `content_sha256` (every
 * row from before #1437 has one), and every row that lacks a blind index.
 * A plain row is fixed in one UPDATE that seals the hash under the household
 * key, fills a missing blind index, and empties the plain column, guarded on
 * the plain value it read; a sealed row missing only its index has the index
 * filled from the opened seal, guarded on the sealed value it read. So a
 * crash mid-batch loses nothing, a second pass is a no-op, a hash changed
 * under it is never replaced by a seal of the old one, and a blind index an
 * upload already wrote is never replaced. Until a row is reached its readers
 * fall back to the plain value, and duplicate detection without a blind
 * index simply does not match it. The dropping of the plain column is a
 * later release (#1779).
 */
import { and, asc, desc, eq, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { log } from "@/lib/logger";
import { openContentHash, sealContentHash } from "@/server/documents/content-hash";
import { openMetadataWriter } from "@/server/metadata/fields";
import { MetadataKeyLockedError } from "@/server/metadata/keys";

/**
 * Fixes at most `limit` rows; returns how many it fixed. Rows missing their
 * blind index come first, then by household.
 *
 * A household whose key will not open (its row damaged, or the instance
 * locked, #1405) is passed over for this cycle and the batch carries on with
 * the households after it, so one locked key never holds up the rest; its
 * rows wait for a cycle where the key opens. One warning per cycle, however
 * many households were passed over. A sealed value that will not open is
 * passed over the same way, without using up the batch, and stays as it is:
 * its damage is reported where it is read, and nothing is guessed for it.
 */
export async function backfillDocumentContentIndexes(limit = 200): Promise<number> {
  const skipped: string[] = [];
  const unopenable: string[] = [];
  let fixed = 0;
  let looked = 0;
  while (looked < limit) {
    const rows = await getDb().select({
      id: documents.id,
      householdId: documents.householdId,
      plain: documents.contentSha256,
      sealed: documents.contentSha256Sealed,
      indexMissing: isNull(documents.contentIndex).mapWith(Boolean),
    }).from(documents)
      .where(and(
        or(isNotNull(documents.contentSha256), isNull(documents.contentIndex)),
        skipped.length > 0 ? notInArray(documents.householdId, skipped) : undefined,
        unopenable.length > 0 ? notInArray(documents.id, unopenable) : undefined,
      ))
      .orderBy(desc(isNull(documents.contentIndex)), asc(documents.householdId))
      .limit(limit - looked);
    if (rows.length === 0) break;

    const byHousehold = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byHousehold.get(row.householdId);
      if (group) group.push(row); else byHousehold.set(row.householdId, [row]);
    }

    let passedOver = false;
    for (const [householdId, group] of byHousehold) {
      let metadata;
      try {
        /* The writer mints the household key if it has none yet, as an upload would. */
        metadata = await openMetadataWriter(householdId);
      } catch (error) {
        if (!(error instanceof MetadataKeyLockedError)) throw error;
        skipped.push(householdId);
        passedOver = true;
        continue;
      }
      for (const row of group) {
        const plain = row.plain;
        if (plain === null) {
          /* Sealed, missing only its blind index. */
          const opened = openContentHash(metadata, row.id, { plain: null, sealed: row.sealed });
          if (!opened.ok) {
            unopenable.push(row.id);
            passedOver = true;
            continue;
          }
          looked += 1;
          const updated = await getDb().update(documents).set({ contentIndex: metadata.contentIndex(opened.sha256) })
            .where(and(
              eq(documents.id, row.id),
              isNull(documents.contentIndex),
              isNull(documents.contentSha256),
              eq(documents.contentSha256Sealed, row.sealed!),
            ))
            .returning({ id: documents.id });
          fixed += updated.length;
          continue;
        }
        looked += 1;
        /* An empty value holds no hash to seal: it is emptied, and nothing else changes. */
        const sealed = plain === "" ? {} : {
          contentSha256Sealed: sealContentHash(metadata, row.id, plain),
          ...row.indexMissing ? { contentIndex: metadata.contentIndex(plain) } : {},
        };
        /* Guarded on what was read: the plain value, and a blind index still
           missing if one is being written, so neither is ever overwritten. */
        const updated = await getDb().update(documents).set({ contentSha256: null, ...sealed })
          .where(and(
            eq(documents.id, row.id),
            eq(documents.contentSha256, plain),
            row.indexMissing ? isNull(documents.contentIndex) : undefined,
          ))
          .returning({ id: documents.id });
        fixed += updated.length;
      }
    }
    /* Only a passed-over household or row leaves room in the batch worth asking again for. */
    if (!passedOver) break;
  }
  if (skipped.length > 0) {
    log.warn({ event: "document.worker", state: "degraded", reason: "key_unavailable", action: "contact_operator", impact: "worker_degraded" });
  }
  if (fixed > 0) log.info({ event: "document.worker", state: "ready", action: "none" });
  return fixed;
}
