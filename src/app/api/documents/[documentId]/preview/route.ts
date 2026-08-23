import { NextRequest } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { requireSession } from "@/lib/auth/session";
import { readDocumentPagePreview } from "@/server/document-preview";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ documentId: string }>;
}

/**
 * A page-one picture of a stored document, for visual identification (#476).
 *
 * The response carries the download endpoint's headers: private and
 * non-cacheable, sniff-proof, and served under a null CSP, because the bytes
 * are derived from private document content even though they are only an
 * image. Unsupported or unrenderable documents answer with a bounded code a
 * screen can word rather than a 500.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    const { documentId } = await context.params;
    const preview = await readDocumentPagePreview(session.user.id, documentId);
    const responseBody = Uint8Array.from(preview.bytes);
    preview.bytes.fill(0);
    return new Response(responseBody, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": "inline",
        "Content-Length": String(responseBody.length),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Type": preview.mediaType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return appErrorResponse(error);
  }
}
