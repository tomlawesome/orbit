/**
 * CHAPTER 10 — OTHER HOUSEHOLDS (#866).
 *
 * The mockup's tenth `CH` entry, `id: "others"`
 * (design/v19/tour/round-5/f-one-take.html, lines 1017-1042), translated by
 * the same rules chapter 1 sets out (`01-arrive.js`): `{ id, name, play }`,
 * vocabulary.js's words only, coordinates become selectors, and a chapter
 * never branches on data.
 *
 * THE SUN. `SELECTORS.other` is the exact element chapter 1 already names
 * `others` — `.minisys`, the other households out in the sky
 * (`web/src/routes/home/home.behaviour.js`'s `renderGalaxy`) — matched
 * singly rather than with `all: true`, the same way chapter 1's own closing
 * "gran" beat does, and `optional: true` for the same reason: a household
 * alone in its sky still plays this chapter, at the same length, with the
 * ring simply lighting nothing. The mockup's fixture places its first
 * `.minisys` at the exact box its own "gran" control names (x 1053, y 235,
 * 96x96 — see `tests/unit/v19-tour-chapter-arrive.test.mjs`'s `drawHome`
 * helper, which this chapter's own test reuses), which is what confirms the
 * mapping.
 *
 * THE "ASK TO JOIN" CHIP HAS NO REAL EQUIVALENT HERE. The mockup draws one
 * (`put("...ask to join...")`) with its own comment admitting why: its
 * fixture makes the reader a member of every household, so it "has no
 * ask-to-join state to photograph" and fakes one. The real product DOES have
 * one — `.askveil` / `.askcard` / `.askacts button.yes`
 * (`web/src/routes/home/+page.svelte`) — but it renders only from
 * `view?.emptySky`, reachable only when the reader belongs to NO household
 * at all. That is exactly the data this chapter must not branch on: forcing
 * the empty-sky screen would be choosing a household count, and skipping the
 * chip on a member reader would make the beat count depend on it either way.
 * So, per the brief, this is reported rather than invented: no selector is
 * written for it, and the "tap one to ask to join" line is pinned to the
 * same household sun instead — which is also where the mockup's own chip
 * sits, immediately below it.
 *
 * PRESS IS A GESTURE ONLY. `press()` (vocabulary.js) never dispatches a real
 * click; a real click on a `.minisys` you already belong among instead flies
 * the camera to that household (`home.behaviour.js`'s `flyTo`), which this
 * chapter must not trigger.
 *
 * THE VEIL. Nothing is dimmed on arrival (chapter 9 hands off a home already
 * lit); this chapter veils before its own teaching, same as chapters 2 and
 * 11 each do at their own start, and drops the veil again at the end, as the
 * mockup's own entry does, ahead of chapter 11's fresh `veil(false)`.
 */

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-other-households.test.mjs can pin it against
 * home's real markup.
 */
export const SELECTORS = Object.freeze({
  /** The nearest other household's own sun — the same real element chapter
   *  1 calls `others`, matched singly and optionally. */
  other: ".minisys",
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "others",
  name: "Other households",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, press, unlight, callout, dropCallout } = ctx;

    await setScreen("/home");
    veil(false);

    /* The nearest other household's sun — optional, so a household alone in
       its sky still plays this chapter, unchanged. */
    const other = ctl({ sel: SELECTORS.other, round: true, optional: true });
    veil(true);
    await goto(other);
    await callout(
      "The rest of the sky holds households you don't belong to.",
      other,
      "left",
      { mark: "others-gran" },
    );
    await press(other);
    dropCallout();

    /* No real ask-to-join surface exists for a reader who already belongs
       somewhere (see the file header), so the line is pinned to the same
       sun rather than to an invented chip. */
    await goto(other, { willPress: false });
    await callout(
      "Tap one to ask to join — Gran's flat, the narrowboat.",
      other,
      "left",
      { mark: "others-ask" },
    );
    unlight(other);
    dropCallout();
    veil(false);
  },
};
