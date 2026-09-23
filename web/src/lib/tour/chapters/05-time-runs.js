/**
 * CHAPTER 5 — TIME RUNS (#866).
 *
 * The ratified mockup's fifth `CH` entry (design/v19/tour/round-5/f-one-take.html,
 * lines 768–788), with the copy correction dated 2026-09-22
 * (design/v19/tour/round-5/README.md, "Third correction"): the reminder line
 * no longer names a day count, so it reads "At a month out it warms, and
 * Orbit reminds you." verbatim.
 *
 * WHAT THE MOCKUP DRAWS. A body walking inward — `walk(381, 16, 2600)` tweens
 * a fixed demo item from 381 days out to 16, redrawing it at a hand-picked
 * pixel each frame (`pos(days)`, the mockup's own copy of the dial's law) —
 * then a static highlight and callout on where it lands, then a toast div
 * (`#toast`) sliding down for the reminder line.
 *
 * WHAT IT BECOMES. Two things the product has no real element for:
 *
 *  - THE WALKING BODY. There is no real due item this chapter can animate —
 *    a chapter must never depend on what is actually on a household's dial,
 *    and moving a REAL body's real element to fake time passing would be
 *    writing to the one place demo motion must never reach. So this chapter
 *    draws its own — one `<g class="tourfilm-time-body">`, appended into the
 *    real `.dial` svg exactly where a real body lives, positioned every
 *    frame by the dial's OWN law: `dialPlacement(days)`
 *    (web/src/lib/data/chart.js), the same function `+page.svelte` calls for
 *    every real body's placement. Nothing here invents a coordinate; the
 *    function the product already trusts for this is asked for one, every
 *    frame, the same way `ctl()` asks the live DOM for a box. The node is
 *    removed the moment the chapter is done with it — drawn, never sent
 *    anywhere, gone by the next chapter, same rule example.js already keeps
 *    for the eight-stop walk's own teaching prop.
 *
 *  - THE REMINDER TOAST. No toast or notification surface exists anywhere in
 *    the product (checked: no such component under web/src/). Rather than
 *    invent one, the reminder line is said as a plain callout on the chart
 *    itself — the words survive, verbatim; the imagined chrome does not.
 *
 * THE TRAVELLING HOLE. This is one of the three chapters (5, 9, 12) whose lit
 * ring and veil hole follow a moving target rather than sitting still
 * (veil.js's own comment names this chapter). The veil's re-measure loop
 * already re-paints its hole on its own once something is lit and moving
 * (veil.js, `measureLoop`) — this chapter only has to keep the RING with it,
 * which is not automatic (vocabulary.js's `syncRings` is only ever called
 * from `light()`/`growInto()`), so `light(body)` is called again on every
 * tween frame purely to re-sync the ring to the body's new box. Nothing here
 * reaches past the vocabulary into veil.js directly.
 */
import { dialPlacement } from "../../data/chart.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Ratified beat: a fixed demo item walks from 381 days out to 16, over a
 *  fixed 2600ms lead-in of 400ms — the mockup's own numbers, not data. */
const DAYS_FAR = 381;
const DAYS_NEAR = 16;
const WALK_MS = 2600;
const LEAD_MS = 400;

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-time-runs.test.mjs can pin the real one
 * (`.dial`) against home's own markup. `.tourfilm-time-body` is not real
 * markup — this chapter draws and removes it itself — so it is pinned by
 * running the chapter instead.
 */
export const SELECTORS = Object.freeze({
  /** The star chart, so the demo body has somewhere real to live and the
   *  reminder line has something real to anchor to. */
  dial: ".dial",
  /** The demo body this chapter draws and removes; never a real item. */
  body: ".tourfilm-time-body",
});

/** Eased 0..1, matching the mockup's own `walk`. @param {number} t */
function ease(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * @param {Document} doc
 * @param {Element} dial
 * @param {number} days
 */
function drawTimeBody(doc, dial, days) {
  const group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "tourfilm-time-body");
  group.setAttribute("aria-hidden", "true");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "tourfilm-time-dot");
  dot.setAttribute("r", "5.5");
  dot.setAttribute("style", "fill:var(--accent)");
  group.appendChild(dot);
  dial.appendChild(group);
  positionTimeBody(group, days);
  return group;
}

/** @param {Element} group @param {number} days */
function positionTimeBody(group, days) {
  const { x, y } = dialPlacement(days);
  const dot = group.querySelector(".tourfilm-time-dot");
  if (!dot) return;
  dot.setAttribute("cx", String(x));
  dot.setAttribute("cy", String(y));
}

/** @type {import("./index.js").Chapter} */
export default {
  id: "time",
  name: "Time runs",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, light, unlight, callout, dropCallout, tween, w, mark, dry, doc } = ctx;

    await setScreen("/home");
    veil(false);

    /* The demo body arrives far out, plain, before anything is taught. */
    const dial = ctl({ sel: SELECTORS.dial });
    let bodyEl = null;
    if (!dry() && dial.els[0]) bodyEl = drawTimeBody(doc, dial.els[0], DAYS_FAR);
    await w(LEAD_MS);

    /* The walk: the veil comes up and the body is lit before it moves, so
       the hole is already cut where the body already is. `light(body)`
       inside the tween is what keeps the RING with it; the veil's own loop
       keeps the HOLE with it on its own. */
    const body = ctl({ sel: SELECTORS.body, round: true, optional: true });
    light(body);
    veil(true);
    await tween(WALK_MS, (t) => {
      if (dry() || !bodyEl) return;
      const days = Math.round(DAYS_FAR + (DAYS_NEAR - DAYS_FAR) * ease(t));
      positionTimeBody(bodyEl, days);
      light(body);
    });
    await mark("time-warmed");

    /* It has landed close in. Visit it properly and say why. */
    await goto(body, { willPress: false });
    await callout("Time runs. The nearer the sun, the sooner.", body, "bottom");
    unlight(body);
    veil(false);

    /* The reminder line: no toast exists to carry it, so the chart does. */
    await callout("At a month out it warms, and Orbit reminds you.", dial, "top", { mark: "time-toast" });
    dropCallout();

    if (bodyEl) bodyEl.remove();
  },
};
