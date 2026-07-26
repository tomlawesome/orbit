import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { previewPortableArchive } from "@/server/portable-archive-repository";
export const dynamic = "force-dynamic";
const bodySchema = z.object({ archive: z.unknown(), passphrase: z.string().min(12).max(256) });
export async function POST(request: NextRequest) { try { const config = getAuthConfig(); const session = await requireSession(request, config); assertCsrf(request, session, config); const body = bodySchema.parse(await request.json()); return NextResponse.json({ preview: previewPortableArchive(body.archive, body.passphrase) }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return appErrorResponse(error); } }
