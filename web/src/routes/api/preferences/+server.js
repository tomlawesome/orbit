import { json } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "orbit/db";
import { notificationDeliveries, userPreferences } from "orbit/db/schema";
import { themePreferenceSchema } from "orbit/lib/preferences";

import { write } from "$lib/server/api.js";

// The v19 theme pack (issue #325) already encodes light vs dark, so the
// legacy theme_mode column — still NOT NULL in the DB — is now derived
// rather than user-chosen. urgency_palette is likewise inert: status tokens
// are flat per pack, so there's nothing left for "classic" vs "themed" to
// select. Both columns are kept only for storage compatibility; neither is
// part of the client-facing ThemePreference.
const DARK_PACKS = new Set(["starchart", "afterdark"]);

/** Theme, text size and notification-channel preferences (#735 port). */
export const PUT = write(async (event, session) => {
  const preference = themePreferenceSchema.parse(await event.request.json());
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

    /** @type {Array<"email" | "web_push">} */
    const disabledChannels = [];
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
  return json(
    {
      preference: {
        theme: saved.themeId,
        textSize: saved.textSize,
        emailNotifications: saved.emailNotifications,
        pushNotifications: saved.pushNotifications,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
});
