import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { requestDocumentDeletion } from "@/server/document-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ documentId: string }>;
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { documentId } = await context.params;
    const document = await requestDocumentDeletion(session.user.id, documentId);
    return NextResponse.json({ document }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
