import { NextRequest, NextResponse } from "next/server";
import { AppError, appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { inspectItemDocument } from "@/server/item-document-inspection";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext { params: Promise<{ householdId: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
    const { householdId } = await context.params;
    const encodedFilename = request.headers.get("x-orbit-filename");
    if (!encodedFilename) throw new AppError("document_filename_required", "The document filename is required", 422);
    let filename: string;
    try { filename = decodeURIComponent(encodedFilename); } catch { throw new AppError("document_filename_invalid", "The document filename is invalid", 422); }
    const declaredHeader = request.headers.get("x-orbit-declared-bytes");
    const declaredBytes = declaredHeader ? Number(declaredHeader) : undefined;
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) throw new AppError("document_size_invalid", "The document size is invalid", 422);
    return NextResponse.json(await inspectItemDocument({ userId: session.user.id, householdId, filename, body: request.body, declaredBytes }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}
