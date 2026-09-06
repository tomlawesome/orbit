import { and, eq, gt, sql } from "drizzle-orm";
import type { CookieReader, CookieSink } from "@/lib/http";
import { getDb } from "@/db";
import { auditLog, sessions, userPreferences, users } from "@/db/schema";
import type { AuthConfig } from "@/lib/env";
import { ACCOUNT_LIFECYCLE_LOCK_KEY } from "@/lib/auth/authority-locks";
import { clearSessionCookie, sessionCookieName, setSessionCookie } from "@/lib/auth/cookies";
import { constantTimeEqual, createCsrfToken, hashSessionToken, randomUrlSafe } from "@/lib/auth/crypto";
import { AuthError } from "@/lib/auth/errors";
import type { TextSize, UrgencyPalette } from "@/lib/preferences";

export interface AuthenticatedSession {
  id: string;
  token: string;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
    avatarUrl: string | null;
    isInstanceAdmin: boolean;
    themeMode: "system" | "light" | "dark";
    themeId: string;
    textSize: TextSize;
    urgencyPalette: UrgencyPalette;
    emailNotifications: boolean;
    pushNotifications: boolean;
  };
  activeHouseholdId: string | null;
  expiresAt: Date;
}

/**
 * `userAgent` is the request's own `User-Agent` header, truncated to a bound
 * that comfortably holds any real browser string while capping what a
 * hostile caller could stuff into the column. It is stored for the "where
 * you're signed in" list (#482) and never returned as-is — see
 * `lib/auth/device.ts` for the coarse word pair that list actually shows.
 */
const USER_AGENT_MAX_LENGTH = 256;

export async function createSession(
  userId: string,
  config: AuthConfig,
  userAgent?: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomUrlSafe(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);
    const [user] = await transaction.select({ disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, userId)).limit(1);
    if (!user || user.disabledAt) {
      throw new AuthError("account_disabled", "This Orbit account is disabled", 403);
    }
    await transaction.insert(sessions).values({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
    });
  });
  return { token, expiresAt };
}

export async function deleteSessionToken(token: string | undefined): Promise<void> {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}

/**
 * Signs one user out of every device (#468).
 *
 * The scope is the user, not the session: the caller's own cookie dies with
 * all the others, because the point of the action is that a device the reader
 * no longer trusts loses access. Nothing caches a session — `readSession`
 * reads the row on every request — so the next request from any of those
 * devices finds no row and is refused, with no revocation list, token version
 * or invalidated-before timestamp needed to make that true.
 *
 * The audit entry records only ids and a count: session tokens are hashed
 * secrets and never appear in it, or anywhere else.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  return getDb().transaction(async (transaction) => {
    const removed = await transaction.delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: userId,
      entityType: "user",
      entityId: userId,
      action: "sessions_revoked",
      changes: { sessions: removed.length },
    });
    return removed.length;
  });
}

/** How long a stale `last_seen_at` is left alone before a validating request
 *  refreshes it — see `touchLastSeen` below. */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Records that a session just proved itself, throttled so an ordinary
 * request does not write on every hit (#482).
 *
 * Every `readSession` call is a validation, and a busy reader validates many
 * times a minute; writing `last_seen_at` on each one would turn a read path
 * into a write storm for no benefit the "where you're signed in" list needs.
 * Skipping the write below the throttle window is the whole of that
 * trade-off — the list only needs to be accurate to within a few minutes.
 */
async function touchLastSeen(sessionId: string, lastSeenAt: Date | null): Promise<void> {
  if (lastSeenAt && Date.now() - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) return;
  await getDb().update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId));
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  userAgent: string | null;
}

/**
 * Every session the caller holds, for the "where you're signed in" list
 * (#482). Bounded facts only — never the token hash, and the raw
 * `userAgent` returned here is reduced to a coarse word pair by the route,
 * not by this function, so every other caller of `listSessions` (there are
 * none yet, but the boundary is deliberate) gets the same choice to make
 * rather than inheriting an already-lossy answer.
 */
export async function listSessions(userId: string): Promise<SessionSummary[]> {
  return getDb()
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId));
}

