/**
 * CHAPTER 3 — LANDS (#866).
 *
 * The mockup's third `CH` entry (design/v19/tour/round-5/f-one-take.html,
 * lines 686-714), cut the same way chapter 1 sets out: `{ id, name, play }`,
 * the vocabulary's words only, no pixel coordinate.
 *
 * WHERE IT PICKS UP. Chapter 2 ends on `/create` with its add button pressed
 * and left lit, veiled since its own `veil(true)`, and nothing actually
 * saved — `press()` only animates (vocabulary.js), it never dispatches a
 * click, so no entry exists in the database for this chapter to point at.
 * This chapter opens by returning to `/home` and lifting the veil, mirroring
 * the mockup's own `setBg("home.png"); veil(false)`.
 *
 * ONE BEAT THE MOCKUP DRAWS THAT HAS NO REAL EQUIVALENT, and is dropped
 * rather than faked: the 80ms flash of the filled drawer the instant before
 * it closes (`setBg("create.png", true); ...; await w(80)`) — a seam
 * between two static screenshots that the real, live `/create` form has no
 * need of.
 *
 * THE LANDED BODY. `drawBody(381)` paints the mockup's own demo item — the
 * same MOT chapter 2 typed in — onto its synthetic SVG sky at "T-381D",
 * because the mockup has no product underneath and nothing was ever really
 * created. This chapter draws the same demo point for real, the way chapter
 * 5 ("Time runs") draws its own: one `<g class="tourfilm-lands-body">`,
 * appended into the real `.dial` svg exactly where a real body lives,
 * placed by the dial's OWN law — `dialPlacement(381)`
 * (`web/src/lib/data/chart.js`), the same function `+page.svelte` calls for
 * every real body's placement. Nothing here invents a coordinate, and
 * nothing here is written to a household's data: the node is drawn, never
 * sent anywhere, and removed the moment this chapter is done with it. A
 * chapter must never depend on what is actually on a household's dial —
 * this is why chapter 5 draws its own body rather than animating a real
 * one, and why this chapter does the same rather than pointing at whatever
 * a household happens to already have (or not have).
 *
 * THE SECOND CALLOUT, "The nearer the ring, the sooner.", points at the
 * whole chart again — `SELECTORS.dial`, the same control and the same
 * `.dial` chapter 1 already ratified, since the mockup's own `ring` control
 * (`mkHl(392, 152, 496, 496, { round: true })`) is the same 500px dial by a
 * different name.
 */
import { dialPlacement } from "../../data/chart.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Ratified beat: the mockup's own demo item lands 381 days out
 *  (`drawBody(381)`) — the same point chapter 5 walks away from. */
const DAYS = 381;

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-lands.test.mjs can pin the real one (`.dial`)
 * against home's own markup. `.tourfilm-lands-body` is not real markup —
 * this chapter draws and removes it itself — so it is pinned by running the
 * chapter instead, the way chapter 5 pins `.tourfilm-time-body`.
 */
export const SELECTORS = Object.freeze({
  /** The star chart itself — where the demo body lands, and the ring the
   *  second callout names again. */
  dial: ".dial",
  /** The demo body this chapter draws and removes; never a real item. */
  body: ".tourfilm-lands-body",
});

/**
 * @param {Document} doc
 * @param {Element} dial
 * @param {number} days
 */
function drawLandedBody(doc, dial, days) {
  const group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "tourfilm-lands-body");
  group.setAttribute("aria-hidden", "true");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", "5.5");
  dot.setAttribute("style", "fill:var(--accent)");
  const { x, y } = dialPlacement(days);
  dot.setAttribute("cx", String(x));
  dot.setAttribute("cy", String(y));
  group.appendChild(dot);
  dial.appendChild(group);
  return group;
}

/** @type {import("./index.js").Chapter} */
export default {
  id: "lands",
  name: "Lands",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, unlight, callout, dropCallout, dry, doc } = ctx;

    await setScreen("/home");
    veil(false);

    /* The demo body lands, plain, before anything is taught. */
    const dial = ctl({ sel: SELECTORS.dial });
    let bodyEl = null;
    if (!dry() && dial.els[0]) bodyEl = drawLandedBody(doc, dial.els[0], DAYS);

    /* "Bodies orbit by when they're due." — the body that just landed. */
    const body = ctl({ sel: SELECTORS.body, round: true, optional: true });
    await goto(body, { willPress: false });
    await callout("Bodies orbit by when they're due.", body, "top", { mark: "lands-body" });
    unlight(body);

    /* "The nearer the ring, the sooner." — the whole chart, once more. */
    const ring = ctl({ sel: SELECTORS.dial, round: true });
    await goto(ring, { willPress: false });
    await callout("The nearer the ring, the sooner.", ring, "right", { mark: "lands-ring" });
    unlight(ring);
    dropCallout();

    if (bodyEl) bodyEl.remove();
  },
};
