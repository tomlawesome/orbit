import { json } from "@sveltejs/kit";

import { reminderPreferenceSchema } from "orbit/lib/preferences";
import { readReminderSettings, writeReminderSettings } from "orbit/server/reminder-settings";

import { REMINDERS_FIXTURE } from "$lib/data/fixtures/settings.js";
import { read, write } from "$lib/server/api.js";

/**
 * The signed-in user's own reminder timing (#468): email reminders on or off,
 * the first and final warning offsets, and the instance's outbound-mail state
 * in bounded words.
 *
 * The session is the only input on both verbs — no user id is accepted, so
 * there is nothing to substitute and no way to read or rewrite another
 * reader's timing. `no-store` because a preference the user just changed must
 * never be served from a cache, and the write carries a CSRF token because it
 * changes state (the `/api/preferences` precedent).
 */
export const GET = read(
  async (_event, session) => {
    const reminders = await readReminderSettings(session.user.id);
    return json({ reminders }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json(REMINDERS_FIXTURE, { headers: { "cache-control": "no-store" } }) },
);

/* No fixture branch: the gate reads this screen, it never saves it. A proxy
   that pretended to write would make the gate agree with a state nothing is
   holding. */
export const PUT = write(async (event, session) => {
  const preference = reminderPreferenceSchema.parse(await event.request.json());
  const reminders = await writeReminderSettings(session.user.id, preference);
  return json({ reminders }, { headers: { "cache-control": "no-store" } });
});
