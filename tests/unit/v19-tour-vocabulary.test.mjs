// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmPlayer } from "../../web/src/lib/tour/player.js";
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

/** The veil's open holes, read from its inline SVG mask (#1174 round 3);
 *  a hole still closing is not counted. */
function holesOf() {
  const shapes = [...(document.getElementById(OVERLAY_ID)?.querySelectorAll("mask .hole:not(.leaving)") ?? [])];
  return shapes.map((shape) => {
    const n = (name) => Number(shape.getAttribute(name));
    return shape.tagName.toLowerCase() === "circle"
      ? { kind: "circle", cx: n("cx"), cy: n("cy"), r: n("r") }
      : { kind: "rect", x: n("x"), y: n("y"), w: n("width"), h: n("height") };
  });
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

  it("measures the ring from a different element when one is named", async () => {
    /* Round 6's chapter 8: the end-cap's lift ring wraps its hit box, not
       the 9.5px ink that is actually pressed. */
    document.body.innerHTML = '<g class="endcap-hit"><rect class="endtarget"></rect></g>';
    box(document.querySelector(".endcap-hit"), { x: 0, y: 0, w: 60, h: 60 });
    box(document.querySelector(".endtarget"), { x: 10, y: 10, w: 20, h: 20 });
    const { clock, ctx } = stage();
    const cap = ctx.ctl({ sel: ".endcap-hit", ring: ".endtarget" });
    expect(cap.els[0].className).toBe("endcap-hit");
    expect(cap.ringEls[0].className).toBe("endtarget");

    // T-Q12 (#1151): the assertions above only prove `ring` resolved the
    // right element -- they never prove the drawn ring is actually
    // MEASURED from it rather than from `els[0]` (the hit box). Light the
    // control for real and check the rendered ring's own box.
    await playOut(clock, ctx.goto(cap, { willPress: false }));
    const ring = document.querySelector(".tourfilm-ring");
    expect(parseFloat(ring.style.left)).toBe(10);
    expect(parseFloat(ring.style.top)).toBe(10);
    expect(parseFloat(ring.style.width)).toBe(20);
    expect(parseFloat(ring.style.height)).toBe(20);
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

describe("Addendum A: the lift yields to a clip (#1083, 2026-09-30)", () => {
  it("does not translate a control whose 2px rise would leave a clipping parent, but still rings it strong", async () => {
    document.body.innerHTML = '<div id="row" style="overflow:clip"><button id="face"></button></div>';
    const row = document.getElementById("row");
    const face = document.getElementById("face");
    /* The face fills its row exactly — a kit Row's own shape — so any rise
       at all leaves the row's own clip. */
    box(row, { x: 10, y: 10, w: 300, h: 56 });
    box(face, { x: 10, y: 10, w: 300, h: 56 });
    const before = { transform: face.style.transform, filter: face.style.filter };

    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#face" });
    await playOut(clock, ctx.goto(c, { willPress: false }));

    expect(face.style.transform).toBe(before.transform);
    expect(face.style.filter).toBe(before.filter);
    expect(c.lifted).toBe(true);
    expect(c.rings[0].style.boxShadow).toContain("46px"); /* "strong", same as any other control */

    ctx.unlight(c);
    expect(face.style.transform).toBe(before.transform);
    expect(face.style.filter).toBe(before.filter);
  });

  it("still translates a control with room above its clipping ancestor", async () => {
    document.body.innerHTML = '<div id="row" style="overflow:clip"><button id="face"></button></div>';
    const row = document.getElementById("row");
    const face = document.getElementById("face");
    /* The row is 8px taller than the face, padded above it, so a 2px rise
       stays inside. */
    box(row, { x: 10, y: 2, w: 300, h: 64 });
    box(face, { x: 10, y: 10, w: 300, h: 56 });

    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#face" });
    await playOut(clock, ctx.goto(c, { willPress: false }));

    expect(face.style.transform).toBe("translateY(-2px)");
  });

  it("press() bases a flat (clipped) control on translate(0,0), never the lift", async () => {
    document.body.innerHTML = '<div id="row" style="overflow:clip"><button id="face"></button></div>';
    box(document.getElementById("row"), { x: 10, y: 10, w: 300, h: 56 });
    const face = document.getElementById("face");
    box(face, { x: 10, y: 10, w: 300, h: 56 });

    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#face" });
    await playOut(clock, ctx.goto(c, { willPress: false }));
    await playOut(clock, ctx.press(c));
    expect(face.style.transform).not.toContain("translateY(-2px)");
  });

  it("the desk's own chapter-11 markup (no clip) still translates", async () => {
    document.body.innerHTML = '<nav id="account"><a id="settings" href="/settings"></a></nav>';
    box(document.getElementById("settings"), { x: 100, y: 100, w: 200, h: 24 });
    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#settings" });
    await playOut(clock, ctx.goto(c, { willPress: false }));
    expect(document.getElementById("settings").style.transform).toBe("translateY(-2px)");
  });
});

describe("Addendum B: the lift yields to an SVG element's own position (#1174, chapter 8's fault A)", () => {
  it("does not set a CSS transform on a control positioned by its own SVG `transform` attribute, but still rings it strong", async () => {
    document.body.innerHTML =
      '<svg><g id="caps"><g id="seat" class="capseat" transform="translate(50,60)"><text>a.pdf</text></g></g></svg>';
    const seat = document.getElementById("seat");
    // The belt paints this every frame via the attribute, never happy-dom's
    // own layout — box() stands in for what paintMembers() would measure.
    box(seat, { x: 50, y: 60, w: 40, h: 16 });
    const before = { transform: seat.style.transform, filter: seat.style.filter };

    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#seat" });
    await playOut(clock, ctx.goto(c, { willPress: false }));

    expect(seat.style.transform).toBe(before.transform);
    expect(seat.style.filter).toBe(before.filter);
    expect(seat.getAttribute("transform")).toBe("translate(50,60)");
    expect(c.lifted).toBe(true);
    expect(c.rings[0].style.boxShadow).toContain("46px"); /* "strong", same as any other control */

    ctx.unlight(c);
    expect(seat.style.transform).toBe(before.transform);
    expect(seat.getAttribute("transform")).toBe("translate(50,60)");
  });

  it("press() never sets an inline transform on an SVG-positioned control, not even translate(0,0)", async () => {
    document.body.innerHTML =
      '<svg><g id="caps"><g id="seat" class="capseat" transform="translate(50,60)"><text>a.pdf</text></g></g></svg>';
    const seat = document.getElementById("seat");
    box(seat, { x: 50, y: 60, w: 40, h: 16 });

    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#seat" });
    await playOut(clock, ctx.goto(c, { willPress: false }));
    await playOut(clock, ctx.press(c));

    expect(seat.style.transform).toBe("");
    expect(seat.getAttribute("transform")).toBe("translate(50,60)");
  });

  it("a plain SVG control with no transform attribute still lifts normally", async () => {
    document.body.innerHTML = '<svg><circle id="sun" cx="190" cy="190" r="8"></circle></svg>';
    box(document.getElementById("sun"), { x: 182, y: 182, w: 16, h: 16 });
    const { clock, ctx } = stage();
    const c = ctx.ctl({ sel: "#sun" });
    await playOut(clock, ctx.goto(c, { willPress: false }));
    expect(document.getElementById("sun").style.transform).toBe("translateY(-2px)");
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

describe("typing into a field", () => {
  /** A field with something already in it, boxed where the film can find it. */
  function drawField() {
    document.body.innerHTML = '<input id="f-name" value="New Entry">';
    const field = document.getElementById("f-name");
    box(field, { x: 373, y: 259, w: 218, h: 38 });
    return field;
  }

  const ghostText = () => document.querySelector(".tourfilm-typed")?.textContent ?? null;

  it("shows the string appearing one character at a time", async () => {
    drawField();
    const { clock, ctx } = stage();
    const name = ctx.ctl({ sel: "#f-name" });
    const seen = [];
    const playing = ctx.typeInto(name, "Car MOT");
    let done = false;
    playing.then(() => { done = true; }, () => { done = true; });
    let spent = 0;
    while (!done && spent < 20000) {
      clock.advance(10);
      spent += 10;
      await settle();
      const now = ghostText();
      if (now && now !== seen.at(-1)) seen.push(now);
    }
    await playing;
    expect(seen.at(-1)).toBe("Car MOT");
    /* every prefix, in order -- not one jump to the finished string */
    expect(seen).toEqual(["C", "Ca", "Car", "Car ", "Car M", "Car MO", "Car MOT"]);
  });

  it("never writes into the real field and never fires its handlers", async () => {
    const field = drawField();
    let handled = 0;
    field.addEventListener("input", () => { handled++; });
    field.addEventListener("change", () => { handled++; });
    field.addEventListener("keydown", () => { handled++; });

    const { clock, ctx } = stage();
    await playOut(clock, ctx.typeInto(ctx.ctl({ sel: "#f-name" }), "54.85"));

    expect(field.value).toBe("New Entry");
    expect(handled).toBe(0);
    expect(ghostText()).toBe("54.85");
  });

  it("leaves nothing behind when the film ends", async () => {
    const field = drawField();
    const before = field.outerHTML;
    const { clock, ctx } = stage();
    await playOut(clock, ctx.typeInto(ctx.ctl({ sel: "#f-name" }), "54.85"));
    expect(document.querySelector(".tourfilm-typed")).not.toBeNull();

    ctx.clear();
    expect(document.querySelector(".tourfilm-typed")).toBeNull();
    expect(field.outerHTML).toBe(before);
    ctx.destroy();
  });

  it("drops the typed text when the screen changes under it", async () => {
    drawField();
    let route = "/create";
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({
      clock,
      doc: document,
      routeOf: () => route,
      navigate: async (to) => { route = to; },
    });
    clock.setPlaying(true);
    await playOut(clock, ctx.typeInto(ctx.ctl({ sel: "#f-name" }), "54.85"));
    expect(ghostText()).toBe("54.85");

    await playOut(clock, ctx.setScreen("/home"));
    expect(document.querySelector(".tourfilm-typed")).toBeNull();
    ctx.destroy();
  });

  it("fires its mark MID-STRING, so the held frame is a half-typed field", async () => {
    drawField();
    const { clock, ctx } = stage();
    delete window.__mark;
    let whenMarked = null;
    const playing = ctx.typeInto(ctx.ctl({ sel: "#f-name" }), "Car MOT", { mark: "add-typing" });
    let done = false;
    playing.then(() => { done = true; }, () => { done = true; });
    let spent = 0;
    while (!done && spent < 20000) {
      clock.advance(10);
      spent += 10;
      await settle();
      if (whenMarked === null && window.__mark === "add-typing") whenMarked = ghostText();
    }
    await playing;
    expect(whenMarked).not.toBeNull();
    expect(whenMarked.length).toBeGreaterThan(0);
    expect(whenMarked.length).toBeLessThan("Car MOT".length);
  });

  it("costs the lead plus one beat per character, dry and played alike", async () => {
    const text = "29 Aug 2027";
    const beats = (ctx) => ctx.typeInto(ctx.ctl({ sel: "#f-name" }), text);

    drawField();
    const dryRun = stage();
    dryRun.clock.dryStart();
    await beats(dryRun.ctx);
    const measured = dryRun.clock.dryEnd();
    expect(measured).toBe(T.typeLead + T.typeChar * text.length);
    expect(document.querySelector(".tourfilm-typed")).toBeNull(); /* dry draws nothing */

    const played = stage();
    await playOut(played.clock, beats(played.ctx));
    expect(played.clock.sched()).toBe(measured);
    played.ctx.destroy();
  });

  it("under reduced motion the whole string simply arrives, and costs nothing", async () => {
    drawField();
    const { clock, ctx } = stage({ reduced: true });
    clock.dryStart();
    await ctx.typeInto(ctx.ctl({ sel: "#f-name" }), "Car MOT — Volvo V60");
    expect(clock.dryEnd()).toBe(0);

    const live = stage({ reduced: true });
    await playOut(live.clock, live.ctx.typeInto(live.ctx.ctl({ sel: "#f-name" }), "Car MOT — Volvo V60"));
    expect(ghostText()).toBe("Car MOT — Volvo V60");
    live.ctx.destroy();
  });
});

describe("#1174 round 4: the typed line's cover is solid", () => {
  it("stacks a see-through field over what is behind it, down to the first solid ground", async () => {
    document.body.innerHTML = '<div id="card" style="background-color: rgb(20, 30, 40)"><div id="wrap"><input id="f-name" style="background-color: rgba(200, 210, 220, 0.55); border: 1px solid rgb(90, 90, 90)"></div></div>';
    box(document.getElementById("f-name"), { x: 20, y: 100, w: 300, h: 48 });
    const { clock, ctx } = stage();
    await playOut(clock, ctx.typeInto(ctx.ctl({ sel: "#f-name" }), "Car MOT"));
    const cover = /** @type {HTMLElement} */ (document.querySelector(".tourfilm-typed"));
    /* the field's own see-through colour on top, the card's solid one under */
    expect(cover.style.backgroundImage.replace(/\s+/gu, "")).toBe("linear-gradient(rgba(200,210,220,0.55),rgba(200,210,220,0.55))");
    expect(cover.style.backgroundColor.replace(/\s+/gu, "")).toBe("rgb(20,30,40)");
    expect(cover.style.borderStyle).toBe("solid");
  });

  it("is the field's own colour alone when that is already solid", async () => {
    document.body.innerHTML = '<div style="background-color: rgb(1, 2, 3)"><input id="f-name" style="background-color: rgb(20, 30, 40)"></div>';
    box(document.getElementById("f-name"), { x: 20, y: 100, w: 300, h: 48 });
    const { clock, ctx } = stage();
    await playOut(clock, ctx.typeInto(ctx.ctl({ sel: "#f-name" }), "Car MOT"));
    const cover = /** @type {HTMLElement} */ (document.querySelector(".tourfilm-typed"));
    expect(cover.style.backgroundImage).toBe("");
    expect(cover.style.backgroundColor.replace(/\s+/gu, "")).toBe("rgb(20,30,40)");
  });
});

describe("#1174 round 4: room below the page", () => {
  it("adds a blank block of the height asked after everything on the page, and takes it away", () => {
    document.body.innerHTML = '<main id="page"></main>';
    const { ctx } = stage();
    ctx.room(240.2);
    const block = /** @type {HTMLElement} */ (document.querySelector(".tourfilm-room"));
    expect(block).not.toBeNull();
    expect(block.style.height).toBe("241px");
    expect(block.getAttribute("aria-hidden")).toBe("true");
    ctx.room(90);
    expect(document.querySelectorAll(".tourfilm-room")).toHaveLength(1);
    expect(block.style.height).toBe("90px");
    ctx.room(0);
    expect(document.querySelector(".tourfilm-room")).toBeNull();
  });

  it("goes with clear(), so a jump or a stop leaves the page as it was found", () => {
    document.body.innerHTML = '<main id="page"></main>';
    const { ctx } = stage();
    ctx.room(300);
    ctx.clear();
    expect(document.querySelector(".tourfilm-room")).toBeNull();
  });
});

describe("wearing a pack", () => {
  /** A reader who is sitting in "clouds" when the film starts. */
  function arriveIn(pack) {
    if (pack === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = pack;
    localStorage.removeItem("orbit-theme");
  }

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem("orbit-theme");
  });

  it("re-skins every screen at once, on documentElement", () => {
    arriveIn("clouds");
    const { ctx } = stage();
    ctx.wear("dawn");
    expect(document.documentElement.dataset.theme).toBe("dawn");
  });

  it("writes no preference anywhere — not localStorage, not the swatches", () => {
    arriveIn("clouds");
    document.body.innerHTML = '<div class="swatches"><button title="dawn" aria-pressed="false"></button></div>';
    const swatch = document.querySelector('button[title="dawn"]');
    const { ctx } = stage();
    ctx.wear("dawn");
    expect(localStorage.getItem("orbit-theme")).toBeNull();
    expect(swatch.getAttribute("aria-pressed")).toBe("false");
  });

  it("takes a swatch's title the way the product's own packOf does", () => {
    arriveIn("clouds");
    const { ctx } = stage();
    ctx.wear("after dark");
    expect(document.documentElement.dataset.theme).toBe("afterdark");
    ctx.wear("star-chart");
    expect(document.documentElement.dataset.theme).toBe("starchart");
    ctx.wear(null);
  });

  it("puts the reader's own pack back when the film takes it off", () => {
    arriveIn("clouds");
    const { ctx } = stage();
    ctx.wear("dawn");
    ctx.wear(null);
    expect(document.documentElement.dataset.theme).toBe("clouds");
  });

  it("puts back no attribute at all when they arrived without one", () => {
    arriveIn(null);
    const { ctx } = stage();
    ctx.wear("dawn");
    ctx.wear(null);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("is undone by clear(), however the film stops", () => {
    arriveIn("clouds");
    const { ctx } = stage();
    ctx.wear("dawn");
    ctx.clear();
    expect(document.documentElement.dataset.theme).toBe("clouds");
    ctx.destroy();
  });

  it("touches nothing in dry mode", async () => {
    arriveIn("clouds");
    const { clock, ctx } = stage();
    clock.dryStart();
    ctx.wear("dawn");
    clock.dryEnd();
    expect(document.documentElement.dataset.theme).toBe("clouds");
  });

  it("A SKIP MID-CHAPTER STILL RETURNS THE READER'S SKY", async () => {
    /* The case that would otherwise leave a reader in the film's theme for
       good: the pack goes on, and they press stop before it comes off. */
    arriveIn("clouds");
    const { clock, ctx } = stage();
    const chapters = [{
      id: "sky",
      name: "Your sky",
      async play(c) {
        c.wear("dawn");
        await c.hold(60000);
        c.wear(null);
      },
    }];
    const player = createFilmPlayer({ clock, ctx, chapters });
    await player.measure();
    player.jump(0);
    await settle();
    clock.advance(1000);
    await settle();
    expect(document.documentElement.dataset.theme).toBe("dawn"); /* mid-chapter */

    player.stop();
    expect(document.documentElement.dataset.theme).toBe("clouds");
    player.destroy();
  });

  it("returns it on a jump to another chapter too, and at the end of the film", async () => {
    arriveIn("clouds");
    const { clock, ctx } = stage();
    const chapters = [
      { id: "sky", name: "Your sky", async play(c) { c.wear("dawn"); await c.hold(60000); } },
      { id: "after", name: "After", async play(c) { await c.hold(100); } },
    ];
    const player = createFilmPlayer({ clock, ctx, chapters });
    await player.measure();
    player.jump(0);
    await settle();
    clock.advance(1000);
    await settle();
    expect(document.documentElement.dataset.theme).toBe("dawn");

    player.jump(1);
    await settle();
    expect(document.documentElement.dataset.theme).toBe("clouds");

    clock.advance(1000);
    await settle();
    expect(player.ended()).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("clouds");
    player.destroy();
  });
});

describe("reading a paper", () => {
  /** A paper's own hit, wired to prove `read()`/`unread()` dispatch real
   *  events rather than only meaning to — the same reason `wearing a
   *  pack`'s tests, above, check `documentElement.dataset.theme` itself
   *  rather than a mock. */
  function paper() {
    document.body.innerHTML = '<div class="hit"></div>';
    const el = document.querySelector(".hit");
    let opened = false;
    el.addEventListener("click", () => { opened = true; });
    let closed = false;
    const onEscape = (event) => { if (event.key === "Escape") closed = true; };
    window.addEventListener("keydown", onEscape);
    return {
      el,
      opened: () => opened,
      closed: () => closed,
      cleanup: () => window.removeEventListener("keydown", onEscape),
    };
  }

  it("dispatches a genuine click on the paper's own hit", () => {
    const p = paper();
    const { ctx } = stage();
    ctx.read(ctx.ctl({ sel: ".hit" }));
    expect(p.opened()).toBe(true);
    p.cleanup();
  });

  it("does nothing when there is no paper to read (optional, empty)", () => {
    const { ctx } = stage();
    const empty = ctx.ctl({ sel: ".no-such-paper", optional: true });
    expect(() => ctx.read(empty)).not.toThrow();
  });

  it("closes with a genuine Escape — and only once something was actually opened", () => {
    const p = paper();
    const { ctx } = stage();
    ctx.unread(); /* nothing read yet: no stray Escape */
    expect(p.closed()).toBe(false);
    ctx.read(ctx.ctl({ sel: ".hit" }));
    ctx.unread();
    expect(p.closed()).toBe(true);
    p.cleanup();
  });

  it("touches nothing in dry mode", () => {
    const p = paper();
    const { clock, ctx } = stage();
    clock.dryStart();
    ctx.read(ctx.ctl({ sel: ".hit" }));
    ctx.unread();
    clock.dryEnd();
    expect(p.opened()).toBe(false);
    expect(p.closed()).toBe(false);
    p.cleanup();
  });

  it("is undone by clear(), however the film stops — the same law unwear() gives a theme", () => {
    const p = paper();
    const { ctx } = stage();
    ctx.read(ctx.ctl({ sel: ".hit" }));
    ctx.clear();
    expect(p.closed()).toBe(true);
    ctx.destroy();
    p.cleanup();
  });

  it("a jump mid-chapter still closes whatever it opened", async () => {
    const p = paper();
    const { clock, ctx } = stage();
    const chapters = [
      {
        id: "belt-ish",
        name: "Belt-ish",
        async play(c) {
          c.read(c.ctl({ sel: ".hit" }));
          await c.hold(60000);
        },
      },
      { id: "after", name: "After", async play(c) { await c.hold(100); } },
    ];
    const player = createFilmPlayer({ clock, ctx, chapters });
    await player.measure();
    player.jump(0);
    await settle();
    clock.advance(1000);
    await settle();
    expect(p.opened()).toBe(true);
    expect(p.closed()).toBe(false);

    player.jump(1); /* the reader jumps away with the card still open */
    await settle();
    expect(p.closed()).toBe(true);

    player.destroy();
    p.cleanup();
  });

  it("unread() dispatches on the document, in capture-reachable form, not window (#1083)", () => {
    /* The kit sheet's own `holdSheet` (sheet.js) listens on the document in
       the capture phase — window.dispatchEvent would never reach it. A
       document-dispatched event still bubbles to window too, so the desk's
       own window-level handler (tested above) keeps working. */
    document.body.innerHTML = '<div class="hit"></div>';
    let sawOnDoc = false;
    const onDoc = (event) => { if (event.key === "Escape") sawOnDoc = true; };
    document.addEventListener("keydown", onDoc);
    const { ctx } = stage();
    ctx.read(ctx.ctl({ sel: ".hit" }));
    ctx.unread();
    expect(sawOnDoc).toBe(true);
    document.removeEventListener("keydown", onDoc);
  });
});

describe("#1083: the pocket dialect", () => {
  it("is exposed on the context, fixed at construction", () => {
    const clock = createClock({ reducedMotion: () => false });
    expect(createFilmContext({ clock, doc: document }).pocket).toBe(false);
    expect(createFilmContext({ clock, doc: document, pocket: true }).pocket).toBe(true);
  });

  describe("ControlSpec.ringless (§3.5)", () => {
    it("cuts the veil's hole but draws no ring and lifts nothing", async () => {
      document.body.innerHTML = '<div class="panel"></div>';
      box(document.querySelector(".panel"), { x: 10, y: 10, w: 300, h: 400 });
      const { ctx } = stage();
      ctx.veil(true);
      const panel = ctx.ctl({ sel: ".panel", ringless: true });
      ctx.light(panel);
      expect(holesOf()).toHaveLength(1);
      expect(document.querySelector(".tourfilm-ring")).toBeNull();
      expect(document.querySelector(".panel").style.transform).toBe("");
      ctx.unlight(panel);
      expect(holesOf()).toHaveLength(0);
    });
  });

  describe("open()/close() (§3.4)", () => {
    /** A `.pk-body` whose click opens a row elsewhere, the way
     *  pocket.svelte's `tapBody`/`openRow` do — real markup, real click. */
    function drawBodyAndRow() {
      document.body.innerHTML = `
        <g class="pk-body"></g>
        <div data-row><button data-row-face aria-expanded="false"></button></div>`;
      const body = document.querySelector(".pk-body");
      const face = document.querySelector("[data-row-face]");
      body.addEventListener("click", () => face.setAttribute("aria-expanded", "true"));
      face.addEventListener("click", () => face.setAttribute("aria-expanded", "false"));
      return { body, face };
    }

    it("open() on a .pk-body dispatches a real click", () => {
      const { face } = drawBodyAndRow();
      const { ctx } = stage();
      ctx.open(ctx.ctl({ sel: ".pk-body" }));
      expect(face.getAttribute("aria-expanded")).toBe("true");
    });

    it("clear() undoes an open row by clicking its own toggle", () => {
      const { face } = drawBodyAndRow();
      const { ctx } = stage();
      ctx.open(ctx.ctl({ sel: ".pk-body" }));
      expect(face.getAttribute("aria-expanded")).toBe("true");
      ctx.clear();
      expect(face.getAttribute("aria-expanded")).toBe("false");
      ctx.destroy();
    });

    it("open() on anything else queues close() as its undo, which folds a kit sheet", async () => {
      document.body.innerHTML = `
        <button id="morb"></button>
        <div class="p-sheet-layer open"><div class="p-sheet-panel"></div></div>`;
      const orb = document.getElementById("morb");
      const layer = document.querySelector(".p-sheet-layer");
      orb.addEventListener("click", () => layer.classList.add("open"));
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") layer.classList.remove("open");
      });
      const { ctx } = stage();
      ctx.open(ctx.ctl({ sel: "#morb" }));
      expect(layer.classList.contains("open")).toBe(true);
      ctx.clear();
      /* close() polls a frame at a time for the sheet to really go; give it
         a few real macrotasks. */
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(layer.classList.contains("open")).toBe(false);
      ctx.destroy();
    });

    it("close() marks its own Escape with tourfilm=true", async () => {
      document.body.innerHTML = '<div class="p-sheet-layer"><div class="p-sheet-panel"></div></div>';
      let seenTourfilm = null;
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") seenTourfilm = /** @type {{tourfilm?: boolean}} */ (event).tourfilm;
      });
      const { ctx } = stage();
      await ctx.close();
      expect(seenTourfilm).toBe(true);
    });

    it("does nothing in dry mode", async () => {
      const { body: pkBody, face } = drawBodyAndRow();
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document, pocket: true });
      clock.dryStart();
      ctx.open(ctx.ctl({ sel: ".pk-body" }));
      await ctx.close();
      clock.dryEnd();
      expect(face.getAttribute("aria-expanded")).toBe("false");
      expect(pkBody).not.toBeNull();
    });
  });

  describe("goto scrolls into view on the pocket, and never on desk (§3.1)", () => {
    function stageWithChrome() {
      document.body.innerHTML = '<div class="p-chrome"></div><button id="target"></button>';
      box(document.querySelector(".p-chrome"), { x: 0, y: 0, w: 400, h: 56 });
      box(document.getElementById("target"), { x: 10, y: 20, w: 40, h: 40 }); /* under the chrome */
    }

    it("scrolls a control clear of the top chrome on the pocket", async () => {
      stageWithChrome();
      const target = document.getElementById("target");
      let scrolled = false;
      target.scrollIntoView = () => { scrolled = true; };
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document, pocket: true });
      clock.setPlaying(true);
      await playOut(clock, ctx.goto(ctx.ctl({ sel: "#target" }), { willPress: false }));
      expect(scrolled).toBe(true);
      ctx.destroy();
    });

    it("never scrolls on desk", async () => {
      stageWithChrome();
      const target = document.getElementById("target");
      let scrolled = false;
      target.scrollIntoView = () => { scrolled = true; };
      const { clock, ctx } = stage();
      await playOut(clock, ctx.goto(ctx.ctl({ sel: "#target" }), { willPress: false }));
      expect(scrolled).toBe(false);
      ctx.destroy();
    });
  });

  describe("callout placement on the pocket (§3.2)", () => {
    function drawAnchor(box_) {
      document.body.innerHTML = '<div class="p-chrome"></div><div id="anchor"></div>';
      box(document.querySelector(".p-chrome"), { x: 0, y: 0, w: 390, h: 56 });
      box(document.getElementById("anchor"), box_);
    }

    it("resolves left/right to top or bottom, whichever has more room", async () => {
      /* An anchor near the very top: far more room below it than above. */
      drawAnchor({ x: 100, y: 60, w: 40, h: 40 });
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document, pocket: true });
      clock.setPlaying(true);
      const anchor = ctx.ctl({ sel: "#anchor" });
      await playOut(clock, ctx.callout("Hello.", anchor, "left"));
      const note = document.querySelector(".tourfilm-callout");
      /* bottom placement puts the box BELOW the anchor's point */
      expect(parseFloat(note.style.top)).toBeGreaterThan(100);
      ctx.destroy();
    });

    it("clamps horizontally to the pocket's own gutter, not CALLOUT_EDGE", async () => {
      drawAnchor({ x: 2, y: 400, w: 20, h: 20 }); /* hard against the left edge */
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document, pocket: true });
      clock.setPlaying(true);
      window.innerWidth = 390;
      const anchor = ctx.ctl({ sel: "#anchor" });
      await playOut(clock, ctx.callout("Hi.", anchor, "top"));
      const note = document.querySelector(".tourfilm-callout");
      expect(parseFloat(note.style.left)).toBeGreaterThanOrEqual(12); /* the 360-width gutter floor */
      ctx.destroy();
    });

    it("label callouts are 12px on the pocket, the kit's own floor", async () => {
      drawAnchor({ x: 100, y: 400, w: 40, h: 40 });
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document, pocket: true });
      clock.setPlaying(true);
      const anchor = ctx.ctl({ sel: "#anchor" });
      await playOut(clock, ctx.callout("Filed", anchor, "top", { label: true }));
      const note = document.querySelector(".tourfilm-callout");
      expect(note.style.cssText).toContain("12px");
      ctx.destroy();
    });
  });
});

