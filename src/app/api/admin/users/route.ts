import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { listInstanceUsers, setInstanceAdministrator, setInstanceUserDisabled } from "@/server/admin-repository";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

const administratorUpdateSchema = z.object({
  userId: z.uuid(),
  administrator: z.boolean(),
});
const disabledUpdateSchema = z.object({
  userId: z.uuid(),
  disabled: z.boolean(),
});

export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    const result = await listInstanceUsers(session.user.id);
    return NextResponse.json(
      { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const update = administratorUpdateSchema.parse(await request.json());
    const result = await setInstanceAdministrator(
      session.user.id,
      update.userId,
      update.administrator,
    );
    return NextResponse.json(
      { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const update = disabledUpdateSchema.parse(await request.json());
    const result = await setInstanceUserDisabled(session.user.id, update.userId, update.disabled);
    return NextResponse.json(
      { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
