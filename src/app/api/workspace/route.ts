import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { assertOutsideMaintenance } from "@/server/maintenance";
import { readWorkspace } from "@/server/workspace-repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const session = await requireSession(nextCookies(request), getAuthConfig());
    const workspace = await readWorkspace(session.user.id, session.id, session.activeHouseholdId);
    return NextResponse.json(
      { workspace },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
