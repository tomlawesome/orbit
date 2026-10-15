import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

/*
 * The administration screen is the instance administrator's (#1440). Anyone
 * else is told it does not exist, the way /kit is, before anything renders:
 * the shell no longer offers the link, and a typed address gets the same
 * answer. The data behind it was never at risk (every instance-wide read
 * refuses a member with 403); this stops the empty mock-up being served.
 *
 * `isInstanceAdmin` is the root layout's fact: readSession re-reads it from
 * the users table each request and returns no session for a disabled account.
 * A fixtures instance has no session at all, so it passes, which keeps the
 * fidelity photographs of this screen working.
 */
export function load({ locals }) {
  if (env.ORBIT_FIXTURES === "1") return {};
  if (!locals.session?.user?.isInstanceAdmin) error(404, "Not found");
  return {};
}
