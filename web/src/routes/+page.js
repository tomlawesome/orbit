import { redirect } from "@sveltejs/kit";

/**
 * Orbit's front door (#429).
 *
 * Home lives at /home: the fidelity gate, the account panel and the 404's own
 * links all address it, and moving the route would churn all three for no
 * user-visible gain. So the root redirects rather than being rehomed.
 *
 * 308 rather than 307: the mapping is permanent and the method is always GET,
 * so it is cacheable.
 *
 * Deliberately not session-aware. Signing out should land on the sign-in, but
 * auth is not wired into this front end yet, and redirecting by session state
 * now would be half-building it against a session this app cannot read.
 */
export function load() {
  redirect(308, "/home");
}
