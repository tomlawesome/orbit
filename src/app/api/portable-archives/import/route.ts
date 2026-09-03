import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { importPortableArchive } from "@/server/portable-archive-repository";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";
const bodySchema = z.object({ householdId: z.uuid(), archive: z.unknown(), passphrase: z.string().min(12).max(256), conflictItemIds: z.array(z.uuid()).max(10_000) });
export async function POST(request: NextRequest) { try { await assertOutsideMaintenance(nextCookies(request)); const config = getAuthConfig(); const session = await requireSession(nextCookies(request), config); assertCsrf(request.headers, session, config); const body = bodySchema.parse(await request.json()); return NextResponse.json(await importPortableArchive({ userId: session.user.id, ...body }), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return appErrorResponse(error); } }
