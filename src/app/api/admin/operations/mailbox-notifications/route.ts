import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { getAuthConfig } from "@/lib/env";
import { retryExhaustedImapNotifications } from "@/server/admin-operations";
import { assertOutsideMaintenance } from "@/server/maintenance";

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
    const body = await request.json().catch(() => ({})) as { action?: string };
    if (body.action !== "retry_exhausted") return NextResponse.json({ error: { code: "invalid_action", message: "That action is not available" } }, { status: 422, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(await retryExhaustedImapNotifications(session.user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
