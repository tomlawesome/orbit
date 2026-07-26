import { and, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { notificationDeliveries, userPreferences } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { themePreferenceSchema } from "@/lib/preferences";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const preference = themePreferenceSchema.parse(await request.json());
    await getDb().transaction(async (transaction) => {
      await transaction.insert(userPreferences).values({
        userId: session.user.id,
        themeMode: preference.mode,
        themeId: preference.colourway,
        textSize: preference.textSize,
        urgencyPalette: preference.urgencyPalette,
        emailNotifications: preference.emailNotifications,
        pushNotifications: preference.pushNotifications,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          themeMode: preference.mode,
          themeId: preference.colourway,
          textSize: preference.textSize,
          urgencyPalette: preference.urgencyPalette,
          emailNotifications: preference.emailNotifications,
          pushNotifications: preference.pushNotifications,
          updatedAt: new Date(),
        },
      });

      const disabledChannels: Array<"email" | "web_push"> = [];
      if (!preference.emailNotifications) disabledChannels.push("email");
      if (!preference.pushNotifications) disabledChannels.push("web_push");
      if (disabledChannels.length) {
        await transaction.update(notificationDeliveries).set({
          status: "cancelled",
          lockedAt: null,
          lastError: "Disabled in recipient preferences",
          updatedAt: new Date(),
        }).where(and(
          eq(notificationDeliveries.userId, session.user.id),
          inArray(notificationDeliveries.channel, disabledChannels),
          inArray(notificationDeliveries.status, ["pending", "retry"]),
        ));
      }
    });
    const [saved] = await getDb().select().from(userPreferences)
      .where(eq(userPreferences.userId, session.user.id)).limit(1);
    return NextResponse.json(
      {
        preference: {
          mode: saved.themeMode,
          colourway: saved.themeId,
          textSize: saved.textSize,
          urgencyPalette: saved.urgencyPalette,
          emailNotifications: saved.emailNotifications,
          pushNotifications: saved.pushNotifications,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}
