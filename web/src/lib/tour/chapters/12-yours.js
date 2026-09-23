/**
 * CHAPTER 12 — YOURS (#866).
 *
 * The last of the twelve, and the film's closing chapter. Its beats are the
 * ratified mockup's twelfth `CH` entry, `id: "yours"`
 * (design/v19/tour/round-5/f-one-take.html, lines 1102–1118), translated by
 * the same rules chapter 1 sets out in `01-arrive.js`: same shape, same
 * imports, coordinates become selectors, and a chapter never branches on
 * data.
 *
 * THE CORRECTED CLOSING LINE. The mockup body still reads "That was a year
 * in a minute." — round 1's copy, written when the film ran a minute. It
 * runs 3:41, so the line promised a length the film does not keep. The
 * correction dated 2026-09-19 (design/v19/tour/round-5/README.md, "That was
 * a year in a minute.") retires it in favour of "That was a year, in one
 * turn of the ring.", which says what the chapter actually shows. The
 * second callout, "Now it's yours.", is unchanged. This file carries the
 * corrected line, not the mockup body's stale one.
 *
 * WHAT THE MOCKUP DRAWS. The same fixed demo item chapter 5 walks — there is
 * still no real due item a chapter may depend on — making one more circuit
 * of the ring: out at 381 days, in to 20, and back out to 381, over two
 * 1500ms legs (`walk(381, 20, 1500)` then `walk(20, 381, 1500)`), the
 * mockup's own numbers. This is the whole year the film has been teaching,
 * shown once more in miniature before the reader is handed the wheel. Then
 * the household's own sun is visited and the two closing lines are read
 * over it.
 *
 * THE DEMO BODY, drawn and removed exactly as chapter 5 draws and removes
 * its own: one `<g class="tourfilm-year-body">` appended into the real
 * `.dial` svg, positioned every frame by the dial's own law,
 * `dialPlacement(days)` (web/src/lib/data/chart.js) — the same function
 * `+page.svelte` calls for every real body's placement, and the same
 * function chapter 5 already asks. Nothing here invents a coordinate. The
 * node is removed the moment the chapter is done with it, same rule chapter
 * 5 and example.js already keep.
 *
 * THE TRAVELLING HOLE. This is one of the three chapters (5, 9 and 12) whose
 * lit ring and veil hole follow a moving target rather than sitting still
 * (veil.js's own comment names this chapter). The literal mockup never
 * raises its veil for this walk — it has no product underneath, only a
 * screenshot the drawn body already reads clearly against — but the film's
 * own rule is that everything dims except the control being taught, and
 * chapter 5 already makes that call for the identical case: veil up before
 * the first frame plays, `light(body)` called again on every tween frame to
 * keep the ring with it (the veil's own re-measure loop keeps the hole with
 * it on its own), veil down once the walk is read. This chapter drives its
 * own two-leg walk the same way. Nothing here reaches past the vocabulary
 * into veil.js directly.
 *
 * THE CLOSING SUN. Once the year has run its circuit, the veil comes down
 * and the household's own sun — the same element chapter 1 opens on
 * (`.sun-link`) — is visited plainly, the way chapter 11 closes its own
 * beats. Both closing lines anchor to it: "top" for the first, landing at
 * the sun's measured top edge exactly where the mockup's own hard-coded
 * point falls ([640, 376] against the mockup's own sun box), and "bottom"
 * for the second. The mockup nudges its second callout twelve points lower
 * still ([640, 448] against the box's true bottom edge of [640, 424]) to
 * clear the ring's glow; this chapter does not reproduce that hand-tuned
 * offset, the same way chapter 1's own "bottom" callout on this exact sun
 * box does not — a control and a side is the translation, not a pixel.
 *
 * WHAT THIS CHAPTER DOES NOT DO. It does not call `wear(null)`. Chapter 11
 * already returns the reader's own pack at its own closing beat
 * (`11-your-sky.js`), so this chapter opens in the state chapter 11 leaves
 * and never touches `document.documentElement.dataset.theme` itself. The
 * closing chapter's only cleanup is its own: the demo body it drew.
 */
