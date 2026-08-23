import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { createPortableArchive } from "@/server/portable-archive-repository";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requestSchema = z.object({
  passphrase: z.string().min(12).max(256),
  includeDocuments: z.boolean().default(false),
});

interface RouteContext { params: Promise<{ householdId: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { householdId } = await context.params;
    const input = requestSchema.parse(await request.json());
    const archive = await createPortableArchive({ userId: session.user.id, householdId, ...input });
    return NextResponse.json({ archive: { ...archive, downloadUrl: `/api/portable-archives/${archive.id}/download` } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
