// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClock } from "../../web/src/lib/tour/clock.js";
import {
  T,
  TourControlMissing,
  createFilmContext,
  holdFor,
} from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: the film's chapters are written in the vocabulary, so what the
 * vocabulary promises is what every chapter — the eleven not yet cut
 * included — is entitled to assume. Pinned here:
 *
 *  1. a control is a SELECTOR resolved against the live document, and a
 *     selector the product does not render fails loudly. That is the whole
 *     translation from the mockup's pixel coordinates, and the one failure a
 *     tour cannot notice by itself: lighting nothing, silently;
 *  2. lighting a control punches the veil's hole at that element's measured
 *     rect — the product-side replacement for the mockup's pasted `mkCut`;
 *  3. the lit element is never classed and its own inline styles come back
 *     exactly, because `.lit` already collides with home.css:495 and is
 *     zeroed at create.css:221 (veil.js states the same rule);
 *  4. a callout is anchored to the midpoint of the named edge of the live
 *     element, which is what the mockup's own coordinates are;
 *  5. DRY MODE COSTS THE SAME AS PLAYING. This is the load-bearing one: the
 *     transport measures each chapter against a stopped clock and puts a
 *     tick where it starts, so a chapter that measured differently from the
 *     way it plays would land every jump in the wrong sentence.
 */

