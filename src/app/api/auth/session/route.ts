import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { authErrorResponse } from "@/lib/auth/http";
import { csrfTokenForSession, readSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await readSession(nextCookies(request), config);
    if (!session) {
      return NextResponse.json(
        { authenticated: false },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({
      authenticated: true,
      user: session.user,
      activeHouseholdId: session.activeHouseholdId,
      expiresAt: session.expiresAt.toISOString(),
      csrfToken: csrfTokenForSession(session, config),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
