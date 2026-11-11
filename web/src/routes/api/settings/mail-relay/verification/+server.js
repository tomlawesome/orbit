import { json } from "@sveltejs/kit";

import { requestSenderCheck } from "orbit/server/mail-in/sender-addresses";

import { write } from "$lib/server/api.js";

/**
 * Sends the check email for one of the member's own sending addresses
 * (ADR-0017 decision 3, amended by decision 7c and for #1650).
 *
 * The body is optional. With none, the check goes to the member's seeded
 * sign-in row, as it always has: seeding, reading and sending run as one step
 * under the member's lock, so the row is put in place when missing and
 * follows the registered address when that has changed. With `{ id }`, it
 * goes to that row of the member's own (never an address: a body naming an
 * address is ignored). An id that is not one of their rows is 404
 * `sender_address_unknown`. Once the row is checked there is nothing to
 * send: 409. The per-member limit counts across all their rows.
 *
 * Answers 202, since the mail is on its way and not yet read, with where it
 * went and when the link lapses. `no-store`: an address is personal data.
 */
export const POST = write(async (event, session) => {
  const id = await requestedId(event.request);
  const { address, expiresAt } = await requestSenderCheck(session.user.id, {}, id);
  return json({ address, expiresAt: expiresAt.toISOString() }, { status: 202, headers: { "cache-control": "no-store" } });
});

/**
 * The row id the body names, or undefined for no body. A body that is not
 * JSON, or names no id, is the no-body request; an id that is not a string
 * is one no row has.
 *
 * @param {Request} request
 * @returns {Promise<string | undefined>}
 */
async function requestedId(request) {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return undefined;
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || !("id" in body) || body.id === undefined || body.id === null) return undefined;
    return typeof body.id === "string" ? body.id : "";
  } catch {
    return undefined;
  }
}
