import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { hardDeleteHousehold, requestHouseholdDeletion, restoreHousehold } from "@/server/household-lifecycle";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), confirmation: z.string().min(1).max(60) }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("hard_delete"), confirmation: z.string().min(1).max(60) }),
]);
interface RouteContext { params: Promise<{ householdId: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { householdId } = await context.params;
    const body = bodySchema.parse(await request.json());
    if (body.action === "delete") return NextResponse.json(await requestHouseholdDeletion(session.user.id, householdId, body.confirmation), { headers: { "Cache-Control": "no-store" } });
    if (body.action === "hard_delete") { await hardDeleteHousehold(session.user.id, householdId, body.confirmation); return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } }); }
    await restoreHousehold(session.user.id, householdId, session.id);
    return NextResponse.json({ restored: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}
