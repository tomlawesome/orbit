import { NextRequest } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { requireSession } from "@/lib/auth/session";
import { readPortableArchive } from "@/server/portable-archive-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext { params: Promise<{ archiveId: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireSession(request, getAuthConfig());
    const { archiveId } = await context.params;
    const archive = await readPortableArchive(session.user.id, archiveId);
    const body = Uint8Array.from(archive.bytes);
    archive.bytes.fill(0);
    return new Response(body, { headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename=\"orbit-export-${archiveId}.json\"`,
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
