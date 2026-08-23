import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { authErrorResponse } from "@/lib/auth/http";
import { assertCsrf, requireSession, rotateSession } from "@/lib/auth/session";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const response = NextResponse.json(
      { refreshed: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    await rotateSession(session, response, config);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
