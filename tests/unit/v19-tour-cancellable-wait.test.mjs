// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { CANCEL, createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";
import timeRuns from "../../web/src/lib/tour/chapters/05-time-runs.js";

/*
 * #1151 W3-R1/W3-R2: `clock.cancel()` — what a jump or Stop fires — only
 * ever settles waits booked through `clock.wait()`. `setScreen`'s own
 * `navigate()`/`settle()` are real promises the clock has never heard of,
 * so a chapter suspended on one of them used to keep running after the
 * reader had already moved on, racing whatever chapter started next
 * (W3-R2) — and, for chapter 5, keeping its demo dot drawn on the real
 * star chart for as long as that race took to resolve on its own (W3-R1,
 * reproduced below against the real chapter and the real clock, the way
 * v19-tour-chapter-time-runs.test.mjs already drives both).
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function rect(x, y, w, h) {
  return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} };
}

function drawHome() {
  document.body.innerHTML = '<div class="hero"><svg class="dial" viewBox="0 0 380 380"></svg></div>';
  window.SVGElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("dial") ? rect(390, 150, 500, 500) : rect(0, 0, 0, 0);
  };
}

describe("#1151 W3-R2: a real navigation is cancellable", () => {
  it("rejects setScreen with CANCEL if clock.cancel() fires while it is suspended on navigate()", async () => {
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    /** @type {() => void} */
    let resolveNavigate = () => {};
    const ctx = createFilmContext({
      clock,
      doc: document,
      routeOf: () => "/create",
      navigate: () => new Promise((res) => { resolveNavigate = () => res(undefined); }),
      settle: async () => {},
    });
    clock.setPlaying(true);

    const settled = ctx.setScreen("/home");
    let outcome = null;
    settled.then(() => { outcome = "resolved"; }, (error) => { outcome = error; });

    /* A jump or Stop, mid-navigation: today's bug is that nothing here
       notices. */
    clock.cancel();
    await settle();
    expect(outcome).toBe(CANCEL);

    /* The navigation finishing late, after the reader has moved on, must
       not resurrect the old chapter's wait. */
    resolveNavigate();
    await settle();
    expect(outcome).toBe(CANCEL);
  });

  it("still resolves normally when nothing cancels it", async () => {
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    let route = "/create";
    const ctx = createFilmContext({
      clock, doc: document, routeOf: () => route,
      navigate: async (to) => { route = to; },
      settle: async () => {},
    });
    clock.setPlaying(true);
    await expect(ctx.setScreen("/home")).resolves.toBeUndefined();
    expect(route).toBe("/home");
  });
});

describe("#1151 W3-R1: an interrupted chapter 5 does not leave its demo dot behind", () => {
  it("removes .tourfilm-time-body when cancelled mid-chapter", async () => {
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document, routeOf: () => "/home" });
    clock.setPlaying(true);

    const played = timeRuns.play(ctx);
    let outcome = null;
    played.then(() => { outcome = "resolved"; }, (error) => { outcome = error; });

    /* Far enough in that the demo body has been drawn (it is drawn before
       the chapter's own first `await w(LEAD_MS)`), nowhere near finishing
       the walk. */
    await settle();
    expect(document.querySelector(".tourfilm-time-body")).not.toBeNull();

    /* The reader jumps or stops here. */
    clock.cancel();
    await settle();

    expect(outcome).toBe(CANCEL);
    expect(document.querySelector(".tourfilm-time-body")).toBeNull();
  });
});
