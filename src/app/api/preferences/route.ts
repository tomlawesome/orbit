import { and, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { notificationDeliveries, userPreferences } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { themePreferenceSchema } from "@/lib/preferences";
import { assertOutsideMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

// The v19 theme pack (issue #325) already encodes light vs dark, so the
// legacy theme_mode column — still NOT NULL in the DB — is now derived
// rather than user-chosen. urgency_palette is likewise inert: status tokens
// are flat per pack, so there's nothing left for "classic" vs "themed" to
// select. Both columns are kept only for storage compatibility; neither is
// part of the client-facing ThemePreference.
const DARK_PACKS = new Set(["starchart", "afterdark"]);

export async function PUT(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const preference = themePreferenceSchema.parse(await request.json());
    const themeMode = DARK_PACKS.has(preference.theme) ? "dark" : "light";
    await getDb().transaction(async (transaction) => {
      await transaction.insert(userPreferences).values({
        userId: session.user.id,
        themeMode,
        themeId: preference.theme,
        textSize: preference.textSize,
        urgencyPalette: "themed",
        emailNotifications: preference.emailNotifications,
        pushNotifications: preference.pushNotifications,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          themeMode,
          themeId: preference.theme,
          textSize: preference.textSize,
          urgencyPalette: "themed",
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
          theme: saved.themeId,
          textSize: saved.textSize,
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
