import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { requireSession } from "@/lib/auth/session";
import { readWorkspace } from "@/server/workspace-repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request, getAuthConfig());
    const workspace = await readWorkspace(session.user.id, session.id, session.activeHouseholdId);
    return NextResponse.json(
      { workspace },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
