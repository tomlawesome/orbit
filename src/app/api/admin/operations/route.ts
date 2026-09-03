import { NextRequest, NextResponse } from "next/server";
import { appErrorResponse } from "@/lib/app-error";
import { requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { getAuthConfig } from "@/lib/env";
import { getAdministratorOperations } from "@/server/admin-operations";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const session = await requireSession(nextCookies(request), getAuthConfig());
    return NextResponse.json(
      {
        operations: await getAdministratorOperations(
          session.user.id,
          request.nextUrl.searchParams.get("auditCursor") ?? undefined,
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
