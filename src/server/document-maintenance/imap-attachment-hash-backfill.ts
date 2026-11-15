/**
 * The backfill step of #1778's expand -> backfill -> contract migration
 * (design note 58551, build note E), shaped on `content-index-backfill.ts`:
 * a bounded batch per maintenance cycle, never at boot or in a migration.
 *
 * A mail-in attachment held before #1778 has its SHA-256 in plain in
 * `imap_ingestion_attachments.content_sha256`. Each such row is fixed in one
 * UPDATE that fills `content_index` (the blind index of `<messageId>:<sha256>`
 * under the INSTANCE key, which the per-mail unique reads), seals the hash
 * into `content_sha256_sealed` under the receipt's scope key (its current
 * household's, or the instance key while it has none) bound to the row id,
 * and empties the plain column, guarded on the plain value it read. So a
 * crash mid-batch loses nothing, a second pass is a no-op, and a hash changed
 * under it is never replaced by a seal of the old one. Until a row is reached
 * its readers fall back to the plain value, among them the per-mail dedupe in
 * `commitStagedAttachment`. Dropping the plain column is a later release
 * (#1835).
 *
 * The seal must be under the household the receipt has when it is written,
 * and attributing a receipt re-keys only seals already there. So each row is
 * written while holding a share lock on its message row, re-checking the
 * household; `assignImapReceiptHousehold` takes that row for update before it
 * re-keys, so the two are ordered and neither leaves a seal under a scope
 * the receipt has left. A row whose household moved since it was read is
 * left for a later cycle.
 *
 * Only a value that is a SHA-256 (64 lowercase hex characters) is sealed and
 * cleared. Any other plain value is damage: left exactly as it is, reported
 * once per process, and counted toward the batch like any other row. The
 * work list is paged by row id with a cursor kept between cycles, so damaged
 * rows are passed in turn rather than read first on every cycle.
 */
import { and, asc, eq, gt, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { log, operationalDetail } from "@/lib/logger";
import { ATTACHMENT_CONTENT_HASH_COLUMN, sealContentHash } from "@/server/documents/content-hash";
import { noteMetadataDamage } from "@/server/metadata/damage-sightings";
import { openReceiptMetadataWriter, requireInstanceMetadataWriter, type MetadataCipher } from "@/server/metadata/fields";
import { MetadataKeyLockedError } from "@/server/metadata/keys";

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** The id of the last row looked at, kept between cycles. */
let cursor: string | null = null;

/** Rows already reported as damaged in this process: reported once. */
const reportedDamage = new Set<string>();

function reportDamageOnce(rowId: string): void {
  if (reportedDamage.has(rowId)) return;
  reportedDamage.add(rowId);
  noteMetadataDamage(ATTACHMENT_CONTENT_HASH_COLUMN, rowId);
  log.warn({
    event: "metadata.integrity",
    state: "degraded",
    reason: "metadata_integrity_failed",
    impact: "metadata_field_unreadable",
    action: "inspect_admin_diagnostics",
    detail: operationalDetail`${ATTACHMENT_CONTENT_HASH_COLUMN} row ${rowId} holds a plain value that is not a SHA-256`,
  });
}

type WorkRow = { id: string; messageId: string; householdId: string | null; plain: string };

/** Fixes one row; returns how many rows it changed (0 or 1). */
async function fixRow(instance: MetadataCipher, scope: MetadataCipher, row: WorkRow): Promise<number> {
  if (!SHA256_HEX.test(row.plain)) {
    reportDamageOnce(row.id);
    return 0;
  }
  const contentIndex = instance.attachmentContentIndex(row.messageId, row.plain);
  const contentSha256Sealed = sealContentHash(scope, row.id, row.plain, ATTACHMENT_CONTENT_HASH_COLUMN);
  return getDb().transaction(async (transaction) => {
    const [message] = await transaction.select({ householdId: imapIngestionMessages.householdId }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.id, row.messageId)).for("share").limit(1);
    /* Moved since it was read: sealed on a later cycle under the new scope. */
    if (!message || message.householdId !== row.householdId) return 0;
    const updated = await transaction.update(imapIngestionAttachments).set({
      contentSha256: null,
      contentSha256Sealed,
      contentIndex,
      updatedAt: new Date(),
    }).where(and(
      eq(imapIngestionAttachments.id, row.id),
      eq(imapIngestionAttachments.contentSha256, row.plain),
    )).returning({ id: imapIngestionAttachments.id });
    return updated.length;
  });
}

