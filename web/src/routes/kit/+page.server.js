import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

/*
 * The pocket kit's parts on one page (#1120, proposal §3 item 1), for the
 * fidelity harness and review screenshots only. It exists solely on a
 * fixtures instance: anywhere else it is not found, so no real instance has
 * a page nobody navigates to.
 */
export function load() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return {};
}
