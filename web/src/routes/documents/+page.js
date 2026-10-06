import { redirect } from "@sveltejs/kit";

/**
 * Documents retired under §14 (#1012): the belt on /home is the document
 * surface now. This redirect exists so anything already pointing at
 * /documents still arrives.
 */
export function load() {
  redirect(308, "/home");
}