/** The cipher map key of a receipt scope: a household id, or the instance. */
const INSTANCE = "instance";
const scopeKey = (householdId: string | null) => householdId ?? INSTANCE;

/**
 * Looks at no more than `limit` rows; returns how many it fixed.
 *
 * A household whose key will not open is passed over for this cycle without
 * using up the batch, and the batch carries on with the rest; its rows wait
 * for a cycle where the key opens. With the instance key locked nothing can
 * be indexed, so the cycle does nothing. One warning per cycle.
 */
export async function backfillImapAttachmentHashes(limit = 200): Promise<number> {
  /* No key is opened (or minted) until there is a row to fix. */
  const [waiting] = await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
    .where(isNotNull(imapIngestionAttachments.contentSha256)).limit(1);
  if (!waiting) {
    cursor = null;
    return 0;
  }
  let instance: MetadataCipher;
  try {
    instance = await requireInstanceMetadataWriter();
  } catch (error) {
    /* Refused as a 503 `metadata_locked`, or the lock itself. */
    if (!(error instanceof MetadataKeyLockedError) && !(error instanceof AppError && error.code === "metadata_locked")) throw error;
    log.warn({ event: "document.worker", state: "degraded", reason: "key_unavailable", action: "contact_operator", impact: "worker_degraded" });
    return 0;
  }
  const ciphers = new Map<string, MetadataCipher>([[INSTANCE, instance]]);
  const skipped: string[] = [];
  let fixed = 0;
  let looked = 0;
  /* A pass that starts mid-list wraps round once to the rows before the cursor. */
  let wrapped = cursor === null;
  while (looked < limit) {
    const after = cursor;
    const rows = await getDb().select({
      id: imapIngestionAttachments.id,
      messageId: imapIngestionAttachments.messageId,
      householdId: imapIngestionMessages.householdId,
      plain: imapIngestionAttachments.contentSha256,
    }).from(imapIngestionAttachments)
      .innerJoin(imapIngestionMessages, eq(imapIngestionMessages.id, imapIngestionAttachments.messageId))
      .where(and(
        isNotNull(imapIngestionAttachments.contentSha256),
        after === null ? undefined : gt(imapIngestionAttachments.id, after),
        skipped.length > 0
          ? or(isNull(imapIngestionMessages.householdId), notInArray(imapIngestionMessages.householdId, skipped))
          : undefined,
      ))
      .orderBy(asc(imapIngestionAttachments.id))
      .limit(limit - looked);
    if (rows.length === 0) {
      cursor = null;
      if (wrapped) break;
      wrapped = true;
      continue;
    }
    for (const row of rows) {
      cursor = row.id;
      const key = scopeKey(row.householdId);
      if (skipped.includes(key)) continue;
      let scope = ciphers.get(key);
      if (!scope) {
        try {
          /* The writer mints the household key if it has none yet, as a write would. */
          scope = await openReceiptMetadataWriter(row.householdId);
        } catch (error) {
          if (!(error instanceof MetadataKeyLockedError)) throw error;
          skipped.push(key);
          continue;
        }
        ciphers.set(key, scope);
      }
      looked += 1;
      fixed += await fixRow(instance, scope, { ...row, plain: row.plain! });
    }
  }
  if (skipped.length > 0) {
    log.warn({ event: "document.worker", state: "degraded", reason: "key_unavailable", action: "contact_operator", impact: "worker_degraded" });
  }
  if (fixed > 0) log.info({ event: "document.worker", state: "ready", action: "none" });
  return fixed;
}