/* ---- #1174: the pocket film on a real phone ------------------------------
   What broke on the owner's iPhone and what the fix promises, each pinned. */

describe("#1174: the chrome follows the page", () => {
  /** Fires the window's scroll listener and lets the sync frame run. */
  async function scrolled() {
    window.dispatchEvent(new window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  it("a lit control's ring moves with the control when the page scrolls under it", async () => {
    document.body.innerHTML = '<button class="save"></button>';
    const el = document.querySelector(".save");
    box(el, { x: 100, y: 600, w: 120, h: 44 });
    const { clock, ctx } = stage();
    await playOut(clock, ctx.goto(ctx.ctl({ sel: ".save" })));
    const ring = document.querySelector(".tourfilm-ring");
    expect(parseFloat(ring.style.top)).toBe(600);
    box(el, { x: 100, y: 200, w: 120, h: 44 }); /* the page scrolled 400px */
    await scrolled();
    expect(parseFloat(ring.style.top)).toBe(200);
  });

  it("a typed line stays over its field", async () => {
    document.body.innerHTML = '<input class="name">';
    const el = document.querySelector(".name");
    box(el, { x: 40, y: 500, w: 300, h: 44 });
    const { clock, ctx } = stage();
    await playOut(clock, ctx.typeInto(ctx.ctl({ sel: ".name" }), "Car"));
    const ghost = document.querySelector(".tourfilm-typed");
    expect(parseFloat(ghost.style.top)).toBe(500);
    box(el, { x: 40, y: 120, w: 300, h: 44 });
    await scrolled();
    expect(parseFloat(ghost.style.top)).toBe(120);
  });

  it("a callout pinned to a control stays on it", async () => {
    document.body.innerHTML = '<div class="row"></div>';
    const el = document.querySelector(".row");
    box(el, { x: 100, y: 500, w: 200, h: 60 });
    const { clock, ctx } = stage();
    const row = ctx.ctl({ sel: ".row" });
    const said = ctx.callout("Same law as the dial.", row, "bottom");
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advance(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const note = document.querySelector(".tourfilm-callout");
    const before = parseFloat(note.style.top);
    expect(before).toBeGreaterThanOrEqual(560);
    box(el, { x: 100, y: 300, w: 200, h: 60 });
    await scrolled();
    expect(parseFloat(note.style.top)).toBe(before - 200);
    await playOut(clock, said);
  });

  it("clear() puts the page back at the top, however the film left a chapter", () => {
    const { ctx } = stage();
    const calls = [];
    const scrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperty(window, "scrollY", { value: 197, configurable: true });
    const scrollTo = window.scrollTo;
    window.scrollTo = (options) => calls.push(options);
    ctx.clear();
    window.scrollTo = scrollTo;
    if (scrollY) Object.defineProperty(window, "scrollY", scrollY); else delete window.scrollY;
    expect(calls).toEqual([{ top: 0, behavior: "instant" }]);
  });

  it("the listeners go with destroy()", async () => {
    document.body.innerHTML = '<button class="save"></button>';
    const el = document.querySelector(".save");
    box(el, { x: 100, y: 600, w: 120, h: 44 });
    const { clock, ctx } = stage();
    await playOut(clock, ctx.goto(ctx.ctl({ sel: ".save" })));
    ctx.destroy();
    expect(() => window.dispatchEvent(new window.Event("scroll"))).not.toThrow();
    expect(document.querySelector(".tourfilm-ring")).toBeNull();
  });
});

describe("#1174: a ring belongs to an element", () => {
  it("a control left lit into a screen change is unlit once its element has left the document", async () => {
    document.body.innerHTML = '<button class="save"></button>';
    const el = document.querySelector(".save");
    box(el, { x: 100, y: 600, w: 120, h: 44 });
    const clock = createClock({ reducedMotion: () => false });
    let route = "/create";
    const ctx = createFilmContext({
      clock, doc: document,
      routeOf: () => route,
      navigate: async (to) => { route = to; document.body.innerHTML = '<div class="home"></div>'; },
    });
    clock.setPlaying(true);
    await playOut(clock, ctx.goto(ctx.ctl({ sel: ".save" })));
    expect(document.querySelectorAll(".tourfilm-ring")).toHaveLength(1);
    expect(ctx.lit()).toHaveLength(1);
    await ctx.setScreen("/home");
    expect(document.querySelectorAll(".tourfilm-ring")).toHaveLength(0);
    expect(ctx.lit()).toHaveLength(0);
    expect(el.style.transform).toBe(""); /* its inline style put back too */
  });

  it("a lit control still in the document keeps its ring across a screen change on the same page", async () => {
    document.body.innerHTML = '<svg class="dial"><g class="body"></g></svg>';
    box(document.querySelector(".body"), { x: 200, y: 160, w: 10, h: 10 });
    const clock = createClock({ reducedMotion: () => false });
    let route = "/home";
    const ctx = createFilmContext({ clock, doc: document, routeOf: () => route, navigate: async (to) => { route = to; } });
    clock.setPlaying(true);
    ctx.light(ctx.ctl({ sel: ".body" }));
    await ctx.setScreen("/item");
    expect(document.querySelectorAll(".tourfilm-ring")).toHaveLength(1);
  });
});

describe("#1174: unread() is the film's own Escape", () => {
  it("marks it tourfilm, as close() does, so the transport never takes it for the reader stopping the film", () => {
    document.body.innerHTML = '<div class="hit"></div>';
    const { ctx } = stage();
    const seen = [];
    const onKey = (event) => seen.push({ key: event.key, tourfilm: event.tourfilm === true });
    document.addEventListener("keydown", onKey, true);
    ctx.read(ctx.ctl({ sel: ".hit" }));
    ctx.unread();
    document.removeEventListener("keydown", onKey, true);
    expect(seen).toEqual([{ key: "Escape", tourfilm: true }]);
  });
});

describe("#1174: `visible` names only what a reader can see", () => {
  it("drops a match scrolled off the screen, one faded to nothing, and keeps the rest", () => {
    document.body.innerHTML = '<a class="msys" id="a"></a><a class="msys" id="b"></a><a class="msys" id="c"></a><a class="msys" id="d"></a>';
    window.innerWidth = 390;
    window.innerHeight = 844;
    box(document.getElementById("a"), { x: 16, y: 400, w: 150, h: 44 });
    box(document.getElementById("b"), { x: 300, y: 400, w: 150, h: 44 }); /* half off the right: seen */
    box(document.getElementById("c"), { x: 534, y: 400, w: 150, h: 44 }); /* wholly off: scenery */
    box(document.getElementById("d"), { x: 16, y: 500, w: 150, h: 44 });
    document.getElementById("d").style.opacity = "0";
    const { ctx } = stage();
    const all = ctx.ctl({ sel: ".msys", all: true, visible: true });
    expect(all.els.map((el) => el.id)).toEqual(["a", "b"]);
    const first = ctx.ctl({ sel: ".msys", visible: true });
    expect(first.els.map((el) => el.id)).toEqual(["a"]);
  });

  it("is a first-visible, not a first: an unseen first match yields to the first seen one", () => {
    document.body.innerHTML = '<a class="msys" id="a"></a><a class="msys" id="b"></a>';
    box(document.getElementById("a"), { x: -400, y: 400, w: 150, h: 44 });
    box(document.getElementById("b"), { x: 16, y: 400, w: 150, h: 44 });
    const { ctx } = stage();
    expect(ctx.ctl({ sel: ".msys", visible: true }).els.map((el) => el.id)).toEqual(["b"]);
  });

  it("still throws when nothing visible matches and the control is not optional", () => {
    document.body.innerHTML = '<a class="msys" id="a"></a>';
    box(document.getElementById("a"), { x: 1400, y: 400, w: 150, h: 44 }); /* past a 1280px screen */
    const { ctx } = stage();
    expect(() => ctx.ctl({ sel: ".msys", visible: true })).toThrow(TourControlMissing);
  });

  it("changes nothing without the flag", () => {
    document.body.innerHTML = '<a class="msys" id="a"></a><a class="msys" id="b"></a>';
    box(document.getElementById("a"), { x: 900, y: 400, w: 150, h: 44 });
    box(document.getElementById("b"), { x: 16, y: 400, w: 150, h: 44 });
    const { ctx } = stage();
    expect(ctx.ctl({ sel: ".msys", all: true }).els.map((el) => el.id)).toEqual(["a", "b"]);
  });
});

describe("#1174: a pinned callout keeps its side on the pocket", () => {
  function pocketStage() {
    setReducedMotion(false);
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document, pocket: true });
    clock.setPlaying(true);
    return { clock, ctx };
  }

  it("without `pin`, a top line with no room above flips under its anchor", async () => {
    document.body.innerHTML = '<header class="p-chrome"></header><div class="mdial"></div>';
    window.innerWidth = 390;
    window.innerHeight = 844;
    box(document.querySelector(".p-chrome"), { x: 0, y: 0, w: 390, h: 56 });
    box(document.querySelector(".mdial"), { x: 16, y: 56, w: 358, h: 358 });
    const { clock, ctx } = pocketStage();
    const dial = ctx.ctl({ sel: ".mdial", round: true });
    await playOut(clock, ctx.callout("Orbit reminds you, visually and through notifications.", dial, "top"));
    const note = document.querySelector(".tourfilm-callout");
    expect(parseFloat(note.style.top)).toBeGreaterThanOrEqual(414); /* under the dial */
  });

  it("with `pin`, it stays at the top, clamped under the chrome — round 8's toast position", async () => {
    document.body.innerHTML = '<header class="p-chrome"></header><div class="mdial"></div>';
    window.innerWidth = 390;
    window.innerHeight = 844;
    box(document.querySelector(".p-chrome"), { x: 0, y: 0, w: 390, h: 56 });
    box(document.querySelector(".mdial"), { x: 16, y: 56, w: 358, h: 358 });
    const { clock, ctx } = pocketStage();
    const dial = ctx.ctl({ sel: ".mdial", round: true });
    await playOut(clock, ctx.callout("Orbit reminds you, visually and through notifications.", dial, "top", { pin: true }));
    const note = document.querySelector(".tourfilm-callout");
    expect(parseFloat(note.style.top)).toBe(56 + 8);
    expect(note.querySelector("i").style.bottom).toBe("-8px"); /* the stem still points down, at the dial */
  });
});
