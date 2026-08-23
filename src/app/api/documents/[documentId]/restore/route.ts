import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { restoreDocument } from "@/server/document-repository";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ documentId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { documentId } = await context.params;
    const document = await restoreDocument(session.user.id, documentId);
    return NextResponse.json({ document }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
