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
 * NO "ASK TO JOIN" CHIP. The mockup draws one, faked because its fixture
 * makes the reader a member of every household. The owner ruled on #1118
 * (2026-09-25) that a tap on another household flies there, on the desk and
 * on a phone's chips alike, with no ask-to-join; the second line says so
 * and is pinned to the same household sun.
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
 * home's real markup (desk) and pocket.svelte's (pocket).
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** The nearest other household's own system ring — the same real element
     *  chapter 1 calls `others`, matched singly and optionally. The ring, not
     *  the `.minisys` group: see chapter 1's note on the label in the box. */
    other: ".minisys .msring",
  }),
  POCKET: Object.freeze({
    /** The nearest other household's own pill chip — the same real element
     *  chapter 1's pocket set calls `others`. */
    other: ".pocket .skies .msys",
  }),
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "others",
  name: "Other households",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { pocket, setScreen, veil, ctl, goto, press, unlight, callout, dropCallout } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    veil(false);

    /* The nearest other household's sun — optional, so a household alone in
       its sky still plays this chapter, unchanged. */
    const other = ctl({ sel: S.other, round: !pocket, radius: pocket ? 22 : undefined, optional: true, visible: pocket });
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

    /* What a tap does, pinned to the same sun: it flies there, on the desk
       and on a phone's chips alike (#1118, owner 2026-09-25). */
    await goto(other, { willPress: false });
    await callout(
      "Tap one to fly there — Gran's flat, the narrowboat.",
      other,
      "left",
      { mark: "others-ask" },
    );
    unlight(other);
    dropCallout();
    veil(false);
  },
};
