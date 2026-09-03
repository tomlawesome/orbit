/**
 * The signed-in user's own first-run tour record (#751, slice 1 of #477).
 *
 * A per-user, server-remembered timestamp of whether the walk has been
 * taken: set when the reader skips or finishes it, cleared by "Take the walk
 * again". There is no user parameter on the read or the write: the caller
 * passes the session's own id, so there is nothing to name and therefore no
 * way to read or write someone else's record.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userPreferences } from "@/db/schema";
import type { TourPreference } from "@/lib/preferences";

export interface TourSettings {
  tourSeenAt: string | null;
}

function settingsFor(row: { tourSeenAt: Date | null } | undefined): TourSettings {
  return { tourSeenAt: row?.tourSeenAt ? row.tourSeenAt.toISOString() : null };
}

/** The session's own tour record. A user with no preferences row has never seen it. */
export async function readTourSettings(userId: string): Promise<TourSettings> {
  const [row] = await getDb()
    .select({ tourSeenAt: userPreferences.tourSeenAt })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return settingsFor(row);
}

/** Saves the session's own tour record and answers what is now stored. */
export async function writeTourSettings(userId: string, preference: TourPreference): Promise<TourSettings> {
  const now = new Date();
  const tourSeenAt = preference.tourSeenAt === null ? null : new Date(preference.tourSeenAt);
  await getDb().insert(userPreferences).values({
    userId,
    tourSeenAt,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: userPreferences.userId,
    set: { tourSeenAt, updatedAt: now },
  });
  return readTourSettings(userId);
}
