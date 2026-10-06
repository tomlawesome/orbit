import { json } from "@sveltejs/kit";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { unlinkIdentity } from "orbit/server/local-credentials";

import { write } from "$lib/server/api.js";

/**
 * Removes one linked provider identity (ADR-0023 §6).
 *
 * The identity id comes off the path, but it is only ever matched against the
 * caller's own rows: somebody else's id is not found rather than refused, so
 * the answer cannot be used to discover which identities exist.
 *
 * `unlinkIdentity` refuses with `link_last_method` unless a password, or
 * another identity while the provider is switched on, survives it.
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
  const identityId = /** @type {string} */ (event.params.identityId);
  const result = await unlinkIdentity(session.user.id, identityId, recentAuthentication);
  return json(result, { headers: { "cache-control": "no-store" } });
});
