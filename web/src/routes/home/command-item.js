/**
 * THE ITEM A DRAWER COMMAND ADDRESSES, ON THE DESK (#1582). The desk holds
 * one open drawer's record; a command for `id` gets it only when it is that
 * same item and a filed one (a suggestion is commanded through its receipt's
 * own acts). Any other id answers null, so an act that lands after the
 * drawer has moved on sends nothing for the wrong item. A plain function, so
 * the id check is a behaviour test, not a regex on the screen's source.
 * @param {import('$lib/data/workspace.js').ItemView | null} detail
 * @param {string | null | undefined} [id]  the open item when not given
 * @returns {any}
 */
export function commandItemOf(detail, id = detail?.id) {
  return detail?.householdId && !detail.suggestion && detail.id === id ? detail : null;
}
