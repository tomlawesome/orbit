import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { getAuthConfig } from "@/lib/env";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { approveReviewedIntake } from "@/server/reviewed-intake";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const result = await approveReviewedIntake(session.user.id, await request.json());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
