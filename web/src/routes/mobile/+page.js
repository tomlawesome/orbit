import { redirect } from "@sveltejs/kit";

/**
 * The pocket dialect moved onto home's own URL (CON-10, #430): it is a dialect
 * of home, not a second design, and separate phone URLs age badly. This
 * redirect exists so anything already pointing at /mobile still arrives.
 */
export function load() {
  redirect(308, "/home");
}
