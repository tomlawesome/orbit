import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { getAuthConfig } from "@/lib/env";
import { transferPrimaryAdministrator } from "@/server/admin-repository";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

const transferSchema = z.object({
  targetUserId: z.uuid(),
});

/** Transfers primary administrator authority (#263). */
export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
    const { targetUserId } = transferSchema.parse(await request.json());
    const result = await transferPrimaryAdministrator(session.user.id, session.id, targetUserId);
    return NextResponse.json(
      { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
