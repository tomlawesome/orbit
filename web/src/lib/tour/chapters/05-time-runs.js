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
 * tests/unit/v19-tour-chapter-time-runs.test.mjs can pin the real ones
 * against home's own markup (desk) and pocket.svelte's (pocket).
 * `.tourfilm-time-body` is not real markup — this chapter draws and removes
 * it itself — so it is pinned by running the chapter instead.
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** The star chart, so the demo body has somewhere real to live and the
     *  reminder line has something real to anchor to. */
    dial: ".dial",
    dialSvg: ".dial",
    /** The demo body this chapter draws and removes; never a real item. */
    body: ".tourfilm-time-body",
  }),
  POCKET: Object.freeze({
    /** The round dial, and the reminder line's own anchor. */
    dial: ".pocket .mdial",
    /** Its own `<svg>` — the demo body's real append target (§3.6). */
    dialSvg: ".pocket .mdial svg",
    /** This household's own sun — the sky line's anchor (§3.3). */
    sun: ".pocket .mdial .pk-sun",
    /** The demo body this chapter draws and removes; never a real item. */
    body: ".tourfilm-time-body",
  }),
});

/**
 * #1174 round 5, THE DANGER ZONE PULSES (owner's decision, 2026-10-01: "when
 * the film shows the danger-zone ring, it pulses red, visibly"). The danger
 * zone is the dial's r=62 circle round the sun — about twelve days out —
 * drawn in the product as a faint red wash and a dashed `--overdue` line at
 * 30% (home/+page.svelte, pocket.svelte). This chapter is where the film
 * shows it: a body walks in toward the sun and "the nearer the sun, the
 * sooner" is said over it.
 *
 * So from the moment the walking body lands until the chapter is done, the
 * film lays its own ring over the product's, in the same place:
 *
 *  - a solid `--overdue` line, 2.5 units, and the zone filled with the same
 *    red at 14% — the pack's own red on every pack, at least 3:1 against
 *    its ground (3.7:1 on the light packs, about 7:1 on the dark);
 *  - a beat every 1.4s: the line dips to 55% and back, and a second red
 *    ring swells from the line to 1.22x and fades out, the way the mockup's
 *    bloom leaves a body; both run on the film's clock (`animate`), so they
 *    stop when the film is paused or stopped;
 *  - under reduced motion, the steady line and the wash, no beat;
 *  - drawn under the bodies and the sun, never sent anywhere, and gone with
 *    the chapter (`data-tourfilm-staged`, which `clear()` also sweeps).
 */
const DANGER_R = 62;
const DANGER_BEAT_MS = 1400;

/**
 * @param {Document} doc
 * @param {Element} dial  the dial's own `<svg>`
 */
