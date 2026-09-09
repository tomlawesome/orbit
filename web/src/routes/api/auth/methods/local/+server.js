import { json } from "@sveltejs/kit";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { unlinkLocal } from "orbit/server/local-credentials";

import { write } from "$lib/server/api.js";

/**
 * Removes the caller's password (ADR-0023 §6).
 *
 * Session, CSRF and a fresh challenge, like every sensitive action — and the
 * challenge for somebody who has a password IS that password, so this route
 * asks for the very thing it is about to delete. `unlinkLocal` then refuses
 * with `link_last_method` unless a usable provider identity survives it.
 *
 * The body is optional and read leniently: a browser sending `DELETE` with no
 * body at all is answered by the guard as `recent_authentication_required`,
 * which is the same answer a wrong password gets.
 */
export const DELETE = write(async (event, session) => {
  /** @type {Record<string, unknown>} */
  let body = {};
  try {
    const parsed = await event.request.json();
    if (parsed && typeof parsed === "object") body = /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    // No body, or an unparseable one: the guard below refuses it either way.
  }

  const recentAuthentication = await requireRecentAuthentication(event, session, body, "unlink_method");
  const result = await unlinkLocal(session.user.id, recentAuthentication);
  return json(result, { headers: { "cache-control": "no-store" } });
});
