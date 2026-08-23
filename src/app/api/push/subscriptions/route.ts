import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import { AppError, appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

const subscriptionSchema = z.object({
  endpoint: z.url().max(2_048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

const removeSchema = z.object({ endpoint: z.url().max(2_048) });

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const subscription = subscriptionSchema.parse(await request.json());
    const [existing] = await getDb().select({ userId: pushSubscriptions.userId }).from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, subscription.endpoint)).limit(1);
    if (existing && existing.userId !== session.user.id) {
      throw new AppError("subscription_conflict", "That browser subscription belongs to another account", 409);
    }
    const values = {
      userId: session.user.id,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: request.headers.get("user-agent"),
      expiresAt: subscription.expirationTime ? new Date(subscription.expirationTime) : null,
      revokedAt: null,
    };
    await getDb().insert(pushSubscriptions).values({
      endpoint: subscription.endpoint,
      ...values,
    }).onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: values,
    });
    return NextResponse.json({ subscribed: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { endpoint } = removeSchema.parse(await request.json());
    await getDb().update(pushSubscriptions).set({ revokedAt: new Date() })
      .where(and(
        eq(pushSubscriptions.endpoint, endpoint),
        eq(pushSubscriptions.userId, session.user.id),
      ));
    return NextResponse.json({ subscribed: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
