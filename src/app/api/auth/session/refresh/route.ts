import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { authErrorResponse } from "@/lib/auth/http";
import { assertCsrf, requireSession, rotateSession } from "@/lib/auth/session";
import { nextCookies, nextCookieSink } from "@/lib/auth/next-compat";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
    const response = NextResponse.json(
      { refreshed: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    await rotateSession(session, nextCookieSink(request, response), config);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
