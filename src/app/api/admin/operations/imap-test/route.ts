import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { verifyImapIngestionProvider } from "@/server/admin-operations";

export async function POST(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    return NextResponse.json(await verifyImapIngestionProvider(session.user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
