import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { getAuthConfig } from "@/lib/env";
import { decideJoinRequest } from "@/server/join-requests";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ requestId: string }> };
const decisionSchema = z.object({ action: z.enum(["approve", "decline"]) });
const requestIdSchema = z.uuid();

/** The decision (§11, #453): owners of that household and instance admins
 * only, enforced in the transaction that reads the request. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
    const requestId = requestIdSchema.parse((await context.params).requestId);
    const { action } = decisionSchema.parse(await request.json());
    const decided = await decideJoinRequest(session.user.id, requestId, action);
    return NextResponse.json({ request: decided }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
