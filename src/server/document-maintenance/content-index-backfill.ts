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
 *
 * Only a value that is a SHA-256 (64 lowercase hex characters) is sealed and
 * cleared. Any other plain value, and a seal that will not open, is damage:
 * it is left exactly as it is, reported once per process, and counts toward
 * the batch like any other row. The work list is paged by row id with a
 * cursor kept between cycles, so damaged rows are passed in turn rather than
 * read first on every cycle, and no exclusion list of rows grows.
 */
import { and, asc, eq, gt, isNotNull, isNull, not, notInArray, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { log, operationalDetail } from "@/lib/logger";
import { CONTENT_HASH_COLUMN, openContentHash, sealContentHash } from "@/server/documents/content-hash";
import { noteMetadataDamage } from "@/server/metadata/damage-sightings";
import { openMetadataWriter, type MetadataCipher } from "@/server/metadata/fields";
import { MetadataKeyLockedError } from "@/server/metadata/keys";

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * Two passes, each with its own cursor: rows missing their blind index first
 * (the #1437 work), then plain rows that already have one (the #1771 work).
 */
type Pass = "index" | "plain";
const PASSES: readonly Pass[] = ["index", "plain"];
const cursors: Record<Pass, string | null> = { index: null, plain: null };

function workOf(pass: Pass): SQL {
  return pass === "index"
    ? isNull(documents.contentIndex)
    : and(isNotNull(documents.contentSha256), not(isNull(documents.contentIndex)))!;
}

/** Rows already reported as damaged in this process: reported once, never reopened. */
const reportedDamage = new Set<string>();

function reportDamageOnce(rowId: string, reason: string): void {
  if (reportedDamage.has(rowId)) return;
  reportedDamage.add(rowId);
  noteMetadataDamage(CONTENT_HASH_COLUMN, rowId);
  log.warn({
    event: "metadata.integrity",
    state: "degraded",
    reason: "metadata_integrity_failed",
    impact: "metadata_field_unreadable",
    action: "inspect_admin_diagnostics",
    detail: operationalDetail`${CONTENT_HASH_COLUMN} row ${rowId} ${reason}`,
  });
}

type WorkRow = { id: string; householdId: string; plain: string | null; sealed: string | null; indexMissing: boolean };

/** Fixes one row; returns how many rows it changed (0 or 1). */
async function fixRow(metadata: MetadataCipher, row: WorkRow): Promise<number> {
  const plain = row.plain;
  if (plain === null) {
    /* Sealed, missing only its blind index. */
    if (reportedDamage.has(row.id)) return 0;
    const opened = openContentHash(metadata, row.id, { plain: null, sealed: row.sealed });
    if (!opened.ok) {
      /* `text` has already reported a seal that failed authentication. */
      if (opened.reason === "metadata_integrity_failed") reportedDamage.add(row.id);
      else reportDamageOnce(row.id, "has no content hash to index");
      return 0;
    }
    const updated = await getDb().update(documents).set({ contentIndex: metadata.contentIndex(opened.sha256) })
      .where(and(
        eq(documents.id, row.id),
        isNull(documents.contentIndex),
        isNull(documents.contentSha256),
        eq(documents.contentSha256Sealed, row.sealed!),
      ))
      .returning({ id: documents.id });
    return updated.length;
  }
  if (!SHA256_HEX.test(plain)) {
    reportDamageOnce(row.id, "holds a plain value that is not a SHA-256");
    return 0;
  }
  /* Guarded on what was read: the plain value, and a blind index still
     missing if one is being written, so neither is ever overwritten. */
  const updated = await getDb().update(documents).set({
    contentSha256: null,
    contentSha256Sealed: sealContentHash(metadata, row.id, plain),
    ...row.indexMissing ? { contentIndex: metadata.contentIndex(plain) } : {},
  }).where(and(
    eq(documents.id, row.id),
    eq(documents.contentSha256, plain),
    row.indexMissing ? isNull(documents.contentIndex) : undefined,
  )).returning({ id: documents.id });
  return updated.length;
}

/**
 * Looks at no more than `limit` rows; returns how many it fixed.
 *
 * A household whose key will not open (its row damaged, or the instance
 * locked, #1405) is passed over for this cycle, without using up the batch,
 * and the batch carries on with the rest, so one locked key never holds up
 * the others; its rows wait for a cycle where the key opens. One warning per
 * cycle, however many households were passed over.
 */
export async function backfillDocumentContentIndexes(limit = 200): Promise<number> {
  const ciphers = new Map<string, MetadataCipher>();
  const skipped: string[] = [];
  let fixed = 0;
  let looked = 0;
  for (const pass of PASSES) {
    /* A pass that starts mid-list wraps round once to the rows before its cursor. */
    let wrapped = cursors[pass] === null;
    while (looked < limit) {
      const after = cursors[pass];
      const rows: WorkRow[] = await getDb().select({
        id: documents.id,
        householdId: documents.householdId,
        plain: documents.contentSha256,
        sealed: documents.contentSha256Sealed,
        indexMissing: isNull(documents.contentIndex).mapWith(Boolean),
      }).from(documents)
        .where(and(
          workOf(pass),
          after === null ? undefined : gt(documents.id, after),
          skipped.length > 0 ? notInArray(documents.householdId, skipped) : undefined,
        ))
        .orderBy(asc(documents.id))
        .limit(limit - looked);
      if (rows.length === 0) {
        cursors[pass] = null;
        if (wrapped) break;
        wrapped = true;
        continue;
      }
      for (const row of rows) {
        cursors[pass] = row.id;
        if (skipped.includes(row.householdId)) continue;
        let metadata = ciphers.get(row.householdId);
        if (!metadata) {
          try {
            /* The writer mints the household key if it has none yet, as an upload would. */
            metadata = await openMetadataWriter(row.householdId);
          } catch (error) {
            if (!(error instanceof MetadataKeyLockedError)) throw error;
            skipped.push(row.householdId);
            continue;
          }
          ciphers.set(row.householdId, metadata);
        }
        looked += 1;
        fixed += await fixRow(metadata, row);
      }
    }
  }
  if (skipped.length > 0) {
    log.warn({ event: "document.worker", state: "degraded", reason: "key_unavailable", action: "contact_operator", impact: "worker_degraded" });
  }
  if (fixed > 0) log.info({ event: "document.worker", state: "ready", action: "none" });
  return fixed;
}
