import { redirect } from "@sveltejs/kit";

/**
 * The belt retired (#1319, owner-decisions §34): home's item drawer holds
 * everything an item has, on desk and phone. `/item/<id>` is mothballed, so
 * every link already out there -- reminders, copied links, the inbox's filed
 * lane, a bookmark -- lands in that item's drawer on home instead, and bare
 * `/item` lands on home. On the server, so the address is rewritten before any
 * page loads; signing in still comes first (hooks.server.js keeps the original
 * address as `returnTo`, and this answers it afterwards).
 *
 * 308, as the other retired screens use (`/documents`, `/due-next`): the
 * belt is not coming back at this address.
 */
export function load({ params }) {
  if (!params.id) redirect(308, "/home");
  redirect(308, `/home?item=${encodeURIComponent(params.id)}`);
}
