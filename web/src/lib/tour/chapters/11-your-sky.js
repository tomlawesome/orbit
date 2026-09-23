/**
 * CHAPTER 11 — YOUR SKY (#866).
 *
 * Its beats are the ratified mockup's `CH` entry for `id: "sky"`
 * (design/v19/tour/round-5/f-one-take.html, "11 YOUR SKY"), translated by
 * the same rules chapter 1 sets out in `01-arrive.js`: same shape, same
 * imports, coordinates become selectors, and a chapter never branches on
 * data.
 *
 * WHAT THIS CHAPTER TEACHES. Home's own account orb opens the settings menu;
 * "Settings" is named without being opened, because it holds three things
 * this chapter is about to point at from a distance (the sky, the relay,
 * "take the walk again"); the five theme packs are read out by name; and the
 * dawn pack is pressed and, a beat later, unpressed again — the mockup's own
 * `dawnPack` flag, which existed only so its screenshot slideshow could fake
 * a dawn-tinted body. The real product needs no fake: dawn is a real pack
 * (`web/src/lib/theme.js`'s `THEME_PACKS`), applied everywhere at once by
 * setting `document.documentElement.dataset.theme` (see
 * `web/src/routes/home/swatches.js`'s `setSwatch`), which is why this
 * chapter presses the product's OWN dawn swatch rather than reproducing the
 * mockup's flag anywhere here.
 *
 * COORDINATES BECOME SELECTORS. `SELECTORS.dawn` and `SELECTORS.afterDark`
 * are written the same way the product's own click handler tells the two
 * apart — by the swatch's `title` attribute (`packOf` in swatches.js reads
 * exactly that) — rather than by position, since the roster is a fixed list
 * and the title is its real name, not a coordinate.
 *
 * THE PRESS IS THE GESTURE; `wear` IS THE CHANGE. `press()` (vocabulary.js)
 * only animates a press and never dispatches a click, deliberately: a real
 * click on a swatch runs `setSwatch`, which writes `localStorage` and the
 * reader's saved preference, and a film that did that would change the sky
 * it promised not to touch. So this chapter presses the product's own dawn
 * swatch for the gesture and asks `wear("dawn")` for the sky — a pack worn
 * for the film's duration only, on `documentElement` and nowhere else.
 *
 * AND `wear(null)` TAKES IT OFF, putting back whatever pack the reader
 * arrived in. That is why the closing beat presses the after-dark swatch
 * (the mockup's own return) but does not name it to `wear`: the sky returns
 * to THEIRS, not to the mockup's. Skipping mid-chapter returns it too —
 * vocabulary.js's `clear()` unwears, and the player calls `clear()` on a
 * jump, on stop and at the end.
 */

/**
 * Every element this chapter names, in one place, so
 * tests/unit/v19-tour-chapter-your-sky.test.mjs can pin them against home's
 * real markup.
 */
export const SELECTORS = Object.freeze({
  /** Home's own account orb (`web/src/routes/home/+page.svelte`) — distinct
   *  from the inbox orb beside it, which is a plain link and shares the
   *  `.orb` class but not the `button` tag. */
  orb: "button.orb",
  /** The "Settings" row inside the account menu the orb opens — named, and
   *  never pressed, so the chapter can say what is behind it. */
  settingsLink: '#account nav a[href$="/settings"]',
  /** The five theme swatches, together — read out by name. */
  swatches: "#account .swatches",
  /** The dawn pack's own swatch, named by title the way the product's own
   *  click handler (`packOf`, swatches.js) does. */
  dawn: '#account .swatches button[title="dawn"]',
  /** After dark — the mockup's own return, pressed here as the gesture while
   *  `wear(null)` puts back whatever pack the reader actually arrived in. */
  afterDark: '#account .swatches button[title="after dark"]',
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "sky",
  name: "Your sky",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, press, wear, unlight, callout, dropCallout, mark, hold, w, T } = ctx;

    await setScreen("/home");
    veil(false);

    /* The orb opens this household's own settings menu. */
    const orb = ctl({ sel: SELECTORS.orb, round: true });
    veil(true);
    await goto(orb);
    await press(orb);
    await mark("sky-orb");
    unlight(orb);
    await w(T.cross);

    /* "Settings holds your sky, your relay and this walk" — named, not opened. */
    const settingsLink = ctl({ sel: SELECTORS.settingsLink });
    await goto(settingsLink, { willPress: false });
    await callout(
      "Settings holds your sky, your relay and this walk — take it again anytime.",
      settingsLink,
      "left",
      { mark: "sky-settings" },
    );
    unlight(settingsLink);

    /* The five packs, read out by name. */
    const swatches = ctl({ sel: SELECTORS.swatches });
    await goto(swatches, { willPress: false });
    await callout("star chart · after dark · clouds · dawn · retrograde", swatches, "left", {
      label: true,
      hold: 2600,
      mark: "sky-swatches",
    });
    unlight(swatches);
    dropCallout();

    /* Dawn is pressed, and the whole sky wears it — for the film only. */
    const dawn = ctl({ sel: SELECTORS.dawn, round: true });
    await goto(dawn);
    await press(dawn);
    wear("dawn");
    unlight(dawn);
    veil(false);
    await w(T.cross);
    await mark("sky-dawn");
    await hold(2400);

    /* And back to the sky it came in on. */
    veil(true);
    const afterDark = ctl({ sel: SELECTORS.afterDark, round: true });
    await goto(afterDark);
    await press(afterDark);
    wear(null);
    unlight(afterDark);
    veil(false);
    await w(T.cross);
    await mark("sky-back");
  },
};
