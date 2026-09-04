import { json } from "@sveltejs/kit";

import { verifyImapIngestionProvider } from "orbit/server/admin-operations";

import { write } from "$lib/server/api.js";

/**
 * Runs a live IMAP connectivity check against the configured mailbox
 * ingestion provider (#735 port). No request body: the provider settings
 * come from the engine's own configuration, not the caller.
 */
export const POST = write(async (_event, session) => {
  const result = await verifyImapIngestionProvider(session.user.id);
  return json(result, { headers: { "cache-control": "no-store" } });
});