const OVERLAY_ID = "orbit-tour-veil";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setReducedMotion(matches) {
  window.matchMedia = () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

/** Gives an element a real box, which happy-dom does not compute. */
function box(el, { x, y, w, h }) {
  el.getBoundingClientRect = () => ({
    left: x, top: y, width: w, height: h,
    right: x + w, bottom: y + h, x, y, toJSON() {},
  });
}

function holesOf() {
  const img = document.getElementById(OVERLAY_ID)?.style.maskImage ?? "";
  const match = /url\("data:image\/svg\+xml,(.*)"\)/u.exec(img);
  if (!match) return [];
  const svg = decodeURIComponent(match[1]);
  /* Only the holes: the mask's full-bleed sheet is the one rect with no
     corner radius and a white fill, so requiring rx and #000 skips it. */
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" ry="[\d.]+" fill="#000"\/>/gu)]
    .map((m) => ({ kind: "rect", x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
  const circles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/gu)]
    .map((m) => ({ kind: "circle", cx: +m[1], cy: +m[2], r: +m[3] }));
  return [...rects, ...circles];
}

/** A film context on a clock the test drives by hand. */
function stage({ reduced = false } = {}) {
  setReducedMotion(reduced);
  const clock = createClock({ reducedMotion: () => reduced });
  const ctx = createFilmContext({ clock, doc: document });
  clock.setPlaying(true);
  return { clock, ctx };
}

/** Runs the film until `promise` settles, in film-time steps. */
async function playOut(clock, promise, step = 100, cap = 400000) {
  let done = false;
  let failure = null;
  promise.then(() => { done = true; }, (error) => { done = true; failure = error; });
  let spent = 0;
  while (!done && spent < cap) {
    clock.advance(step);
    spent += step;
    await settle();
  }
  if (failure) throw failure;
  return spent;
}

beforeEach(() => {
  document.body.innerHTML = "";
  setReducedMotion(false);
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

afterEach(() => {
  setReducedMotion(false);
});

describe("a control is a selector", () => {
  it("resolves against the live document", () => {
    document.body.innerHTML = '<svg class="dial"></svg>';
    const { ctx } = stage();
    const dial = ctx.ctl({ sel: ".dial", round: true });
    expect(dial.els).toHaveLength(1);
    expect(dial.els[0]).toBe(document.querySelector(".dial"));
    expect(dial.round).toBe(true);
  });

  it("fails loudly when the product does not render what the film named", () => {
    const { ctx } = stage();
    expect(() => ctx.ctl({ sel: ".no-such-thing" })).toThrow(TourControlMissing);
    expect(() => ctx.ctl({ sel: ".no-such-thing" })).toThrow(/no element matches/u);
  });

  it("allows a control that may legitimately match nothing", () => {
    const { ctx } = stage();
    const others = ctx.ctl({ sel: ".minisys", all: true, optional: true });
    expect(others.els).toEqual([]);
  });

  it("lights every match when asked for all of them", () => {
    document.body.innerHTML = '<i class="minisys"></i><i class="minisys"></i><i class="minisys"></i>';
    const { ctx } = stage();
    expect(ctx.ctl({ sel: ".minisys", all: true }).els).toHaveLength(3);
    expect(ctx.ctl({ sel: ".minisys" }).els).toHaveLength(1);
  });

  it("measures the ring from a different element when one is named", () => {
    /* Round 6's chapter 8: the end-cap's lift ring wraps its hit box, not
       the 9.5px ink that is actually pressed. */
    document.body.innerHTML = '<g class="endcap-hit"><rect class="endtarget"></rect></g>';
    const { ctx } = stage();
    const cap = ctx.ctl({ sel: ".endcap-hit", ring: ".endtarget" });
    expect(cap.els[0].className).toBe("endcap-hit");
    expect(cap.ringEls[0].className).toBe("endtarget");
  });
});

describe("lighting cuts the veil", () => {
  it("punches a hole at the lit element's measured rect", async () => {
    document.body.innerHTML = '<button id="nstar"></button>';
    box(document.getElementById("nstar"), { x: 618, y: 100, w: 44, h: 44 });
    const { clock, ctx } = stage();
    ctx.veil(true);
    const star = ctx.ctl({ sel: "#nstar", round: true });
    await playOut(clock, ctx.goto(star, { willPress: false }));

    const holes = holesOf();
    expect(holes).toHaveLength(1);
    expect(holes[0]).toMatchObject({ kind: "circle", cx: 640, cy: 122, r: 22 });
  });

  it("closes the hole again when the control is unlit", async () => {
    document.body.innerHTML = '<button id="nstar"></button>';
    box(document.getElementById("nstar"), { x: 10, y: 10, w: 40, h: 40 });
    const { clock, ctx } = stage();
    ctx.veil(true);
    const star = ctx.ctl({ sel: "#nstar" });
    await playOut(clock, ctx.goto(star, { willPress: false }));
    expect(holesOf()).toHaveLength(1);
    ctx.unlight(star);
    expect(holesOf()).toHaveLength(0);
  });

  it("holds several holes at once, as chapter 1's suns do", async () => {
    document.body.innerHTML = '<i class="minisys"></i><i class="minisys"></i>';
    const suns = [...document.querySelectorAll(".minisys")];
    box(suns[0], { x: 100, y: 100, w: 40, h: 40 });
    box(suns[1], { x: 300, y: 300, w: 40, h: 40 });
    const { ctx } = stage();
    ctx.veil(true);
    ctx.light(ctx.ctl({ sel: ".minisys", all: true, round: true }));
    expect(holesOf()).toHaveLength(2);
  });
});

describe("the lit element is left exactly as it was found", () => {
  it("never puts a class on it", async () => {
    document.body.innerHTML = '<button id="nstar" class="nstar"></button>';
    const star = document.getElementById("nstar");
    box(star, { x: 10, y: 10, w: 40, h: 40 });
    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#nstar" });
    await playOut(clock, ctx.goto(c, { willPress: false }));
    expect(star.className).toBe("nstar");
    ctx.unlight(c);
    expect(star.className).toBe("nstar");
  });

  it("puts the element's own inline styles back exactly", async () => {
    document.body.innerHTML = '<button id="nstar" style="transform: rotate(4deg); filter: blur(1px);"></button>';
    const star = document.getElementById("nstar");
    box(star, { x: 10, y: 10, w: 40, h: 40 });
    const before = { transform: star.style.transform, filter: star.style.filter };

    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#nstar" });
    await playOut(clock, ctx.goto(c, { willPress: false }));
    expect(star.style.transform).toBe("translateY(-2px)"); /* lifted */

    ctx.unlight(c);
    expect(star.style.transform).toBe(before.transform);
    expect(star.style.filter).toBe(before.filter);
  });
});

describe("the callout", () => {
  it("carries the ratified line and is pinned to the named edge", async () => {
    document.body.innerHTML = '<svg class="dial"></svg>';
    box(document.querySelector(".dial"), { x: 390, y: 150, w: 500, h: 500 });
    const { clock, ctx } = stage();
    const dial = ctx.ctl({ sel: ".dial", round: true });
    await playOut(clock, ctx.callout("This is your star chart.", dial, "left"));

    const note = document.querySelector(".tourfilm-callout");
    expect(note).not.toBeNull();
    expect(note.textContent).toBe("This is your star chart.");
    /* left edge midpoint of the dial is (390, 400); the box sits gap-clear
       of it, so its right edge is at most there */
    expect(parseFloat(note.style.top)).toBeLessThanOrEqual(400);
  });

  it("never lands under the transport", async () => {
    document.body.innerHTML = '<i class="low"></i>';
    box(document.querySelector(".low"), { x: 600, y: 780, w: 40, h: 20 });
    const { clock, ctx } = stage();
    const low = ctx.ctl({ sel: ".low" });
    await playOut(clock, ctx.callout("Down here.", low, "bottom"));
    const note = document.querySelector(".tourfilm-callout");
    expect(parseFloat(note.style.top)).toBeLessThanOrEqual(800 - 60);
  });

  it("is held for as long as it takes to read, in either motion mode", () => {
    const line = "The rest of the sky holds systems you don't belong to — tap one to ask to join.";
    expect(holdFor(line)).toBe(Math.max(T.holdMin, T.holdBase + T.holdWord * 18));
    expect(holdFor("Hi.")).toBe(T.holdMin); /* never under the floor */
  });
});

describe("dry mode", () => {
  it("touches no DOM at all", async () => {
    document.body.innerHTML = '<svg class="dial"></svg>';
    const { clock, ctx } = stage();
    clock.dryStart();
    const dial = ctx.ctl({ sel: ".dial", round: true });
    await ctx.goto(dial, { willPress: false });
    await ctx.callout("This is your star chart.", dial, "left");
    ctx.unlight(dial);
    clock.dryEnd();

    expect(document.querySelector(".tourfilm-callout")).toBeNull();
    expect(document.querySelector(".tourfilm-ring")).toBeNull();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  it("resolves a selector the product does not render, so measuring never throws", async () => {
    const { clock, ctx } = stage();
    clock.dryStart();
    expect(() => ctx.ctl({ sel: ".nothing-here" })).not.toThrow();
    clock.dryEnd();
  });

  it("costs EXACTLY what the same beats cost when played", async () => {
    /* The load-bearing property: the transport puts each chapter's tick at
       the budget measured here, so the two must agree to the millisecond. */
    const beats = async (ctx) => {
      const dial = ctx.ctl({ sel: ".dial", round: true });
      await ctx.goto(dial, { willPress: false });
      await ctx.callout("This is your star chart.", dial, "left");
      ctx.unlight(dial);
    };

    document.body.innerHTML = '<svg class="dial"></svg>';
    box(document.querySelector(".dial"), { x: 390, y: 150, w: 500, h: 500 });

    const dryRun = stage();
    dryRun.clock.dryStart();
    await beats(dryRun.ctx);
    const measured = dryRun.clock.dryEnd();

    const played = stage();
    await playOut(played.clock, beats(played.ctx));
    /* `sched` is the exact sum of the waits taken, overshoot-free */
    expect(played.clock.sched()).toBe(measured);
    expect(measured).toBeGreaterThan(0);
  });

  it("measures shorter under reduced motion, but holds the reading the same", async () => {
    const beats = async (ctx) => {
      const dial = ctx.ctl({ sel: ".dial", round: true });
      await ctx.goto(dial, { willPress: false });
      await ctx.callout("This is your star chart.", dial, "left");
    };
    document.body.innerHTML = '<svg class="dial"></svg>';

    const measure = async (reduced) => {
      const { clock, ctx } = stage({ reduced });
      clock.dryStart();
      await beats(ctx);
      return clock.dryEnd();
    };

    const full = await measure(false);
    const still = await measure(true);
    expect(still).toBeLessThan(full);
    /* what is left under reduced motion is exactly the reading */
    expect(still).toBe(holdFor("This is your star chart."));
  });
});
