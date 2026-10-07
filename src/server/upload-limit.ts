import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, instanceUploadLimit } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { requireInstanceAdministrator } from "@/server/authorization";
import {
  DOCUMENT_MAX_BYTES_CEILING,
  DOCUMENT_MAX_BYTES_FLOOR,
  getDocumentConfig,
  type DocumentConfig,
} from "@/server/documents/config";

/**
 * The document upload size limit an administrator can set (#1285): a stored
 * override, falling back to the configured default. `DOCUMENT_MAX_BYTES` is
 * the starting default; an administrator raises or lowers it in
 * Administration, inside the same hard bounds the configuration has
 * (owner, 2026-10-07, recorded on #1285).
 *
 * Follows `src/server/instance-contact.ts`'s singleton shape: the 0049
 * migration seeds the one row unconditionally, `version` gates every
 * administrator write so two people on the same screen cannot silently
 * overwrite each other, and every change is written to `audit_log` against
 * the row's own stable id.
 *
 * Every upload path reads the effective limit at request time through
 * `readEffectiveUploadLimit()`, so a change takes effect on the next upload
 * with no restart. Reads of documents already stored never use it: those
 * were accepted under whatever limit applied then, and lowering the limit
 * must not make them unreadable (they read against
 * `DOCUMENT_MAX_BYTES_CEILING` instead).
 */

const MIB = 1_048_576;

/** Whole MiB only: the screen asks in MB, and the bounds are whole MiB too. */
export const UPLOAD_LIMIT_MIN_MEGABYTES = DOCUMENT_MAX_BYTES_FLOOR / MIB;
export const UPLOAD_LIMIT_MAX_MEGABYTES = DOCUMENT_MAX_BYTES_CEILING / MIB;

export interface UploadLimitSettings {
  /** What every upload path enforces right now. */
  maxBytes: number;
  /** `DOCUMENT_MAX_BYTES`: what "use the default" goes back to. */
  defaultBytes: number;
  /** The administrator's own choice, or null when the default applies. */
  overrideBytes: number | null;
  minBytes: number;
  ceilingBytes: number;
  version: number;
  updatedAt: string;
}

type UploadLimitRow = typeof instanceUploadLimit.$inferSelect;

function withinBounds(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= DOCUMENT_MAX_BYTES_FLOOR && bytes <= DOCUMENT_MAX_BYTES_CEILING;
}

/**
 * The effective limit: the override when one is set and inside the hard
 * bounds, the configured default otherwise. The database CHECK already
 * refuses an out-of-bounds override; refusing it here as well means a
 * damaged row can only ever fall back to the default, never widen the limit.
 */
export function resolveUploadLimit(overrideBytes: number | null | undefined, defaultBytes: number): number {
  if (overrideBytes === null || overrideBytes === undefined) return defaultBytes;
  return withinBounds(overrideBytes) ? overrideBytes : defaultBytes;
}

/**
 * Turns the administrator's MB into bytes, refusing anything outside the
 * hard bounds before it can reach the database.
 */
export function uploadLimitBytesFromMegabytes(megabytes: number): number {
  if (!Number.isInteger(megabytes) || megabytes < UPLOAD_LIMIT_MIN_MEGABYTES || megabytes > UPLOAD_LIMIT_MAX_MEGABYTES) {
    throw new AppError(
      "upload_limit_out_of_range",
      `The upload size limit must be a whole number of MB from ${UPLOAD_LIMIT_MIN_MEGABYTES} to ${UPLOAD_LIMIT_MAX_MEGABYTES}`,
      422,
    );
  }
  return megabytes * MIB;
}

async function readRow(): Promise<UploadLimitRow | undefined> {
  const [row] = await getDb().select().from(instanceUploadLimit).limit(1);
  return row;
}

function toSettings(row: UploadLimitRow, defaultBytes: number): UploadLimitSettings {
  return {
    maxBytes: resolveUploadLimit(row.maxBytes, defaultBytes),
    defaultBytes,
    overrideBytes: row.maxBytes,
    minBytes: DOCUMENT_MAX_BYTES_FLOOR,
    ceilingBytes: DOCUMENT_MAX_BYTES_CEILING,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The limit an upload is held to, read fresh on every call. No actor: every
 * upload path needs it, whoever is uploading. A missing row (a database that
 * predates 0049) means no override, so the configured default applies.
 */
export async function readEffectiveUploadLimit(config: DocumentConfig = getDocumentConfig()): Promise<number> {
  const row = await readRow();
  return resolveUploadLimit(row?.maxBytes, config.maxBytes);
}

/** The administrator's own read, with the version their next write must carry. */
export async function readUploadLimitSettings(actorUserId: string): Promise<UploadLimitSettings> {
  await requireInstanceAdministrator(actorUserId);
  const row = await readRow();
  if (!row) {
    // The 0049 migration seeds this row unconditionally; its absence means
    // the database predates that migration or was tampered with.
    throw new AppError("upload_limit_state_missing", "Upload limit state has not been initialized", 500);
  }
  return toSettings(row, getDocumentConfig().maxBytes);
}

/**
 * Sets the administrator's limit, or with `maxBytes: null` goes back to the
 * configured default. Out-of-bounds values are refused before the write.
 */
export async function setUploadLimit(
  actorUserId: string,
  expectedVersion: number,
  maxBytes: number | null,
): Promise<UploadLimitSettings> {
  await requireInstanceAdministrator(actorUserId);
  if (maxBytes !== null && !withinBounds(maxBytes)) {
    throw new AppError("upload_limit_out_of_range", "The upload size limit is outside the allowed range", 422);
  }

  await getDb().transaction(async (transaction) => {
    const [row] = await transaction.select().from(instanceUploadLimit).for("update").limit(1);
    if (!row) throw new AppError("upload_limit_state_missing", "Upload limit state has not been initialized", 500);
    if (row.version !== expectedVersion) {
      throw new AppError("upload_limit_version_conflict", "The upload size limit changed; reload and try again", 409);
    }
    const [updated] = await transaction.update(instanceUploadLimit)
      .set({ maxBytes, version: row.version + 1, updatedAt: new Date() })
      .where(eq(instanceUploadLimit.version, row.version))
      .returning({ id: instanceUploadLimit.id });
    if (!updated) {
      throw new AppError("upload_limit_version_conflict", "The upload size limit changed; reload and try again", 409);
    }
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_upload_limit",
      entityId: updated.id,
      action: maxBytes === null ? "instance_upload_limit_reset" : "instance_upload_limit_set",
      changes: { from: row.maxBytes, to: maxBytes },
    });
  });

  return readUploadLimitSettings(actorUserId);
}
