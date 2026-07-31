import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { createDocumentDraft } from "@/server/document-drafts";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
interface RouteContext { params: Promise<{ documentId: string }> }
export async function POST(request: NextRequest, context: RouteContext) { try { const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config); const { documentId } = await context.params; return NextResponse.json({ draft: await createDocumentDraft(session.user.id, documentId) }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return appErrorResponse(error); } }
