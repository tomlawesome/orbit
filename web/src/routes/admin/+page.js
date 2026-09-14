import { redirect } from "@sveltejs/kit";

/**
 * /admin was the fixture-backed duplicate of /administration (#1013); this
 * redirect exists so anything already pointing at /admin still arrives.
 */
export function load() {
  redirect(308, "/administration");
}
