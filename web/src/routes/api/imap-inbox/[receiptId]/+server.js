import { json } from "@sveltejs/kit";
import { z } from "zod";

import { assignImapReceiptHousehold, discardImapReviewItem, getImapReview } from "orbit/server/imap-inbox";

import { read, write } from "$lib/server/api.js";

const bodySchema = z.object({ householdId: z.uuid() });
const querySchema = z.object({ householdId: z.uuid() });

export const GET = read(async (event, session) => {
  const receiptId = /** @type {string} */ (event.params.receiptId);
  const { householdId } = querySchema.parse({ householdId: event.url.searchParams.get("householdId") });
  return json(await getImapReview(session.user.id, receiptId, householdId), { headers: { "cache-control": "no-store" } });
});

export const PUT = write(async (event, session) => {
  const receiptId = /** @type {string} */ (event.params.receiptId);
  const { householdId } = bodySchema.parse(await event.request.json());
  await assignImapReceiptHousehold(session.user.id, receiptId, householdId);
  return json({ ok: true }, { headers: { "cache-control": "no-store" } });
});

export const DELETE = write(async (event, session) => {
  const receiptId = /** @type {string} */ (event.params.receiptId);
  await discardImapReviewItem(session.user.id, receiptId);
  return json({ ok: true }, { headers: { "cache-control": "no-store" } });
});
