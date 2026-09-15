import { redirect } from "@sveltejs/kit";

/**
 * Due-next retired under §14 (#1012): the corridor on /home is the manifest
 * now. This redirect exists so anything already pointing at /due-next still
 * arrives.
 */
export function load() {
  redirect(308, "/home");
}
