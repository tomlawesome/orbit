import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, instanceMailLimit } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { requireInstanceAdministrator } from "@/server/authorization";
import { IMAP_ATTACHMENT_LIMITS, MAIL_MESSAGE_CEILING_BYTES } from "@/server/mail-in/core/imap-attachment-validation";

/**
 * The mail size limit an administrator can set (#1388, design note 54592),
 * apart from the upload limit: one setting that bounds the raw message, the
 * set of attachments and each attachment arriving by mail.
 *
 * The ceiling is the memory bound, not a preference: a collected message is
 * fetched whole into memory, DKIM holds a copy and the attachments are copied
 * again, so the peak is about six times the cap. 50 MiB keeps that near
 * 300 MiB. The bounds and default are code constants, not environment
 * variables (#1629 is taking every mail setting out of `.env-orbit`).
 *
 * Same singleton shape as `src/server/upload-limit.ts`: the 0008 migration
 * seeds the one row unconditionally, `version` gates every administrator
 * write, and every change is written to `audit_log`. Ingestion reads the
 * effective limit once at the start of each cycle, so a change applies from
 * the next poll with no restart.
 */

const MIB = 1_048_576;

export const MAIL_LIMIT_FLOOR = 1 * MIB;
/** 50 MiB, kept in mail-in core so the pure code can default to it without a database import. */
export const MAIL_LIMIT_CEILING = MAIL_MESSAGE_CEILING_BYTES;
/** 25 MiB, the cap mail-in has always had. */
export const MAIL_LIMIT_DEFAULT = IMAP_ATTACHMENT_LIMITS.rawMessageBytes;

/** Whole MiB only: the screen asks in MB, and the bounds are whole MiB too. */
export const MAIL_LIMIT_MIN_MEGABYTES = MAIL_LIMIT_FLOOR / MIB;
export const MAIL_LIMIT_MAX_MEGABYTES = MAIL_LIMIT_CEILING / MIB;

export interface MailLimitSettings {
  /** What ingestion enforces from the next cycle. */
  maxBytes: number;
  /** `MAIL_LIMIT_DEFAULT`: what "use the default" goes back to. */
  defaultBytes: number;
  /** The administrator's own choice, or null when the default applies. */
  overrideBytes: number | null;
  minBytes: number;
  ceilingBytes: number;
  version: number;
  updatedAt: string;
}

type MailLimitRow = typeof instanceMailLimit.$inferSelect;

function withinBounds(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= MAIL_LIMIT_FLOOR && bytes <= MAIL_LIMIT_CEILING;
}

/**
 * The override when one is set and inside the bounds, the default otherwise.
 * The CHECK already refuses an out-of-bounds row; refusing it here too means a
 * damaged row can only fall back to the default, never widen the limit.
 */
export function resolveMailLimit(overrideBytes: number | null | undefined): number {
  if (overrideBytes === null || overrideBytes === undefined) return MAIL_LIMIT_DEFAULT;
  return withinBounds(overrideBytes) ? overrideBytes : MAIL_LIMIT_DEFAULT;
}

/** Turns the administrator's MB into bytes, refusing anything outside the bounds. */
export function mailLimitBytesFromMegabytes(megabytes: number): number {
  if (!Number.isInteger(megabytes) || megabytes < MAIL_LIMIT_MIN_MEGABYTES || megabytes > MAIL_LIMIT_MAX_MEGABYTES) {
    throw new AppError(
      "mail_limit_out_of_range",
      `The mail size limit must be a whole number of MB from ${MAIL_LIMIT_MIN_MEGABYTES} to ${MAIL_LIMIT_MAX_MEGABYTES}`,
      422,
    );
  }
  return megabytes * MIB;
}

async function readRow(): Promise<MailLimitRow | undefined> {
  const [row] = await getDb().select().from(instanceMailLimit).limit(1);
  return row;
}

function toSettings(row: MailLimitRow): MailLimitSettings {
  return {
    maxBytes: resolveMailLimit(row.maxBytes),
    defaultBytes: MAIL_LIMIT_DEFAULT,
    overrideBytes: row.maxBytes,
    minBytes: MAIL_LIMIT_FLOOR,
    ceilingBytes: MAIL_LIMIT_CEILING,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The limit a collected message is held to. No actor: ingestion needs it
 * whoever the mail is for. A missing row means no override.
 */
export async function readEffectiveMailLimit(): Promise<number> {
  const row = await readRow();
  return resolveMailLimit(row?.maxBytes);
}

/** The administrator's own read, with the version their next write must carry. */
export async function readMailLimitSettings(actorUserId: string): Promise<MailLimitSettings> {
  await requireInstanceAdministrator(actorUserId);
  const row = await readRow();
  if (!row) {
    // The 0008 migration seeds this row unconditionally.
    throw new AppError("mail_limit_state_missing", "Mail limit state has not been initialized", 500);
  }
  return toSettings(row);
}

/** Sets the administrator's limit, or with `maxBytes: null` goes back to the default. */
export async function setMailLimit(
  actorUserId: string,
  expectedVersion: number,
  maxBytes: number | null,
): Promise<MailLimitSettings> {
  await requireInstanceAdministrator(actorUserId);
  if (maxBytes !== null && !withinBounds(maxBytes)) {
    throw new AppError("mail_limit_out_of_range", "The mail size limit is outside the allowed range", 422);
  }

  await getDb().transaction(async (transaction) => {
    const [row] = await transaction.select().from(instanceMailLimit).for("update").limit(1);
    if (!row) throw new AppError("mail_limit_state_missing", "Mail limit state has not been initialized", 500);
    if (row.version !== expectedVersion) {
      throw new AppError("mail_limit_version_conflict", "The mail size limit changed; reload and try again", 409);
    }
    const [updated] = await transaction.update(instanceMailLimit)
      .set({ maxBytes, version: row.version + 1, updatedAt: new Date() })
      .where(eq(instanceMailLimit.version, row.version))
      .returning({ id: instanceMailLimit.id });
    if (!updated) {
      throw new AppError("mail_limit_version_conflict", "The mail size limit changed; reload and try again", 409);
    }
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_mail_limit",
      entityId: updated.id,
      action: maxBytes === null ? "instance_mail_limit_reset" : "instance_mail_limit_set",
      changes: { from: row.maxBytes, to: maxBytes },
    });
  });

  return readMailLimitSettings(actorUserId);
}
