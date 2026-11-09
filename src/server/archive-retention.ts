import { eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, instanceArchiveRetention, portableArchives } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { requireInstanceAdministrator } from "@/server/authorization";
import { documentHouseholdQuotaBytes } from "@/server/documents/config";

/**
 * How long, how many and how much portable-archive exports are kept (#1792):
 * three administrator settings, under "Exports kept" on the administration
 * screen.
 *
 * - Kept for: whole hours, 1 to 720, default 6. A changed value retimes the
 *   exports already kept, from their `created_at`, in the same transaction.
 * - Kept per system: 1 to 10 live exports per household, default 2; a newer
 *   export replaces the household's oldest.
 * - Space for all exports: 1 to 102 400 GiB, default twice the household
 *   quota (never under 1 GiB), so it follows the quota the operator already
 *   sizes the disk for; past it the oldest downloaded export of any
 *   household goes first (`createPortableArchive`).
 *
 * Same singleton shape as `src/server/mail-limit.ts`: the 0013 migration
 * seeds the one row unconditionally with all three null (null = the
 * default), `version` gates every administrator write, and every change is
 * written to `audit_log`. A value equal to its default is stored as null.
 */

const GIB = 1_073_741_824;
const HOUR_MS = 3_600_000;

export const ARCHIVE_RETENTION_HOURS_DEFAULT = 6;
export const ARCHIVE_RETENTION_HOURS_MIN = 1;
export const ARCHIVE_RETENTION_HOURS_MAX = 720;
export const ARCHIVE_KEEP_PER_HOUSEHOLD_DEFAULT = 2;
export const ARCHIVE_KEEP_PER_HOUSEHOLD_MIN = 1;
export const ARCHIVE_KEEP_PER_HOUSEHOLD_MAX = 10;
export const ARCHIVE_TOTAL_GIB_MIN = 1;
export const ARCHIVE_TOTAL_GIB_MAX = 102_400;

const OUT_OF_RANGE_MESSAGE = `The archive settings must be whole numbers: hours from ${ARCHIVE_RETENTION_HOURS_MIN} to ${ARCHIVE_RETENTION_HOURS_MAX}, exports per system from ${ARCHIVE_KEEP_PER_HOUSEHOLD_MIN} to ${ARCHIVE_KEEP_PER_HOUSEHOLD_MAX}, space from ${ARCHIVE_TOTAL_GIB_MIN} to ${ARCHIVE_TOTAL_GIB_MAX} GB`;
const VERSION_CONFLICT_MESSAGE = "The archive settings changed; reload and try again";

/**
 * Twice the household quota: one full-size export always fits beside
 * another household's full-size one. Never under the 1 GiB minimum, so a
 * small quota still gives a default inside the allowed range. The quota is
 * read without the document key, so the fixture screen and a missing key
 * still have a default.
 */
export function archiveTotalBytesDefault(config: { householdQuotaBytes: number } = { householdQuotaBytes: documentHouseholdQuotaBytes() }): number {
  return Math.max(ARCHIVE_TOTAL_GIB_MIN * GIB, 2 * config.householdQuotaBytes);
}

type Triple = { retentionHours: number; keepPerHousehold: number; maxTotalBytes: number };

export interface ArchiveRetentionSettings extends Triple {
  defaults: Triple;
  overrides: { retentionHours: number | null; keepPerHousehold: number | null; maxTotalBytes: number | null };
  bounds: { retentionHours: [number, number]; keepPerHousehold: [number, number]; maxTotalGigabytes: [number, number] };
  version: number;
  updatedAt: string;
}

type RetentionRow = typeof instanceArchiveRetention.$inferSelect;

