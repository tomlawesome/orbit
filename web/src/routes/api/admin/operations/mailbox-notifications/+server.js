import { json } from "@sveltejs/kit";

import { retryExhaustedImapNotifications } from "orbit/server/admin-operations";

import { write } from "$lib/server/api.js";

/**
 * Requeues mailbox-ingestion notification deliveries that exhausted their
 * retries (#735 port). `action` is a single fixed literal, not a schema,
 * because the Next route validated it with a plain equality check rather
 * than zod — kept as-is so an unparseable body degrades to the same
 * `invalid_action` 422 instead of a 400 from a parser.
 */
export const POST = write(async (event, session) => {
  const body = /** @type {{ action?: string }} */ (await event.request.json().catch(() => ({})));
  if (body.action !== "retry_exhausted") {
    return json(
      { error: { code: "invalid_action", message: "That action is not available" } },
      { status: 422, headers: { "cache-control": "no-store" } },
    );
  }
  const result = await retryExhaustedImapNotifications(session.user.id);
  return json(result, { headers: { "cache-control": "no-store" } });
});
