/**
 * CHAPTER 1 — ARRIVE (#866).
 *
 * The first of the film's twelve, and the worked example the other eleven
 * are cut from: same shape, same imports, same rules. Its beats are the
 * ratified mockup's first `CH` entry, verbatim
 * (design/v19/tour/round-5/f-one-take.html), and its four lines are the
 * ratified copy — the same words `web/src/lib/tour/stops.js` already carries
 * for the stops `chart` and `sun`, which is where they were ratified.
 *
 * WHAT A CHAPTER IS. `{ id, name, play }` and nothing else. `play` gets the
 * film context (vocabulary.js) and uses only words from it: it never
 * imports the clock, never touches the veil directly, and never writes a
 * pixel coordinate. One chapter per file, so the eleven still to come can be
 * added without two agents colliding in the same one.
 *
 * WHAT IT MUST NOT DO. Take a different path depending on what is on the
 * screen. The transport measures every chapter's length by running it once
 * against a stopped clock before the film plays (clock.js's dry mode), so a
 * chapter whose beats depend on the data would put the ticks in the wrong
 * place and land a jump mid-sentence. Hence `optional: true` below rather
 * than an `if`: a household alone in its sky plays the same chapter, for the
 * same length, and simply has nothing lit for that beat.
 *
 * THE VEIL IS DOWN throughout. Chapter 1 arrives on the reader's own sky and
 * lights things by ring alone; the mockup dims nothing until chapter 2 opens
 * the create drawer. Copied as ratified.
 */

/**
 * Every element this chapter names, in one place, so
 * tests/unit/v19-tour-chapter-arrive.test.mjs can pin them against home's
 * real markup (desk) and pocket.svelte's (pocket). A renamed element fails
 * that test loudly instead of quietly lighting nothing, which is the one
 * failure a tour cannot notice by itself.
 *
 * #1083: two frozen sets, chosen once at the top of `play` (`ctx.pocket`).
 * Pocket sourced from `routes/home/pocket.svelte` (§5 of the build notes).
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** The star chart itself — the whole dial, as the mockup rings all 500px of it. */
    dial: ".dial",
    /** This household's own sun, at the centre of the chart. */
    sun: ".sun-link",
    /** The other households' systems, out in the rest of the sky: each
     *  one's own 40px ring (`.msring`, home.behaviour.js), not the whole
     *  `.minisys` group, whose box takes in the label and its leader above
     *  the ring and so rings as a wide ellipse (#866, seen in the #1098
     *  frames). The mockup rings the system. */
    others: ".minisys .msring",
  }),
  POCKET: Object.freeze({
    /** The star chart's ring and round dial (pocket.svelte's `.mdial`). */
    dial: ".pocket .mdial",
    /** This household's own sun — the `<circle>` pocket.svelte's own product
     *  touch (#1083 §9) marks `pk-sun`. */
    sun: ".pocket .mdial .pk-sun",
    /** The other households, as the pocket's own strip of pill chips
     *  (`.skies .msys`) rather than the desk's `.minisys` groups. */
    others: ".pocket .skies .msys",
  }),
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "arrive",
  name: "Arrive",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { pocket, setScreen, veil, ctl, goto, light, unlight, callout, dropCallout } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    veil(false);

    /* "This is your star chart." — the chart, ringed whole. On the pocket
       (#1083 §6) the line is still a sky line: anchored to the sun, not the
       dial, even though the dial is what is lit. */
    const dial = ctl({ sel: S.dial, round: true });
    const centreSun = ctl({ sel: S.sun, round: true });
    /* #1083 §3.3: on the pocket every sky line anchors to the sun, side
       bottom, dy 30 — it sits in the dial's lower half beneath the
       household's name rather than over the bodies. */
    const skyAnchor = pocket ? centreSun : dial;
    const skySide = pocket ? "bottom" : "left";
    const skyOpts = pocket ? { dy: 30 } : {};
    await goto(dial, { willPress: false });
    await callout("This is your star chart.", skyAnchor, skySide, { ...skyOpts, mark: "arrive-chart" });
    unlight(dial);

    /* Every sun on the sky: this household's, at centre, and the ones
       around it. The mockup lights all five together for the first line and
       drops the outer four for the second, so the sentence about the centre
       is the only thing still lit when it is read. */
    /* #1174: on the pocket the strip scrolls sideways and keeps every chip in
       the DOM; only the chips a reader can see are lit (`visible`). */
    const others = ctl({ sel: S.others, all: true, round: !pocket, radius: pocket ? 22 : undefined, optional: true, visible: pocket });
    await goto(centreSun, { willPress: false });
    light(others);
    await callout("Every sun is a household you belong to.", centreSun, pocket ? "bottom" : "top", {
      ...skyOpts,
      mark: "arrive-suns",
    });
    unlight(others);
    await callout("That's your sun, at centre — your household, always here.", centreSun, "bottom", skyOpts);
    unlight(centreSun);

    /* One of the others, to say what the rest of the sky is for. On the
       pocket this is the first chip in the strip, "by room" (§3.2's
       resolution decides which side it actually lands on). */
    const gran = ctl({
      sel: S.others,
      round: pocket ? false : true,
      radius: pocket ? 22 : undefined,
      optional: true,
      visible: pocket,
    });
    await goto(gran, { willPress: false });
    await callout(
      "The rest of the sky holds systems you don't belong to — tap one to fly there.",
      gran,
      "left",
      { mark: "arrive-gran" },
    );
    unlight(gran);
    dropCallout();
  },
};
