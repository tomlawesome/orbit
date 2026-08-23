import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { requireSession } from "@/lib/auth/session";
import { listImapInbox } from "@/server/imap-inbox";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    return NextResponse.json(await listImapInbox(session.user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}
