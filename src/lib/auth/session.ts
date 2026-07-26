import { and, eq, gt } from "drizzle-orm";
import type { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { sessions, userPreferences, users } from "@/db/schema";
import type { AuthConfig } from "@/lib/env";
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

export async function createSession(userId: string, config: AuthConfig): Promise<{ token: string; expiresAt: Date }> {
  const token = randomUrlSafe(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
  await getDb().insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export async function deleteSessionToken(token: string | undefined): Promise<void> {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}

export async function readSession(request: NextRequest, config: AuthConfig): Promise<AuthenticatedSession | null> {
  const token = request.cookies.get(sessionCookieName(config))?.value;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const [record] = await getDb()
    .select({
      id: sessions.id,
      activeHouseholdId: sessions.activeHouseholdId,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isInstanceAdmin: users.isInstanceAdmin,
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

  if (!record) {
    await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
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

export async function requireSession(request: NextRequest, config: AuthConfig): Promise<AuthenticatedSession> {
  const session = await readSession(request, config);
  if (!session) throw new AuthError("session_required", "A valid session is required", 401);
  return session;
}

export async function rotateSession(session: AuthenticatedSession, response: NextResponse, config: AuthConfig): Promise<void> {
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
  setSessionCookie(response, nextToken, config);
}

export function assertSameOrigin(request: NextRequest, config: AuthConfig): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
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

export function assertCsrf(request: NextRequest, session: AuthenticatedSession, config: AuthConfig): void {
  assertSameOrigin(request, config);
  const supplied = request.headers.get("x-csrf-token");
  const expected = createCsrfToken(session.token, config.sessionSecret);
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    throw new AuthError("csrf_failed", "The CSRF token is missing or invalid", 403);
  }
}

export function csrfTokenForSession(session: AuthenticatedSession, config: AuthConfig): string {
  return createCsrfToken(session.token, config.sessionSecret);
}

export async function invalidateSession(request: NextRequest, response: NextResponse, config: AuthConfig): Promise<void> {
  await deleteSessionToken(request.cookies.get(sessionCookieName(config))?.value);
  clearSessionCookie(response, config);
}
