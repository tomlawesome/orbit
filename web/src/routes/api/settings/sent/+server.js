import { json } from "@sveltejs/kit";

import { readSentNotifications } from "orbit/server/notification-history";

import { SENT_LATELY_FIXTURE } from "$lib/data/fixtures/settings.js";
import { read } from "$lib/server/api.js";

/**
 * The signed-in user's own "sent to you lately" (#1003): their last five
 * attempted `notification_deliveries`, newest first. The session is the only
 * input — no user id is accepted, so there is nothing to substitute and no
 * way to read another reader's deliveries.
 *
 * `no-store` for the same reason `/api/settings/reminders` is: a list that
 * just changed (a reminder fired, a retry landed) must never be served from
 * a cache.
 */
export const GET = read(
  async (_event, session) => {
    const sent = await readSentNotifications(session.user.id);
    return json({ sent }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json({ sent: SENT_LATELY_FIXTURE }, { headers: { "cache-control": "no-store" } }) },
);
