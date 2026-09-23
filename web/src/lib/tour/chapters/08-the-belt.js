/**
 * CHAPTER 8 — THE BELT (#866, round 6's re-cut, #1093).
 *
 * Round 5's chapter 8 is retired outright (design/v19/tour/round-5/README.md
 * says why: the belt changed underneath it twice, #1062 and #1088). This
 * file is cut from round 6 (design/v19/tour/round-6/README.md), copied
 * verbatim where round 6's own choreography could be built against real
 * markup, and translated — never invented — everywhere it could not. Three
 * translations go beyond a plain coordinate-to-selector swap, and are
 * recorded here because a reviewer holding round 6 beside this file needs to
 * know they are deliberate, not missed:
 *
 * 1. BEAT 1'S PRESS DOES NOT NAVIGATE. Round 6 keeps round 5's beat 1
 *    unchanged: "the dot travels to the Volvo's body, lifts it, presses; the
 *    item screen crossfades in." On the shipped home screen a body's own
 *    `.body-link` press does not do that — #424 (owner ruling, 2026-08-16)
 *    made the manifest row itself the item's destination in place, and
 *    `/item/<id>` (#455's full-command surface, what this chapter needs) is
 *    only reached from inside that opened row, via its own "manage this item
 *    →" link. `.body-link`'s click is unbound beyond a hover tooltip; its
 *    href is a bare same-page anchor. So this chapter presses the real body
 *    for the gesture — exactly the license chapter 2 already takes with
 *    `#nstar`, which opens a drawer this film never renders either — and
 *    then names the screen the full journey leads to: `setScreen("/item")`,
 *    the belt's own front door with no id (#1014, `+page.js`), which
 *    redirects to whichever item is soonest due and therefore never
 *    branches this chapter on what a household actually holds.
 *
 * 2. THE READING CARD IS NARRATED, NOT DRAWN. `press()` (vocabulary.js) only
 *    ever animates a scale — it does not dispatch a click, by the same rule
 *    11-your-sky.js documents for its own swatch press — so no chapter can
 *    make the real screen's `openDoc()` run, and `aside#readcard` is not
 *    even mounted until `openDoc()` sets `previewDoc` (#1088's own comment:
 *    "mounted only while a preview is on its way in or out"). There is
 *    nothing this chapter could ring even if it clicked for real. Round 6
 *    asks for the shipped card's own screenshot, cropped from its own render
 *    (`../round-5/shots/preview-service-history.png`) — a design asset, not
 *    something this build ships to the browser, and painting it in would be
 *    exactly the hand-drawn page round 6 spends a paragraph ruling out. So
 *    beat 3 says the same two lines at the same two holds, anchored to the
 *    real elements that ARE on screen (the papers, then the card), and
 *    stops short of drawing a card that cannot honestly appear.
 *
 * 3. THE TWO PAPERS ARE NEVER TWO SPECIFIC DOCUMENTS. Round 6 names a
 *    certificate and a service history because its worked example has both.
 *    A chapter must not branch on what is actually attached to whatever item
 *    `/item` seats — zero, one or several — so "the two ringed papers" is
 *    every `.doclabel` on screen, lit together, `all: true, optional: true`,
 *    the same `optional` idiom 01-arrive.js uses for the other households'
 *    suns. Nothing here required the doc/item split #1088 draws on the
 *    interactive rock itself (`.hit.open`): that class does not exist on
 *    this branch (feature/1088-document-preview is not merged here) and
 *    would not have helped regardless, per (2) above. `.doclabel` does exist
 *    already (it is #1062's, not #1088's) and is the one class the shipped
 *    markup gives a document that an item never wears, so it is what this
 *    chapter rings.
 *
 * WHAT SURVIVES UNCHANGED FROM ROUND 6. The end-caps are real controls
 * (#1062) and this chapter drives them exactly as named: `sel` is the
 * `text.endcap` ink (what visually lifts and presses), `ring` is the
 * `rect.endtarget` hit box (what the glow actually wraps) — the split
 * vocabulary.js's own `ControlSpec.ring` doc calls out by naming this very
 * chapter. `data-step="1"` is `later →`; `data-step="-1"` is `← sooner`
 * (belt.behaviour.js's own table, unchanged by #1094). Both end-caps are
 * `optional: true` — a household whose seated item sits at either end of its
 * own manifest shows one already spent, and the chapter must play the same
 * either way.
 *
 * #1094, ALREADY SETTLED. The owner ruling that end-caps and arrow keys step
 * item to item and never onto a document (2026-09-23) is not a conflict with
 * anything this chapter assumes: round 6's own beat 4 already only ever
 * steps between neighbouring ITEMS, never onto a paper, so nothing here
 * needed to change for it. Confirmed against band.js's `stepFrom`, which
 * filters `kind !== "doc"` before either end-cap's disabled state or this
 * chapter's press is ever asked to reason about where a step lands.
 *
 * THE TICK. This chapter is one of the three the transport measures a jump
 * to (4, 8, 11), so — same rule 01-arrive.js states for the whole registry —
 * it opens exactly like a chapter played from a cold jump: its own
 * `setScreen`/`veil(false)` first, never assuming the previous chapter left
 * the screen the way this one wants it. Every control that might not exist
 * is `optional`, so the beats cost the same fixed time whether the seated
 * item carries no papers, one, or several, and whichever end is spent.
 */

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-the-belt.test.mjs can pin them against the
 * belt's real markup (web/src/routes/item/[[id]]/+page.svelte,
 * belt.behaviour.js) and home's own (`.body-link`).
 */
