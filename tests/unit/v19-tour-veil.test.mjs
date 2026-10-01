// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOLE_MS, hideVeil, showVeil, veilTargets } from "../../web/src/lib/tour/veil.js";

/*
 * #866: the film's veil is a masked full-viewport overlay, not the old
 * emphasis.js mechanic (per-region opacity + a `.lit` class the product
 * already collides — home.css:495 and create.css:221). This pins the DOM
 * contract veil.js promises stops.js and the film: one overlay, mounted
 * once; holes that land on the right rect, including rounded ones; a
 * re-measure loop that follows a moving target and stops the instant
 * nothing is lit; and reduced motion skipping the fade without freezing the
 * holes in place.
 */

const OVERLAY_ID = "orbit-tour-veil";
const overlay = () => document.getElementById(OVERLAY_ID);

/** A frame is real wall time here (confirmed: happy-dom's requestAnimationFrame
 *  fires on real timers), so "wait a frame" is a short real sleep rather than
 *  a fake-timer advance. */
const frame = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function rect(el, box) {
  el.getBoundingClientRect = () => ({
    left: box.x, top: box.y, width: box.w, height: box.h,
    right: box.x + box.w, bottom: box.y + box.h, x: box.x, y: box.y, toJSON() {},
  });
}

/** Reads the overlay's current holes — the open ones, not one still
 *  closing — out of its inline SVG mask (#1174 round 3), so a test can
 *  assert on geometry without reaching into module internals. */
function holesOf() {
  const shapes = [...(overlay()?.querySelectorAll("mask .hole:not(.leaving)") ?? [])];
  return shapes.map((shape) => {
    const n = (name) => Number(shape.getAttribute(name));
    return shape.tagName.toLowerCase() === "circle"
      ? { kind: "circle", cx: n("cx"), cy: n("cy"), r: n("r") }
      : { kind: "rect", x: n("x"), y: n("y"), w: n("width"), h: n("height"), rx: n("rx") };
  });
}

/** The mask's whole markup, holes closing included. */
function maskMarkup() {
  return overlay()?.querySelector("mask")?.outerHTML ?? "";
}

function setReducedMotion(matches) {
  window.matchMedia = () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  setReducedMotion(false);
});

afterEach(() => {
  // Tear the overlay down instantly. With motion on, hideVeil() only starts
  // its 450ms fade timer, which can fire after Vitest has torn this file's
  // window down and surface as an uncaught ReferenceError in whichever file
  // the worker is running by then (fast, pipelines 1529 and 1535).
  setReducedMotion(true);
  hideVeil();
  setReducedMotion(false);
});

describe("mounting", () => {
  it("mounts one overlay on showVeil and removes it on hideVeil", async () => {
    expect(overlay()).toBeNull();
    showVeil();
    expect(overlay()).not.toBeNull();
    showVeil(); // idempotent: still exactly one node
    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);

    hideVeil();
    await frame(500); // past the fade
    expect(overlay()).toBeNull();
  });

  it("paints the overlay at the ratified 0.62 with the pack's own --bg token", () => {
    showVeil();
    expect(overlay().querySelector(".sheet").getAttribute("style")).toContain("var(--bg)");
    expect(overlay().style.opacity).toBe("0.62");
  });

  it("never blocks a click on the real control under a hole", () => {
    showVeil();
    expect(overlay().style.pointerEvents).toBe("none");
  });
});

describe("holes", () => {
  it("lands a rounded-rect hole on the target's padded rect", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 100, y: 200, w: 50, h: 30 });

    showVeil();
    veilTargets([{ el, pad: 5, radius: 12 }]);

    const [hole] = holesOf();
    expect(hole).toEqual({ kind: "rect", x: 95, y: 195, w: 60, h: 40, rx: 12 });
  });

  it("lands a circular hole centred on a round target", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 40, h: 40 });

    showVeil();
    veilTargets([{ el, round: true }]);

    const [hole] = holesOf();
    expect(hole).toEqual({ kind: "circle", cx: 20, cy: 20, r: 20 });
  });

  it("cuts one hole per target, in one mask", () => {
    const a = document.createElement("div"), b = document.createElement("div");
    document.body.append(a, b);
    rect(a, { x: 0, y: 0, w: 10, h: 10 });
    rect(b, { x: 50, y: 50, w: 10, h: 10 });

    showVeil();
    veilTargets([a, b], { round: true });

    expect(holesOf()).toHaveLength(2);
  });

  it("goes back to a plain sheet — no holes — when nothing is lit", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 10, h: 10 });

    showVeil();
    veilTargets([el]);
    expect(holesOf()).toHaveLength(1);

    veilTargets([]);
    expect(holesOf()).toHaveLength(0);
  });

  it("accepts a bare element and applies the shared defaults from options", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 10, y: 10, w: 20, h: 20 });

    showVeil();
    veilTargets([el], { round: true });

    expect(holesOf()).toEqual([{ kind: "circle", cx: 20, cy: 20, r: 10 }]);
  });
});