/**
 * Ends exactly one of the caller's own sessions (#482) — the single-device
 * counterpart to `revokeUserSessions`'s sign-out-everywhere.
 *
 * Scoped by `userId` in the same query as `id`, so a session id that exists
 * but belongs to someone else fails exactly like one that does not exist at
 * all: `session_not_found`, never a distinguishable error. The audit entry
 * lives on the session as its own entity, unlike the user-scoped
 * `sessions_revoked` count `revokeUserSessions` writes, because this action
 * names one row rather than summarising a purge.
 */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const [removed] = await transaction.delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    if (!removed) throw new AuthError("session_not_found", "That session is not available", 404);
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: userId,
      entityType: "session",
      entityId: sessionId,
      action: "session_revoked",
      changes: {},
    });
  });
}

export async function readSession(cookies: CookieReader, config: AuthConfig): Promise<AuthenticatedSession | null> {
  const token = cookies.get(sessionCookieName(config));
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const [record] = await getDb()
    .select({
      id: sessions.id,
      activeHouseholdId: sessions.activeHouseholdId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isInstanceAdmin: users.isInstanceAdmin,
      disabledAt: users.disabledAt,
      themeMode: userPreferences.themeMode,
      themeId: userPreferences.themeId,
      textSize: userPreferences.textSize,
      urgencyPalette: userPreferences.urgencyPalette,
      emailNotifications: userPreferences.emailNotifications,
      pushNotifications: userPreferences.pushNotifications,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!record || record.disabledAt) {
    await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
  await touchLastSeen(record.id, record.lastSeenAt);
  return {
    id: record.id,
    token,
    activeHouseholdId: record.activeHouseholdId,
    expiresAt: record.expiresAt,
    user: {
      id: record.userId,
      email: record.email,
      emailVerified: record.emailVerified,
      displayName: record.displayName,
      avatarUrl: record.avatarUrl,
      isInstanceAdmin: record.isInstanceAdmin,
      themeMode: record.themeMode ?? "system",
      themeId: record.themeId ?? "after-dark",
      textSize: record.textSize === "standard" || record.textSize === "large" || record.textSize === "extra-large"
        ? record.textSize
        : "comfortable",
      urgencyPalette: record.urgencyPalette === "classic" ? "classic" : "themed",
      emailNotifications: record.emailNotifications ?? true,
      pushNotifications: record.pushNotifications ?? true,
    },
  };
}

export async function requireSession(cookies: CookieReader, config: AuthConfig): Promise<AuthenticatedSession> {
  const session = await readSession(cookies, config);
  if (!session) throw new AuthError("session_required", "A valid session is required", 401);
  return session;
}

export async function rotateSession(session: AuthenticatedSession, cookies: CookieSink, config: AuthConfig): Promise<void> {
  const nextToken = randomUrlSafe(32);
  const nextExpiry = new Date(Date.now() + config.sessionTtlSeconds * 1000);
  const [rotated] = await getDb()
    .update(sessions)
    .set({
      tokenHash: hashSessionToken(nextToken),
      expiresAt: nextExpiry,
      rotatedAt: new Date(),
    })
    .where(and(eq(sessions.id, session.id), eq(sessions.tokenHash, hashSessionToken(session.token))))
    .returning({ id: sessions.id });
  if (!rotated) throw new AuthError("session_required", "The session was replaced by another request", 401);
  setSessionCookie(cookies, nextToken, config);
}

export function assertSameOrigin(headers: Headers, config: AuthConfig): void {
  const origin = headers.get("origin");
  const fetchSite = headers.get("sec-fetch-site");
  let requestOrigin: string | undefined;
  try {
    requestOrigin = origin ? new URL(origin).origin : undefined;
  } catch {
    requestOrigin = undefined;
  }
  if (!requestOrigin || requestOrigin !== config.appUrl.origin || fetchSite === "cross-site") {
    throw new AuthError("csrf_failed", "The request origin could not be verified", 403);
  }
}

export function assertCsrf(headers: Headers, session: AuthenticatedSession, config: AuthConfig): void {
  assertSameOrigin(headers, config);
  const supplied = headers.get("x-csrf-token");
  const expected = createCsrfToken(session.token, config.sessionSecret);
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    throw new AuthError("csrf_failed", "The CSRF token is missing or invalid", 403);
  }
}

export function csrfTokenForSession(session: AuthenticatedSession, config: AuthConfig): string {
  return createCsrfToken(session.token, config.sessionSecret);
}

export async function invalidateSession(cookies: CookieSink, config: AuthConfig): Promise<void> {
  await deleteSessionToken(cookies.get(sessionCookieName(config)));
  clearSessionCookie(cookies, config);
}