function drawDanger(doc, dial) {
  /** @param {string} tag @param {Record<string, string>} attributes */
  const svg = (tag, attributes) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  const centre = { cx: "190", cy: "190", r: String(DANGER_R) };
  const group = svg("g", { class: "tourfilm-danger", "aria-hidden": "true", "data-tourfilm-staged": "", "pointer-events": "none" });
  const wash = svg("circle", { ...centre, class: "tourfilm-danger-wash", style: "fill:var(--overdue);fill-opacity:.14;stroke:none" });
  const swell = svg("circle", {
    ...centre, class: "tourfilm-danger-swell",
    style: "fill:none;stroke:var(--overdue);stroke-width:2;opacity:0;transform-origin:190px 190px",
  });
  const line = svg("circle", {
    ...centre, class: "tourfilm-danger-line", "data-danger-line": "",
    style: "fill:none;stroke:var(--overdue);stroke-width:2.5;stroke-opacity:1",
  });
  group.append(wash, swell, line);
  /* Straight after the product's own danger line, so every body and the
     sun, drawn later in the same svg, stay on top of it. */
  const own = Array.from(dial.querySelectorAll(`circle[r="${DANGER_R}"]`)).pop();
  if (own) own.after(group);
  else dial.prepend(group);
  return { group, wash, swell, line };
}

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
    const { pocket, setScreen, veil, ctl, goto, light, unlight, callout, dropCallout, tween, w, mark, dry, doc, animate } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    veil(false);

    /* The demo body arrives far out, plain, before anything is taught. */
    const dialSvg = ctl({ sel: S.dialSvg });
    let bodyEl = null;
    if (!dry() && dialSvg.els[0]) bodyEl = drawTimeBody(doc, dialSvg.els[0], DAYS_FAR);
    /** @type {ReturnType<typeof drawDanger> | null} */
    let danger = null;
    try {
      await w(LEAD_MS);

      /* The walk. The body is lit before it moves, so the ring is already on
         it, and `light(body)` inside the tween is what keeps the ring WITH it.

         NO VEIL. Chapter 5 is one of only two chapters in the ratified film
         that never raises it (the other is 12): the mockup opens this chapter
         `veil(false)` and never calls `veil(true)` again
         (design/v19/tour/round-5/f-one-take.html:770). The whole sky stays lit
         while time runs across it, which is the point of the beat — you are
         watching the year move, not one control in a spotlight. veil.js's own
         comment names "chapters 5/9/12's travelling hole", which is about the
         mask being able to FOLLOW a moving hole, not an instruction to raise
         one here; it misled this chapter and chapter 12 once already. */
      const body = ctl({ sel: S.body, round: true, optional: true });
      light(body);
      await tween(WALK_MS, (t) => {
        if (dry() || !bodyEl) return;
        const days = Math.round(DAYS_FAR + (DAYS_NEAR - DAYS_FAR) * ease(t));
        positionTimeBody(bodyEl, days);
        light(body);
      });

      /* Landed, close in: the danger zone it is walking toward pulses red
         (owner, 2026-10-01). Not in the dry run, which draws nothing. */
      if (!dry() && dialSvg.els[0]) {
        danger = drawDanger(doc, dialSvg.els[0]);
        const beat = { duration: DANGER_BEAT_MS, iterations: Infinity };
        void animate(danger.line, [{ strokeOpacity: 1 }, { strokeOpacity: 0.55 }, { strokeOpacity: 1 }], { ...beat, easing: "ease-in-out" });
        void animate(danger.wash, [{ fillOpacity: 0.2 }, { fillOpacity: 0.08 }, { fillOpacity: 0.2 }], { ...beat, easing: "ease-in-out" });
        void animate(danger.swell, [
          { opacity: 0.9, transform: "scale(1)" },
          { opacity: 0, transform: "scale(1.22)" },
        ], { ...beat, easing: "ease-out" });
      }
      await mark("time-warmed");

      /* It has landed close in. Visit it properly and say why. On the pocket
         this is a sky line (§3.3): anchored to the sun, not the body. */
      await goto(body, { willPress: false });
      if (pocket) {
        const sun = ctl({ sel: SELECTORS.POCKET.sun, round: true });
        await callout("As time rolls by, items gravitate toward your sun, the sooner the event, the closer they are.", sun, "bottom", { dy: 30 });
      } else {
        await callout("As time rolls by, items gravitate toward your sun, the sooner the event, the closer they are.", body, "bottom");
      }
      unlight(body);

      /* The reminder line: no toast exists to carry it, so the chart does.
         #1083 §6: on the pocket the veil comes up first, the body still lit so
         its hole stays cut — round 8's rule, the pocket dial has no empty
         quarter and a line over the bodies is worse than a veil. The desk
         keeps `veil(false)` throughout, as ratified, and keeps naming the same
         `.dial` element it always has (`dialSvg`, above — the same selector). */
      const dial = pocket ? ctl({ sel: S.dial, round: true }) : dialSvg;
      if (pocket) { veil(true); light(body); }
      /* `pin` (#1174): the line stays at the dial's top, clamped under the
         chrome — round 8's toast position. Without it the pocket's own
         "flip when it does not fit" rule dropped it under the dial instead. */
      await callout("Orbit reminds you, visually and through notifications.", dial, "top", { mark: "time-toast", pin: pocket });
      if (pocket) {
        veil(false);
        /* #1174: lit again above for the toast's hole, so unlit again here —
           left lit, its ring outlived the body it was drawn round and stood on
           the relay and inbox screens after it. */
        unlight(body);
      }
      dropCallout();
    } finally {
      /* The chapter is done, or was jumped out of or stopped: its body and
         its pulse go with it. */
      if (danger) {
        for (const animation of danger.group.getAnimations?.({ subtree: true }) ?? []) animation.cancel();
        danger.group.remove();
      }
      if (bodyEl) bodyEl.remove();
    }
  },
};
