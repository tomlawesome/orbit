import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse, AppError } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { listItemDocuments, uploadItemDocument } from "@/server/document-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ householdId: string; itemId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireSession(request, getAuthConfig());
    const { householdId, itemId } = await context.params;
    const itemDocuments = await listItemDocuments(session.user.id, householdId, itemId);
    return NextResponse.json({ documents: itemDocuments }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { householdId, itemId } = await context.params;
    const encodedFilename = request.headers.get("x-orbit-filename");
    if (!encodedFilename) throw new AppError("document_filename_required", "The document filename is required", 422);
    let filename: string;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw new AppError("document_filename_invalid", "The document filename is invalid", 422);
    }
    const contentLengthHeader = request.headers.get("content-length");
    const declaredBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
      throw new AppError("document_size_invalid", "The document size is invalid", 422);
    }
    const document = await uploadItemDocument({
      userId: session.user.id,
      householdId,
      itemId,
      filename,
      body: request.body,
      declaredBytes,
    });
    return NextResponse.json({ document }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return appErrorResponse(error);
  }
}
