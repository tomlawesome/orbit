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
 * 2. THE READING CARD IS DRAWN, FOR REAL, BY THE ONE CLICK IN THIS FILM.
 *    #1088 landed on this branch (the document preview), so `aside#readcard`
 *    now exists to open. `press()` (vocabulary.js) still only ever animates
 *    a scale, exactly as 11-your-sky.js's own swatch press and 03-lands.js,
 *    07-inbox.js and 10-other-households.js all restate for their own
 *    controls — but that rule is about MUTATION, not about clicking as
 *    such, and a paper's click is not in the class it guards against. A
 *    swatch's click runs `setSwatch` (`localStorage` and a server
 *    preference — why `wear()` reimplements the visual instead of clicking
 *    at all) and the reading card's own restore button runs
 *    `restoreDocument`, a real server write. A paper's click runs neither:
 *    `openDoc` (belt.behaviour.js) sets a class on its own seat and the
 *    screen's own view state (`previewIdx`, `previewDoc`) — no
 *    `localStorage`, no address-bar change (that is `centre`'s, and a
 *    document's press never reaches `centre`), no server request. So this
 *    beat presses the papers for the gesture as every other beat does, then
 *    hands vocabulary.js's new `read()` the real hit and lets it dispatch
 *    the one genuine click this film ever makes — safe because nothing it
 *    triggers persists. `unread()` closes it again, on the belt's own step
 *    (round 6's beat 4) and, as a safety net, wherever `unwear()` is —
 *    `clear()`, so a skip or a finish never leaves a card open. Neither word
 *    reaches into the belt or the item screen beyond the click and the
 *    Escape a reader's own hand would make: the tour/product boundary stays
 *    one-way, exactly as it is everywhere else in this file.
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
  /** A paper's own real hit, in `#seats` — where `read()` (vocabulary.js)
   *  dispatches its one genuine click. Picked out from `.hit` by the one
   *  thing belt.behaviour.js's own `aria-label` always says for a document
   *  and never for an item; never a specific document (point 3), only
   *  whichever paper is first in DOM order. */
  docHit: 'g.hit[aria-label*="a document attached to"]',
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
    const {
      setScreen, veil, ctl, goto, press, light, unlight, callout, dropCallout, mark, read, unread, w, T,
    } = ctx;

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
    /* The one genuine click this film makes (see point 2, above) — safe
       because openDoc mutates nothing that outlives the film. */
    read(ctl({ sel: SELECTORS.docHit, all: true, optional: true }));

    const cardwrap = ctl({ sel: SELECTORS.cardwrap, radius: 16 });
    await callout("The page itself, read without leaving the sky.", cardwrap, "right", { mark: "belt-read" });
    dropCallout();
    unlight(papers);

    /* ---- beat 4: the belt steps, by pointer ---- */
    const later = ctl({ sel: SELECTORS.laterInk, ring: SELECTORS.laterTarget, optional: true });
    await goto(later);
    await callout("later → steps the belt — so do the arrow keys.", later, "top", { mark: "belt-later" });
    await press(later);
    /* Round 6: "two things happen together" — the card folds away and the
       belt rolls. The roll itself is still only ever named, never driven
       for real (#1094's own rule, unchanged); the fold is real, by Esc. */
    unread();
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
