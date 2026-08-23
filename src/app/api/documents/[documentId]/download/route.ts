import { NextRequest } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { requireSession } from "@/lib/auth/session";
import { readDocumentDownload } from "@/server/document-repository";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ documentId: string }>;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    const { documentId } = await context.params;
    const document = await readDocumentDownload(session.user.id, documentId);
    const responseBody = Uint8Array.from(document.bytes);
    document.bytes.fill(0);
    return new Response(responseBody, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(document.displayName),
        "Content-Length": String(document.bytes.length),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return appErrorResponse(error);
  }
}
