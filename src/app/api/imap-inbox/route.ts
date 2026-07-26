import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { requireSession } from "@/lib/auth/session";
import { listImapInbox } from "@/server/imap-inbox";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request, getAuthConfig());
    return NextResponse.json(await listImapInbox(session.user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}
