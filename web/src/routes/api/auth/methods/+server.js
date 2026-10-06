import { json } from "@sveltejs/kit";

import { listMethods } from "orbit/server/local-credentials";

import { read } from "$lib/server/api.js";

/**
 * The caller's own sign-in methods (ADR-0023 §6).
 *
 * A session and nothing else: this reads the caller's row, never a user id
 * from the path or the query, so there is no way to ask it about somebody
 * else. It is what the settings "Sign-in methods" block renders — a password
 * with the date it last changed, and each linked provider with its issuer and
 * dates. The provider's opaque subject is not in the answer; it says nothing
 * a reader can use and everything a scraper would want.
 */
export const GET = read(async (event, session) => {
  const methods = await listMethods(session.user.id);
  return json(methods, { headers: { "cache-control": "no-store" } });
});
