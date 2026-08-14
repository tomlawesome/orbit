import { error } from "@sveltejs/kit";
import { ITEMS_FIXTURE } from "./items.fixture.js";

/**
 * One item, at its own URL (#424).
 *
 * The lookup is a membership test against a set this front end already holds,
 * never a fetch built from the URL — so an id that is not in the set is a 404
 * rather than a request. When the workspace API is wired the set becomes the
 * signed-in user's own items and that property has to survive: the id may only
 * ever select from what the session may already see, never widen it.
 */
export function load({ params }) {
  const item = Object.hasOwn(ITEMS_FIXTURE, params.id) ? ITEMS_FIXTURE[params.id] : null;
  if (!item) error(404, "No such item");
  return { item };
}
