import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { updateNotificationDelivery } from "@/server/admin-operations";
import { assertOutsideMaintenance } from "@/server/maintenance";

const actionSchema = z.object({
  action: z.enum(["retry", "discard"]),
  expectedStatus: z.enum(["pending", "processing", "sent", "retry", "failed", "cancelled"]),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ deliveryId: string }> },
) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { deliveryId } = await context.params;
    const input = actionSchema.parse(await request.json());
    await updateNotificationDelivery(session.user.id, deliveryId, input.action, input.expectedStatus);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
