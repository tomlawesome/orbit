/**
 * The signed-in user's what's-new record (#1618): the newest release whose
 * notes they have seen, kept per person in `user_preferences`. Like the tour
 * record, nothing here takes a user other than the caller's own id.
 *
 * A null value is a new account: reading it records the running version and
 * shows nothing, so a fresh account never sees old notes. Migration 0002
 * gave everyone who existed before the feature `v0.0.0`.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userPreferences } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { compareReleaseVersions, parseReleaseVersion } from "@/lib/release-version";
import { selectReleaseNotes, selectWhatsNew, type WhatsNewAnswer } from "@/lib/whats-new";
import { releaseNotes, type ReleaseNotes } from "@/release-notes";
import { isInstanceAdministrator } from "@/server/authorization";

type Database = ReturnType<typeof getDb>;
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface WhatsNewOptions {
  /** `process.env.ORBIT_VERSION`; anything that is not `vX.Y.Z` (a dev build) makes everything a no-op. */
  runningVersion?: string | null;
  /** Injected by tests; defaults to the notes the repo carries. */
  notes?: readonly ReleaseNotes[];
}

/**
 * Records the running version for an account that has none. Never overwrites a
 * value, and does nothing when the version does not parse. Pass the account
 * creation's transaction so the two succeed or fail together.
 */
export async function recordNewAccountSeenVersion(
  userId: string,
  runningVersion: string | null | undefined,
  executor: Executor = getDb(),
): Promise<void> {
  if (parseReleaseVersion(runningVersion) === null) return;
  await executor.insert(userPreferences)
    .values({ userId, whatsNewSeenVersion: runningVersion })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { whatsNewSeenVersion: runningVersion },
      setWhere: sql`${userPreferences.whatsNewSeenVersion} IS NULL`,
    });
}

/** What the session's own user is shown. */
export async function readWhatsNew(userId: string, options: WhatsNewOptions = {}): Promise<WhatsNewAnswer> {
  const running = options.runningVersion ?? null;
  if (parseReleaseVersion(running) === null) return { version: null, releases: [] };
  const db = getDb();
  const [row] = await db.select({ seen: userPreferences.whatsNewSeenVersion })
    .from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  let seen = row?.seen ?? null;
  if (seen === null) {
    await recordNewAccountSeenVersion(userId, running, db);
    seen = running;
  }
  const isAdmin = await isInstanceAdministrator(userId, db);
  return selectWhatsNew({ seen, running, isAdmin, notes: options.notes ?? releaseNotes });
}

/**
 * The About page's release notes (#1713): every bundled release, filtered by
 * the session's own user's role as readWhatsNew filters it (the administrator
 * fact read here, never taken from the caller). Records nothing -- not even a
 * new account's seen version -- so reading the page leaves the card's notice
 * as it was.
 */
export async function readReleaseNotes(userId: string, options: WhatsNewOptions = {}): Promise<WhatsNewAnswer> {
  const isAdmin = await isInstanceAdministrator(userId);
  return selectReleaseNotes({ running: options.runningVersion ?? null, isAdmin, notes: options.notes ?? releaseNotes });
}

/**
 * Stores max(seen, min(shown, running)): the stored value never goes
 * backwards, and a dismissal sent across a server upgrade cannot mark a
 * release as seen that was not shown. Idempotent. A malformed `shown` is a 422.
 */
export async function dismissWhatsNew(userId: string, shown: string, options: WhatsNewOptions = {}): Promise<void> {
  if (parseReleaseVersion(shown) === null) {
    throw new AppError("validation_failed", "That is not a release version", 422);
  }
  const running = options.runningVersion ?? null;
  if (parseReleaseVersion(running) === null) return;
  const target = compareReleaseVersions(shown, running as string) <= 0 ? shown : (running as string);
  await getDb().transaction(async (transaction) => {
    await transaction.insert(userPreferences).values({ userId }).onConflictDoNothing();
    const [row] = await transaction.select({ seen: userPreferences.whatsNewSeenVersion })
      .from(userPreferences).where(eq(userPreferences.userId, userId)).for("update");
    const seen = row?.seen ?? null;
    if (seen !== null && parseReleaseVersion(seen) !== null && compareReleaseVersions(seen, target) >= 0) return;
    await transaction.update(userPreferences).set({ whatsNewSeenVersion: target }).where(eq(userPreferences.userId, userId));
  });
}
