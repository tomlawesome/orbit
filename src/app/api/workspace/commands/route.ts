import { NextRequest, NextResponse } from "next/server";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { workspaceCommandSchema } from "@/lib/workspace";
import { assertOutsideMaintenance } from "@/server/maintenance";
import { applyWorkspaceCommand } from "@/server/workspace-repository";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
    const command = workspaceCommandSchema.parse(await request.json());
    const workspace = await applyWorkspaceCommand(session.user.id, session.id, command);
    return NextResponse.json(
      { workspace },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