export const SELECTORS = Object.freeze({
  /** The seated household's own body on the dial — round 6's "the Volvo",
   *  whichever real item happens to be first in DOM order. */
  body: ".body-link",
  /** Every document currently riding the belt beside the apex item — round
   *  6's "two ringed papers", generalised to however many there are. */
  docLabel: "#caps .doclabel",
  /** The item card at the apex — round 6's anchor for "read without leaving
   *  the sky". */
  cardwrap: "#cardwrap",
  /** `later →`: the ink that lifts and presses. */
  laterInk: '#ends g.endcap-hit[data-step="1"] text.endcap',
  /** `later →`'s real hit box, which the ring wraps instead of the ink. */
  laterTarget: '#ends g.endcap-hit[data-step="1"] rect.endtarget',
  /** `← sooner`: the ink that lifts and presses. */
  soonerInk: '#ends g.endcap-hit[data-step="-1"] text.endcap',
  /** `← sooner`'s real hit box. */
  soonerTarget: '#ends g.endcap-hit[data-step="-1"] rect.endtarget',
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "belt",
  name: "The belt",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, press, light, unlight, callout, dropCallout, mark, w, T } = ctx;

    /* ---- beat 1: arrival — unchanged from round 5, translated per (1) ---- */
    await setScreen("/home");
    veil(false);

    const body = ctl({ sel: SELECTORS.body, round: true, optional: true });
    veil(true);
    await goto(body);
    await press(body);
    await mark("belt-arrive");
    unlight(body);

    await setScreen("/item");
    await w(T.cross);

    /* ---- beat 2: the papers ---- */
    const papers = ctl({ sel: SELECTORS.docLabel, all: true, pad: 8, radius: 6, optional: true });
    await goto(papers, { willPress: false });
    await callout("Every body carries its documents in a belt around it.", papers, "left", {
      mark: "belt-cert",
    });
    await callout("The belt is what you have attached to it.", papers, "right", { w: 220, mark: "belt-svc" });

    /* ---- beat 3: the paper pressed, the page beside the card ---- */
    await callout("Click one to bring it in.", papers, "top", { label: true, hold: 2000, mark: "belt-doc" });
    await press(papers);

    const cardwrap = ctl({ sel: SELECTORS.cardwrap, radius: 16 });
    await callout("The page itself, read without leaving the sky.", cardwrap, "right", { mark: "belt-read" });
    dropCallout();
    unlight(papers);

    /* ---- beat 4: the belt steps, by pointer ---- */
    const later = ctl({ sel: SELECTORS.laterInk, ring: SELECTORS.laterTarget, optional: true });
    await goto(later);
    await callout("later → steps the belt — so do the arrow keys.", later, "top", { mark: "belt-later" });
    await press(later);
    unlight(later);
    await w(T.cross);

    const sooner = ctl({ sel: SELECTORS.soonerInk, ring: SELECTORS.soonerTarget, optional: true });
    await goto(sooner);
    await press(sooner);
    await mark("belt-sooner");
    unlight(sooner);
    await w(T.cross);

    /* End state: the apex item, both papers ringed and breathing again —
       chapter 9's opening frame. */
    light(papers);
  },
};
