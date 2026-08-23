import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { assignImapReceiptHousehold, discardImapReviewItem, getImapReview } from "@/server/imap-inbox";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
const bodySchema = z.object({ householdId: z.uuid() });
const querySchema = z.object({ householdId: z.uuid() });
interface RouteContext { params: Promise<{ receiptId: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    const { receiptId } = await context.params;
    const { householdId } = querySchema.parse({ householdId: new URL(request.url).searchParams.get("householdId") });
    return NextResponse.json(await getImapReview(session.user.id, receiptId, householdId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config);
    const { receiptId } = await context.params; const { householdId } = bodySchema.parse(await request.json());
    await assignImapReceiptHousehold(session.user.id, receiptId, householdId);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try { await assertOutsideMaintenance(request); const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config); const { receiptId } = await context.params; await discardImapReviewItem(session.user.id, receiptId); return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return appErrorResponse(error); }
}
