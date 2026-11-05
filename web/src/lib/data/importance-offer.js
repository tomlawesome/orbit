/**
 * The one-time importance pass (#1463, round 7 U): when home shows the quiet
 * "N items have no importance yet" pill, and which items the pass lists.
 * Items from before the field arrived have no importance; the pass is how
 * they get one. "Not now" is saved on the server per user and never lifts.
 */

/**
 * @typedef {object} OfferItem
 * @property {string} id
 * @property {?string} [importance]
 * @property {?string} [dueDate]
 * @property {string} [status]
 */

/** @param {OfferItem} item */
const unsetActive = (item) => item.status === "active" && !item.importance;

/**
 * @template {OfferItem} T
 * @param {T[]} items
 * @param {{ dismissed: boolean }} state
 * @returns {{ show: boolean, count: number }}
 */
export function importanceOfferOf(items, { dismissed }) {
  const count = items.filter(unsetActive).length;
  return { show: count > 0 && !dismissed, count };
}

/**
 * The active unset items, nearest due first, an undated one last. The same
 * objects, in a new array.
 * @template {OfferItem} T
 * @param {T[]} items
 * @returns {T[]}
 */
export function passRowsOf(items) {
  return items.filter(unsetActive).sort((a, b) => {
    if (!a.dueDate || !b.dueDate) return a.dueDate ? -1 : b.dueDate ? 1 : 0;
    return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
  });
}