const within = (value: number | null | undefined, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function defaults(): Triple {
  return {
    retentionHours: ARCHIVE_RETENTION_HOURS_DEFAULT,
    keepPerHousehold: ARCHIVE_KEEP_PER_HOUSEHOLD_DEFAULT,
    maxTotalBytes: archiveTotalBytesDefault(),
  };
}

/**
 * Each override when set and inside its range, the default otherwise. The
 * CHECKs already refuse an out-of-range row; refusing it here too means a
 * damaged row can only fall back to a default, never widen a bound.
 */
function inForce(row: Pick<RetentionRow, "retentionHours" | "maxPerHousehold" | "maxTotalBytes"> | undefined): Triple {
  const base = defaults();
  return {
    retentionHours: within(row?.retentionHours, ARCHIVE_RETENTION_HOURS_MIN, ARCHIVE_RETENTION_HOURS_MAX) ? row.retentionHours : base.retentionHours,
    keepPerHousehold: within(row?.maxPerHousehold, ARCHIVE_KEEP_PER_HOUSEHOLD_MIN, ARCHIVE_KEEP_PER_HOUSEHOLD_MAX) ? row.maxPerHousehold : base.keepPerHousehold,
    maxTotalBytes: within(row?.maxTotalBytes, ARCHIVE_TOTAL_GIB_MIN * GIB, ARCHIVE_TOTAL_GIB_MAX * GIB) ? row.maxTotalBytes : base.maxTotalBytes,
  };
}

async function readRow(): Promise<RetentionRow | undefined> {
  const [row] = await getDb().select().from(instanceArchiveRetention).limit(1);
  return row;
}

function toSettings(row: RetentionRow): ArchiveRetentionSettings {
  return {
    ...inForce(row),
    defaults: defaults(),
    overrides: { retentionHours: row.retentionHours, keepPerHousehold: row.maxPerHousehold, maxTotalBytes: row.maxTotalBytes },
    bounds: {
      retentionHours: [ARCHIVE_RETENTION_HOURS_MIN, ARCHIVE_RETENTION_HOURS_MAX],
      keepPerHousehold: [ARCHIVE_KEEP_PER_HOUSEHOLD_MIN, ARCHIVE_KEEP_PER_HOUSEHOLD_MAX],
      maxTotalGigabytes: [ARCHIVE_TOTAL_GIB_MIN, ARCHIVE_TOTAL_GIB_MAX],
    },
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stateMissing(): AppError {
  // The 0013 migration seeds this row unconditionally.
  return new AppError("archive_retention_state_missing", "Archive retention state has not been initialized", 500);
}

/**
 * What an export is held to. No actor: every export needs it, whoever writes
 * it. A missing row means the defaults.
 */
export async function readEffectiveArchiveRetention(): Promise<{ retentionMs: number; keepPerHousehold: number; maxTotalBytes: number }> {
  const settings = inForce(await readRow());
  return { retentionMs: settings.retentionHours * HOUR_MS, keepPerHousehold: settings.keepPerHousehold, maxTotalBytes: settings.maxTotalBytes };
}

/** The administrator's own read, with the version their next write must carry. */
export async function readArchiveRetentionSettings(actorUserId: string): Promise<ArchiveRetentionSettings> {
  await requireInstanceAdministrator(actorUserId);
  const row = await readRow();
  if (!row) throw stateMissing();
  return toSettings(row);
}

/**
 * Sets the three values, or with `null` goes back to every default. A value
 * equal to its default is stored as null, so "set here" shows only for a
 * value that differs. A changed retention retimes the exports already kept.
 */
export async function setArchiveRetention(
  actorUserId: string,
  expectedVersion: number,
  values: { retentionHours: number; keepPerHousehold: number; maxTotalGigabytes: number } | null,
): Promise<ArchiveRetentionSettings> {
  await requireInstanceAdministrator(actorUserId);
  if (values !== null && (
    !within(values.retentionHours, ARCHIVE_RETENTION_HOURS_MIN, ARCHIVE_RETENTION_HOURS_MAX)
    || !within(values.keepPerHousehold, ARCHIVE_KEEP_PER_HOUSEHOLD_MIN, ARCHIVE_KEEP_PER_HOUSEHOLD_MAX)
    || !within(values.maxTotalGigabytes, ARCHIVE_TOTAL_GIB_MIN, ARCHIVE_TOTAL_GIB_MAX)
  )) {
    throw new AppError("archive_retention_out_of_range", OUT_OF_RANGE_MESSAGE, 422);
  }
  const base = defaults();
  const stored = values === null
    ? { retentionHours: null, maxPerHousehold: null, maxTotalBytes: null }
    : {
      retentionHours: values.retentionHours === base.retentionHours ? null : values.retentionHours,
      maxPerHousehold: values.keepPerHousehold === base.keepPerHousehold ? null : values.keepPerHousehold,
      maxTotalBytes: values.maxTotalGigabytes * GIB === base.maxTotalBytes ? null : values.maxTotalGigabytes * GIB,
    };

  await getDb().transaction(async (transaction) => {
    const [row] = await transaction.select().from(instanceArchiveRetention).for("update").limit(1);
    if (!row) throw stateMissing();
    if (row.version !== expectedVersion) {
      throw new AppError("archive_retention_version_conflict", VERSION_CONFLICT_MESSAGE, 409);
    }
    const [updated] = await transaction.update(instanceArchiveRetention)
      .set({ ...stored, version: row.version + 1, updatedAt: new Date() })
      .where(eq(instanceArchiveRetention.version, row.version))
      .returning({ id: instanceArchiveRetention.id });
    if (!updated) throw new AppError("archive_retention_version_conflict", VERSION_CONFLICT_MESSAGE, 409);
    const from = inForce(row);
    const to = inForce(stored);
    /* The retention applies to exports already kept: each is retimed from
       when it was written. One already past is unavailable at once
       (downloads require expires_at > now) and the document worker's next
       cycle purges it; a longer retention revives nothing already purged. */
    const retimed = await transaction.update(portableArchives)
      .set({ expiresAt: sql`${portableArchives.createdAt} + make_interval(hours => ${to.retentionHours}::int)` })
      .where(isNull(portableArchives.purgedAt))
      .returning({ id: portableArchives.id });
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "instance_archive_retention",
      entityId: updated.id,
      action: values === null ? "instance_archive_retention_reset" : "instance_archive_retention_set",
      changes: { from, to, rowsRetimed: retimed.length },
    });
  });

  return readArchiveRetentionSettings(actorUserId);
}