describe("the re-measure loop", () => {
  it("follows a target whose rect changes, and stops once nothing is lit", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 20, h: 20 });

    showVeil();
    veilTargets([el]);
    expect(holesOf()[0]).toMatchObject({ x: 0, y: 0 });

    // the target moves mid-travel, the way chapters 5/9/12's body does
    rect(el, { x: 40, y: 0, w: 20, h: 20 });
    await frame(120);
    expect(holesOf()[0]).toMatchObject({ x: 40, y: 0 });

    // it settles: the loop goes quiet on its own (no more moving to chase)
    const settledMask = maskMarkup();
    await frame(120);
    expect(maskMarkup()).toBe(settledMask);

    // and stops outright the instant nothing is lit
    veilTargets([]);
    const clearedMask = maskMarkup();
    rect(el, { x: 999, y: 999, w: 20, h: 20 }); // moves again, but it is no longer watched
    await frame(120);
    expect(maskMarkup().includes('x="999.0"')).toBe(false);
    expect(clearedMask.includes('x="999.0"')).toBe(false);
  });

  it("re-measures on a resize even with nothing animating", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 20, h: 20 });

    showVeil();
    veilTargets([el]);
    rect(el, { x: 7, y: 7, w: 20, h: 20 });
    window.dispatchEvent(new Event("resize"));

    expect(holesOf()[0]).toMatchObject({ x: 7, y: 7 });
  });

  it("re-measures on a scroll even with nothing animating", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 20, h: 20 });

    showVeil();
    veilTargets([el]);
    rect(el, { x: 0, y: 33, w: 20, h: 20 });
    window.dispatchEvent(new Event("scroll"));

    expect(holesOf()[0]).toMatchObject({ y: 33 });
  });
});

describe("#1174 round 3: no image to decode, no hole snapping", () => {
  it("cuts its holes in an inline SVG mask, never a CSS mask-image the engine must load", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 20, h: 20 });
    showVeil();
    veilTargets([el]);
    expect(overlay().style.maskImage ?? "").toBe("");
    expect(overlay().style.webkitMaskImage ?? "").toBe("");
    expect(overlay().querySelector(".sheet").getAttribute("mask")).toBe("url(#orbit-tour-veil-mask)");
    expect(holesOf()).toHaveLength(1);
  });

  it("opens a hole on a fade and closes it on one, rather than in one frame", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 20, h: 20 });
    showVeil();
    veilTargets([el]);
    const shape = overlay().querySelector("mask .hole");
    expect(shape.style.transition).toContain("fill-opacity");
    expect(shape.style.fillOpacity).toBe("1");

    veilTargets([]);
    expect(holesOf()).toHaveLength(0);
    expect(shape.isConnected).toBe(true); /* still there, closing */
    expect(shape.classList.contains("leaving")).toBe(true);
    expect(shape.style.fillOpacity).toBe("0");
    await frame(HOLE_MS + 80);
    expect(shape.isConnected).toBe(false);
  });

  it("re-opens a hole still closing instead of cutting a second one", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 20, h: 20 });
    showVeil();
    veilTargets([el]);
    veilTargets([]);
    veilTargets([el]);
    expect(holesOf()).toHaveLength(1);
  });

  it("keeps the same hole for an element that stays lit while others come and go", () => {
    const a = document.createElement("div"), b = document.createElement("div");
    document.body.append(a, b);
    rect(a, { x: 0, y: 0, w: 10, h: 10 });
    rect(b, { x: 50, y: 50, w: 10, h: 10 });
    showVeil();
    veilTargets([a]);
    const first = overlay().querySelector("mask .hole");
    veilTargets([a, b]);
    expect(overlay().querySelector("mask .hole")).toBe(first);
    expect(holesOf()).toHaveLength(2);
  });
});

describe("reduced motion", () => {
  it("skips the fade — opacity lands immediately, no transition", () => {
    setReducedMotion(true);
    showVeil();
    expect(overlay().style.transition).toBe("none");
    expect(overlay().style.opacity).toBe("0.62");
  });

  it("still moves the holes under reduced motion", () => {
    setReducedMotion(true);
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 10, h: 10 });

    showVeil();
    veilTargets([el]);
    expect(holesOf()[0]).toMatchObject({ x: 0, y: 0 });

    rect(el, { x: 12, y: 0, w: 10, h: 10 });
    veilTargets([el]); // a stop re-issuing the same target after a jump, not a tween
    expect(holesOf()[0]).toMatchObject({ x: 12, y: 0 });
  });

  it("opens and closes holes at once, with nothing left closing", () => {
    setReducedMotion(true);
    const el = document.createElement("div");
    document.body.appendChild(el);
    rect(el, { x: 0, y: 0, w: 10, h: 10 });
    showVeil();
    veilTargets([el]);
    expect(overlay().querySelector("mask .hole").style.transition).toBe("");
    veilTargets([]);
    expect(overlay().querySelectorAll("mask .hole")).toHaveLength(0);
  });

  it("removes the overlay immediately on hide, with no fade to wait out", () => {
    setReducedMotion(true);
    showVeil();
    expect(overlay()).not.toBeNull();
    hideVeil();
    expect(overlay()).toBeNull();
  });
});
