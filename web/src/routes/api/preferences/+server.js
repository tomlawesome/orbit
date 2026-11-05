import { json } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "orbit/db";
import { notificationDeliveries, userPreferences } from "orbit/db/schema";
import { themePreferenceSchema } from "orbit/lib/preferences";

import { write } from "$lib/server/api.js";
import { keepImportanceOfferDismissed, keepLabelDays, keepPlanetSize, keepSkyDriver } from "$lib/server/fixture-scenes.js";

/** Theme, text size, planet-name days, sky driver, planet size, the importance offer and notification-channel preferences (#735 port). */
export const PUT = write(async (event, session) => {
  const preference = themePreferenceSchema.parse(await event.request.json());
  await getDb().transaction(async (transaction) => {
    await transaction.insert(userPreferences).values({
      userId: session.user.id,
      themeId: preference.theme,
      textSize: preference.textSize,
      emailNotifications: preference.emailNotifications,
      pushNotifications: preference.pushNotifications,
      labelDays: preference.labelDays,
      skyDriver: preference.skyDriver,
      planetSize: preference.planetSize,
      importanceOfferDismissed: preference.importanceOfferDismissed,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        themeId: preference.theme,
        textSize: preference.textSize,
        emailNotifications: preference.emailNotifications,
        pushNotifications: preference.pushNotifications,
        labelDays: preference.labelDays,
        skyDriver: preference.skyDriver,
        planetSize: preference.planetSize,
        importanceOfferDismissed: preference.importanceOfferDismissed,
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
        labelDays: saved.labelDays,
        skyDriver: saved.skyDriver,
        planetSize: saved.planetSize,
        importanceOfferDismissed: saved.importanceOfferDismissed,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}, {
  /* The fixture harness has no database: the same parse, the same 422 for bad
     input, and the planet-name days kept for a browser that asked for
     keep-saves (fixture-scenes.js). Nothing is stored for any other. */
  fixture: async (event) => {
    const preference = themePreferenceSchema.parse(await event.request.json());
    keepLabelDays(event.cookies, preference.labelDays);
    keepSkyDriver(event.cookies, preference.skyDriver);
    keepPlanetSize(event.cookies, preference.planetSize);
    keepImportanceOfferDismissed(event.cookies, preference.importanceOfferDismissed);
    return json(
      { preference: { theme: preference.theme, textSize: preference.textSize, emailNotifications: preference.emailNotifications, pushNotifications: preference.pushNotifications, labelDays: preference.labelDays, skyDriver: preference.skyDriver, planetSize: preference.planetSize, importanceOfferDismissed: preference.importanceOfferDismissed } },
      { headers: { "cache-control": "no-store" } },
    );
  },
});
