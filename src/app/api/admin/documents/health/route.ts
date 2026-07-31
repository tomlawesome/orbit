import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { requireSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { requireInstanceAdministrator } from "@/server/authorization";
import { getDocumentHealth, toPublicDocumentHealth } from "@/server/document-health";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request, getAuthConfig());
    await requireInstanceAdministrator(session.user.id);
    return NextResponse.json(
      { health: toPublicDocumentHealth(await getDocumentHealth()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
