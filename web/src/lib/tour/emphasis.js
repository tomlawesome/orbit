/**
 * HOW A STOP IS EMPHASISED, PER PACK (#752; owner ruling, 2026-09-03).
 *
 * Two modes, and which one a pack uses is not a preference — it follows from
 * what the pack's sky is made of:
 *
 *   "dim"     — star-chart, after dark, retrograde. Everything but the
 *               explained thing drops to the pack's own faint tier, by
 *               turning DOWN the opacity of the token colours already there.
 *               No colour is invented for the purpose.
 *
 *   "forward" — atlas, dawn, clouds. Nothing dims, because dimming a daylight
 *               sky just greys the whole page. The explained thing is pushed
 *               FORWARD by colour instead: quiet tokens step up to full ink,
 *               structural lines and borders take --accent, and it wears a
 *               soft accent halo. Still pack tokens, still no invented hex.
 *
 * The visual half of both modes lives in tour.css, keyed off [data-theme] as
 * design/v19/tour.html keys it — this module is the same rule said in the one
 * place the JAVASCRIPT needs it: on a "forward" pack the engine never marks
 * anything but the target, so nothing that is not being explained is touched
 * at all. tests/unit/v19-tour-emphasis.test.mjs pins the two halves together
 * so the list here and the selectors there cannot drift apart.
 *
 * packs.css holds exactly these six; a seventh would have to name its mode
 * here and add its override there, together.
 */

/** The packs whose skies are dark enough to dim. */
export const DIMMING_PACKS = ["starchart", "afterdark", "retrograde"];

/** The daylight packs, which push the target forward instead. */
export const FORWARD_PACKS = ["atlas", "dawn", "clouds"];

/**
 * @param {string | null | undefined} pack
 * @returns {"dim" | "forward"}
 */
export function emphasisModeOf(pack) {
  return FORWARD_PACKS.includes(String(pack)) ? "forward" : "dim";
}

/** The pack in force, read where every screen writes it (app.html, Chrome). */
export function packOf(/** @type {Document} */ doc) {
  return doc.documentElement.dataset.theme || "starchart";
}

/**
 * Lifts this stop's target and, on a dimming pack, drops the rest of the
 * screen's dimmable regions behind it.
 *
 * Two rules the mockup gets for free by hand-placing its marks, and this has
 * to keep by construction:
 *
 *  - Opacity multiplies down the tree, so an element that CONTAINS the target
 *    (or sits inside it) must never be dimmed — it would take the target down
 *    with it. Such regions are skipped rather than marked.
 *  - If a stop's target is not on this screen at all — an inbox with no mail
 *    has no lanes — nothing is dimmed. A page dimmed to nothing, explaining
 *    nothing, is worse than a page left alone.
 *
 * @param {Document} doc
 * @param {{ regions?: string[], target: string, mode?: "dim" | "forward" }} stop
 * @returns {Element[]} the lit elements, in document order
 */
export function applyEmphasis(doc, { regions = [], target, mode = "dim" }) {
  clearEmphasis(doc);
  const lit = [...doc.querySelectorAll(target)];
  if (lit.length === 0) return [];

  if (mode === "dim") {
    for (const selector of regions) {
      for (const element of doc.querySelectorAll(selector)) {
        if (lit.some((one) => one === element || one.contains(element) || element.contains(one))) continue;
        element.setAttribute("data-tour-dim", "");
      }
    }
  }
  for (const element of lit) {
    element.setAttribute("data-tour-dim", "");
    element.classList.add("lit");
  }
  return lit;
}

/**
 * Puts the screen back exactly as it was: no marks, no lift, and no dangling
 * description pointing at a card that is about to leave.
 *
 * @param {Document} doc
 */
export function clearEmphasis(doc) {
  for (const element of doc.querySelectorAll("[data-tour-dim]")) {
    element.removeAttribute("data-tour-dim");
    element.classList.remove("lit");
    element.removeAttribute("aria-describedby");
  }
}
