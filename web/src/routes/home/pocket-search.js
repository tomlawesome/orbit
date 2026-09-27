/**
 * THE POCKET'S SEARCH (#1057's phone half, proposal §2.4; ratified as
 * design/v19/phone-search/round-1 B, owner 2026-09-19). Pure, so the sheet
 * and the unit tests share it: what the sheet lists for a query.
 *
 *   before typing  the two nearest items that need attention, then
 *                  "→ add an item"
 *   typing         matching items (title, section, provider), then matching
 *                  documents (◆), then one accent action for the top item:
 *                  "→ complete …", which arms before it fires
 *   no match       nothing in your orbit is called "x", and add "x" as an item
 *
 * Items come in the manifest's own row shape (chart.js manifestGroupsOf), so
 * the order is the manifest's: soonest first.
 *
 * @typedef {{ id: string, title: string, section?: string | null, provider?: string | null,
 *   days: number | null }} SearchItem
 * @typedef {{ id: string, name: string, itemId: string, itemTitle: string, meta?: string }} SearchDocument
 */

/** @param {string} text */
const fold = (text) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * @template {SearchItem} T
 * @template {SearchDocument} D
 * @param {string} query
 * @param {{ items: T[], attention: T[], documents?: D[] }} world
 * @returns {{ query: string, items: T[], documents: D[], complete: T | null, nothing: boolean }}
 */
export function searchPocket(query, { items, attention, documents = [] }) {
  const q = fold(query);
  if (!q) {
    return { query: "", items: attention.slice(0, 2), documents: [], complete: null, nothing: false };
  }
  const hit = (/** @type {string | null | undefined} */ text) => Boolean(text) && fold(/** @type {string} */ (text)).includes(q);
  /* A title that starts with the query outranks one that merely contains it;
     the manifest's own order (soonest first) breaks ties. */
  const starts = (/** @type {T} */ item) => (fold(item.title).startsWith(q) ? 0 : 1);
  const matched = items
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => hit(item.title) || hit(item.section) || hit(item.provider))
    .sort((a, b) => starts(a.item) - starts(b.item) || a.order - b.order)
    .map(({ item }) => item);
  const papers = documents.filter((doc) => hit(doc.name));
  return {
    query: query.trim(),
    items: matched,
    documents: papers,
    /* Only the top match, and only when it has a date to complete against. */
    complete: matched[0] && matched[0].days !== null ? matched[0] : null,
    nothing: matched.length === 0 && papers.length === 0,
  };
}
