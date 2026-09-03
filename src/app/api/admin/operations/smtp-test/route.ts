import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { getAuthConfig } from "@/lib/env";
import { verifySmtpProvider } from "@/server/admin-operations";
import { assertOutsideMaintenance } from "@/server/maintenance";

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
    return NextResponse.json(
      await verifySmtpProvider(session.user.id),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
