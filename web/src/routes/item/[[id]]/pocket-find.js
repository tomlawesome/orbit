/**
 * THE BELT'S FIND SHEET (#1072, proposal §2.3 and §2.4): what the search
 * sheet over the belt lists for a query. Pure, so the sheet and the unit
 * tests share it. Home's sheet (routes/home/pocket-search.js) reads the
 * manifest; this one reads the belt's own seats, because a result here
 * approaches a seat directly.
 *
 *   before typing  the two soonest items on the belt
 *   typing         matching items (title, section, kind, provider), then
 *                  matching documents (◆) — every paper, including those
 *                  packed in the pocket's clump, which have no seat
 *   no match       `nothing`, and the sheet says so
 *
 * @typedef {import("./band.js").Body} Body
 * @typedef {import("./band.js").BeltDoc} BeltDoc
 * @typedef {{ index: number, body: Body }} ItemHit
 * @typedef {{ doc: BeltDoc, itemIdx: number, itemTitle: string }} PaperHit
 */

/** @param {string | null | undefined} text */
const fold = (text) => (text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * @param {string} query
 * @param {Body[]} bodies  the belt's seats, in date order
 * @returns {{ query: string, items: ItemHit[], documents: PaperHit[], nothing: boolean }}
 */
export function searchBelt(query, bodies) {
  const q = fold(query);
  /** @type {ItemHit[]} */
  const items = [];
  bodies.forEach((body, index) => { if (body.kind === "item") items.push({ index, body }); });
  if (!q) return { query: "", items: items.slice(0, 2), documents: [], nothing: false };

  const hit = (/** @type {string | null | undefined} */ text) => fold(text).includes(q);
  /* A title that starts with the query outranks one that merely contains it;
     the belt's own order (soonest first) breaks ties — home's rule. */
  const starts = (/** @type {ItemHit} */ one) => (fold(one.body.label).startsWith(q) ? 0 : 1);
  const matched = items
    .filter(({ body }) => body.kind === "item"
      && (hit(body.label) || hit(body.item.section) || hit(body.item.kind) || hit(body.item.provider)))
    .map((one, order) => ({ one, order }))
    .sort((a, b) => starts(a.one) - starts(b.one) || a.order - b.order)
    .map(({ one }) => one);
  /** @type {PaperHit[]} */
  const documents = [];
  for (const { body } of items) {
    if (body.kind !== "item") continue;
    for (const doc of body.docs) {
      if (hit(doc.name)) documents.push({ doc, itemIdx: body.itemIdx, itemTitle: body.label });
    }
  }
  return { query: query.trim(), items: matched, documents, nothing: !matched.length && !documents.length };
}
