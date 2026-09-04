import { json } from "@sveltejs/kit";
import { z } from "zod";

import { updateNotificationDelivery } from "orbit/server/admin-operations";

import { write } from "$lib/server/api.js";

const actionSchema = z.object({
  action: z.enum(["retry", "discard"]),
  expectedStatus: z.enum(["pending", "processing", "sent", "retry", "failed", "cancelled"]),
});

/**
 * Retries or discards one notification delivery, guarded by the status the
 * caller last saw (#735 port). `expectedStatus` is a compare-and-swap: the
 * engine rejects the change with a 409 if the delivery moved underneath the
 * admin between page load and click, rather than acting on stale state.
 */
export const POST = write(async (event, session) => {
  const deliveryId = /** @type {string} */ (event.params.deliveryId);
  const input = actionSchema.parse(await event.request.json());
  await updateNotificationDelivery(session.user.id, deliveryId, input.action, input.expectedStatus);
  return json({ ok: true }, { headers: { "cache-control": "no-store" } });
});
