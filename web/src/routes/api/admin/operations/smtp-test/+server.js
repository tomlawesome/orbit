import { json } from "@sveltejs/kit";

import { verifySmtpProvider } from "orbit/server/admin-operations";

import { write } from "$lib/server/api.js";

/**
 * Runs a live send-path check against the configured SMTP provider (#735
 * port). No request body: the provider settings come from the engine's own
 * configuration, not the caller.
 */
export const POST = write(async (_event, session) => {
  const result = await verifySmtpProvider(session.user.id);
  return json(result, { headers: { "cache-control": "no-store" } });
});
