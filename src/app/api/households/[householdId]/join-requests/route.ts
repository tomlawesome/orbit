import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { createJoinRequest } from "@/server/join-requests";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ householdId: string }> };
const householdIdSchema = z.uuid();

/** §11 (#453): "Request to join X system?" — idempotent; the label the caller
 * clicked is the entire surface, and the entire response. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const householdId = householdIdSchema.parse((await context.params).householdId);
    const joinRequest = await createJoinRequest(session.user.id, householdId);
    return NextResponse.json({ request: joinRequest }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
