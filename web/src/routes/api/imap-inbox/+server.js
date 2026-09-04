import { json } from "@sveltejs/kit";

import { listImapInbox } from "orbit/server/imap-inbox";

import { INBOX_FIXTURE } from "$lib/data/fixtures/inbox.js";
import { read } from "$lib/server/api.js";

/**
 * The mail-in review queue (#434/#463; #735 port).
 *
 * Fixture carries the #452 mockups' own mail: home's suggestion row, its
 * dial ring and the whole inbox screen all derive from these receipts, so
 * the two screens share one truth (#454).
 */
export const GET = read(
  async (_event, session) => json(await listImapInbox(session.user.id), { headers: { "cache-control": "no-store" } }),
  { fixture: () => json(INBOX_FIXTURE, { headers: { "cache-control": "no-store" } }) },
);
