/**
 * WHETHER THE WALK HAS ANYTHING TO SHOW (#864).
 *
 * "The tour doesn't move to anything" turned out to be a reader with no
 * household at all: §11/#453's labelled sky — rendered whenever
 * `view.emptySky` is true, in both the desk and pocket dialects, as an
 * element carrying the `adrift` class (home/+page.svelte, pocket.svelte) —
 * has no dial, no sun-link, no manifest. The walk's first three stops all
 * target the dial (stops.js), so a reader on that sky got the card up
 * ("Stop 1 of 8") over a screen where nothing lit.
 *
 * #484 seeds demo data on first run specifically so the tour has something
 * to point at; a tour of a sky the reader does not have yet is the wrong
 * thing to offer someone whose next step is joining or creating a
 * household. So the walk is not offered at all until they have one — the
 * `adrift` mark, already drawn by the same read that decides the screen
 * (readHome's `emptySky`), is the one signal both dialects agree on, and
 * checking it here needs nothing beyond the DOM the tour already watches.
 *
 * A redesign of the walk itself is #866, the owner's to direct; this is only
 * the decision to offer it at all.
 *
 * @param {Document} doc
 * @returns {boolean} true when there is a household to walk through
 */
export function tourHasSomethingToShow(doc) {
  return !doc.querySelector(".adrift");
}
