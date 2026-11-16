import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  ARCHIVE_KEEP_PER_HOUSEHOLD_DEFAULT,
  ARCHIVE_KEEP_PER_HOUSEHOLD_MAX,
  ARCHIVE_KEEP_PER_HOUSEHOLD_MIN,
  ARCHIVE_RETENTION_HOURS_DEFAULT,
  ARCHIVE_RETENTION_HOURS_MAX,
  ARCHIVE_RETENTION_HOURS_MIN,
  ARCHIVE_TOTAL_GIB_MAX,
  ARCHIVE_TOTAL_GIB_MIN,
  archiveTotalBytesDefault,
  readArchiveRetentionSettings,
  setArchiveRetention,
} from "orbit/server/archive-retention";

import { read, write } from "$lib/server/api.js";

/**
 * The exports kept (#1792): how long each portable-archive export is kept,
 * how many a household keeps, and the space for every household's exports
 * together. Each is a stored override falling back to its default (6 hours,
 * 2, twice the household quota). The shape of `/api/admin/upload-limit`.
 *
 * GET answers the administrator's own view: the three values in force, the
 * defaults, the overrides (each `null` for the default), the bounds and the
 * version their next write must carry. Only an instance administrator gets
 * an answer; the engine refuses everyone else.
 *
 * POST carries `expectedVersion` on every mutation; `set` sends all three
 * values in whole hours, exports and GB, and `default` is its own action, so
 * going back to every default is never ambiguous.
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    expectedVersion: z.number().int().positive(),
    retentionHours: z.number().int().min(ARCHIVE_RETENTION_HOURS_MIN).max(ARCHIVE_RETENTION_HOURS_MAX),
    keepPerHousehold: z.number().int().min(ARCHIVE_KEEP_PER_HOUSEHOLD_MIN).max(ARCHIVE_KEEP_PER_HOUSEHOLD_MAX),
    maxTotalGigabytes: z.number().int().min(ARCHIVE_TOTAL_GIB_MIN).max(ARCHIVE_TOTAL_GIB_MAX),
  }),
  z.object({
    action: z.literal("default"),
    expectedVersion: z.number().int().positive(),
  }),
]);

/* Under fixtures this answers "the defaults, never changed" rather than
   reaching the engine, as the upload limit route does. */
const defaults = () => {
  const totalBytes = archiveTotalBytesDefault();
  const triple = { retentionHours: ARCHIVE_RETENTION_HOURS_DEFAULT, keepPerHousehold: ARCHIVE_KEEP_PER_HOUSEHOLD_DEFAULT, maxTotalBytes: totalBytes };
  return json(
    {
      archiveStorage: {
        ...triple,
        defaults: triple,
        overrides: { retentionHours: null, keepPerHousehold: null, maxTotalBytes: null },
        bounds: {
          retentionHours: [ARCHIVE_RETENTION_HOURS_MIN, ARCHIVE_RETENTION_HOURS_MAX],
          keepPerHousehold: [ARCHIVE_KEEP_PER_HOUSEHOLD_MIN, ARCHIVE_KEEP_PER_HOUSEHOLD_MAX],
          maxTotalGigabytes: [ARCHIVE_TOTAL_GIB_MIN, ARCHIVE_TOTAL_GIB_MAX],
        },
        version: 1,
        updatedAt: null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
};

export const GET = read(
  async (_event, session) => {
    const archiveStorage = await readArchiveRetentionSettings(session.user.id);
    return json({ archiveStorage }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: defaults },
);

export const POST = write(async (event, session) => {
  const command = mutationSchema.parse(await event.request.json());
  const archiveStorage = await setArchiveRetention(
    session.user.id,
    command.expectedVersion,
    command.action === "set"
      ? { retentionHours: command.retentionHours, keepPerHousehold: command.keepPerHousehold, maxTotalGigabytes: command.maxTotalGigabytes }
      : null,
  );
  return json({ archiveStorage }, { headers: { "cache-control": "no-store" } });
});
