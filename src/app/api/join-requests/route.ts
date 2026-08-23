import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { requireSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { listJoinRequests } from "@/server/join-requests";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

/** Pending join requests the caller may decide: their owned households, or
 * everything for an instance admin (§11, #453). */
export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    const requests = await listJoinRequests(session.user.id);
    return NextResponse.json({ requests }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
