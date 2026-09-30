import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

/*
 * The stumble's fidelity gate (#1139), fixtures-only like /kit itself: a
 * deliberate, unhandled load failure, so the gate goes through SvelteKit's
 * real unexpected-error path (default handleError, message "Internal
 * Error") and photographs the page a reader actually gets. On a real
 * instance the route is not found, so no real instance has a page nobody
 * navigates to.
 */
export function load() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  throw new Error("a deliberate server failure for the fidelity gate (#1139)");
}
