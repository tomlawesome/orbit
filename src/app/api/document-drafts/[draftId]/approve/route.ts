import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { approveDocumentDraft } from "@/server/document-drafts";
export const dynamic = "force-dynamic";
const reviewedValue = (maximum: number) => z.union([z.string().trim().min(1).max(maximum), z.null()]);
const bodySchema = z.object({
  sectionId: z.uuid(),
  title: z.string().trim().min(1).max(100),
  provider: reviewedValue(100),
  reference: reviewedValue(80),
  mode: z.enum(["create", "merge", "attach"]).default("create"),
  targetItemId: z.uuid().optional(),
}).strict();
interface RouteContext { params: Promise<{ draftId: string }> }
export async function POST(request: NextRequest, context: RouteContext) { try { const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config); const { draftId } = await context.params; const body = bodySchema.parse(await request.json()); return NextResponse.json(await approveDocumentDraft(session.user.id, draftId, body.sectionId, { title: body.title, provider: body.provider, reference: body.reference }, body.mode, body.targetItemId), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return appErrorResponse(error); } }