import { dialPlacement } from "../../data/chart.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Ratified beat: the year makes one more circuit, 381 days out to 20 and
 *  back to 381, each leg 1500ms — the mockup's own numbers, not data. */
const DAYS_FAR = 381;
const DAYS_NEAR = 20;
const WALK_MS = 1500;
const LEAD_MS = 300;
const CLOSE_MS = 600;

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-yours.test.mjs can pin the real ones (`.dial`,
 * `.sun-link`) against home's own markup. `.tourfilm-year-body` is not real
 * markup — this chapter draws and removes it itself — so it is pinned by
 * running the chapter instead, same as chapter 5's own demo body.
 */
export const SELECTORS = Object.freeze({
  /** The star chart, so the demo body has somewhere real to live. */
  dial: ".dial",
  /** This household's own sun — the same element chapter 1 opens on. */
  sun: ".sun-link",
  /** The demo body this chapter draws and removes; never a real item. */
  body: ".tourfilm-year-body",
});

/** Eased 0..1, matching chapter 5's own and the mockup's own `walk`.
 *  @param {number} t */
function ease(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * @param {Document} doc
 * @param {Element} dial
 * @param {number} days
 */
function drawYearBody(doc, dial, days) {
  const group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "tourfilm-year-body");
  group.setAttribute("aria-hidden", "true");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "tourfilm-year-dot");
  dot.setAttribute("r", "5.5");
  dot.setAttribute("style", "fill:var(--accent)");
  group.appendChild(dot);
  dial.appendChild(group);
  positionYearBody(group, days);
  return group;
}

/** @param {Element} group @param {number} days */
function positionYearBody(group, days) {
  const { x, y } = dialPlacement(days);
  const dot = group.querySelector(".tourfilm-year-dot");
  if (!dot) return;
  dot.setAttribute("cx", String(x));
  dot.setAttribute("cy", String(y));
}

/** @type {import("./index.js").Chapter} */
export default {
  id: "yours",
  name: "Yours",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, light, unlight, callout, dropCallout, tween, w, mark, dry, doc } = ctx;

    await setScreen("/home");
    veil(false);

    /* The demo body arrives far out, plain, before the year runs again. */
    const dial = ctl({ sel: SELECTORS.dial });
    let bodyEl = null;
    if (!dry() && dial.els[0]) bodyEl = drawYearBody(doc, dial.els[0], DAYS_FAR);
    await w(LEAD_MS);

    /* The year, once more, in one turn of the ring: in to 20 days, then back
       out to 381. The veil comes up and the body is lit before it moves, so
       the hole is already cut where the body already is — chapter 5's own
       pattern for the same travelling spotlight. */
    const body = ctl({ sel: SELECTORS.body, round: true, optional: true });
    light(body);
    veil(true);
    await tween(WALK_MS, (t) => {
      if (dry() || !bodyEl) return;
      const days = Math.round(DAYS_FAR + (DAYS_NEAR - DAYS_FAR) * ease(t));
      positionYearBody(bodyEl, days);
      light(body);
    });
    await tween(WALK_MS, (t) => {
      if (dry() || !bodyEl) return;
      const days = Math.round(DAYS_NEAR + (DAYS_FAR - DAYS_NEAR) * ease(t));
      positionYearBody(bodyEl, days);
      light(body);
    });
    await mark("yours-year");
    unlight(body);
    veil(false);

    /* The household's own sun, visited plainly, and the film's last two
       lines read over it. */
    const sun = ctl({ sel: SELECTORS.sun, round: true });
    await goto(sun, { willPress: false });
    await callout("That was a year, in one turn of the ring.", sun, "top", { mark: "yours-year-line" });
    await callout("Now it's yours.", sun, "bottom", { mark: "yours-close" });
    unlight(sun);
    dropCallout();

    await w(CLOSE_MS);
    if (bodyEl) bodyEl.remove();
  },
};
