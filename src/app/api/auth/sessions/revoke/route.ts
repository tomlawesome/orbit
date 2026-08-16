import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { clearSessionCookie } from "@/lib/auth/cookies";
import { authErrorResponse } from "@/lib/auth/http";
import { assertCsrf, requireSession, revokeUserSessions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * "Sign out of every device" (#468, settings §13).
 *
 * Every session this user holds ends, the caller's own included — a device
 * the reader no longer trusts must lose access, and a caller who kept their
 * own session would have no way to know which device that was. The response
 * clears the cookie so this browser stops presenting a token that is already
 * dead; every other device is refused on its next request because
 * `readSession` finds no row.
 *
 * The scope is the session's own user id, never one from the request, so
 * there is nothing to name and no way to sign anyone else out. A CSRF token
 * is required: an action this destructive must not be reachable from another
 * origin's form post.
 */
export async function POST(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const revoked = await revokeUserSessions(session.user.id);
    const response = NextResponse.json({ revoked }, { headers: { "Cache-Control": "no-store" } });
    clearSessionCookie(response, config);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
