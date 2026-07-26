import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { activateImapReviewItem, assignImapReceiptHousehold, discardImapReviewItem } from "@/server/imap-inbox";

export const dynamic = "force-dynamic";
const bodySchema = z.object({ householdId: z.uuid() });
const reviewSchema = z.object({ sectionId: z.uuid() });
interface RouteContext { params: Promise<{ receiptId: string }> }

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config);
    const { receiptId } = await context.params; const { householdId } = bodySchema.parse(await request.json());
    await assignImapReceiptHousehold(session.user.id, receiptId, householdId);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config);
    const { receiptId } = await context.params; const { sectionId } = reviewSchema.parse(await request.json());
    return NextResponse.json(await activateImapReviewItem(session.user.id, receiptId, sectionId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return appErrorResponse(error); }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try { const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config); const { receiptId } = await context.params; await discardImapReviewItem(session.user.id, receiptId); return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return appErrorResponse(error); }
}
