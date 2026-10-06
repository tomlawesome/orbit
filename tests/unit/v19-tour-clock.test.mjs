// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { CANCEL, createClock, frameDelta } from "../../web/src/lib/tour/clock.js";

/*
 * #866: the one-take film is a coroutine hanging off one pausable budget,
 * and every promise the chapters make is this clock's. What is pinned here
 * is the handful of properties the rest of the film assumes:
 *
 *  1. a wait resolves when FILM time reaches its mark, not when wall time
 *     does — and while paused, never;
 *  2. `sched` does not drift: a frame that overshoots its mark is not
 *     charged for twice, because across 3:41 that compounds into a chapter;
 *  3. round 5's ratified rule — reading time is not motion — so `w()`
 *     collapses under reduced motion and `hold()` does not. The film
 *     measures 3:41 and 2:07 entirely because of this one split;
 *  4. the dry run measures the same budget the film plays, which is what
 *     lets the transport put a tick where a chapter really starts;
 *  5. cancelling unwinds a suspended chapter through its own awaits rather
 *     than leaving it hanging.
 */

/** Lets any pending microtask settle between frames. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs the clock until `promise` settles, and reports the film time spent. */
async function playOut(clock, promise, step = 100, cap = 600000) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  let spent = 0;
  while (!done && spent < cap) {
    clock.advance(step);
    spent += step;
    await settle();
  }
  return spent;
}

const still = () => createClock({ reducedMotion: () => true });
const moving = () => createClock({ reducedMotion: () => false });

describe("film time", () => {
  it("resolves a wait when the cursor reaches its mark, and not before", async () => {
    const clock = moving();
    clock.setPlaying(true);
    let landed = false;
    const waiting = clock.wait(500).then(() => { landed = true; });

    clock.advance(100);
    await settle();
    expect(landed).toBe(false);

    clock.advance(100);
    await settle();
    expect(landed).toBe(false);

    clock.advance(300);
    await settle();
    await waiting;
    expect(landed).toBe(true);
  });

  it("holds the reading dead still while paused, and continues it on resume", async () => {
    const clock = moving();
    clock.setPlaying(true);
    let landed = false;
    const waiting = clock.wait(400).then(() => { landed = true; });

    clock.advance(200);
    await settle();
    clock.setPlaying(false);

    /* three seconds of frames, as round 5's own headless check pauses for */
    for (let k = 0; k < 30; k++) clock.advance(100);
    await settle();
    expect(landed).toBe(false);
    expect(clock.cursor()).toBe(200);

    clock.setPlaying(true);
    clock.advance(200);
    await settle();
    await waiting;
    expect(landed).toBe(true);
  });

  it("never lets a frame's overshoot accumulate into drift", async () => {
    const clock = moving();
    clock.setPlaying(true);
    /* Ten 100ms waits, advanced in clumsy 70ms frames: the film must end on
       exactly 1000ms of schedule however badly the frames line up. */
    const chain = (async () => {
      for (let k = 0; k < 10; k++) await clock.wait(100);
    })();
    await playOut(clock, chain, 70);
    expect(clock.sched()).toBe(1000);
  });

  it("does not advance while stalled on something the dry run could not budget", async () => {
    const clock = moving();
    clock.setPlaying(true);
    const release = clock.stall();
    clock.advance(500);
    expect(clock.cursor()).toBe(0);
    release();
    clock.advance(500);
    expect(clock.cursor()).toBe(500);
  });

  it("believes no real frame longer than 120ms, so a backgrounded tab skips nothing", () => {
    /* The clamp belongs to the frame loop, which is the only thing that sees
       real timestamps; `advance` itself moves film time by exactly what it
       is given, which is how the tests above drive the film in clean steps. */
    expect(frameDelta(9000, 1)).toBe(120);
    expect(frameDelta(17, 1)).toBe(16);
    expect(frameDelta(17, 0)).toBe(0);
  });
});

describe("reduced motion", () => {
  it("spends nothing on movement and the full length on reading", () => {
    const clock = still();
    clock.dryStart();
    clock.w(1000);
    expect(clock.dryEnd()).toBe(0);

    clock.dryStart();
    clock.hold(2400);
    expect(clock.dryEnd()).toBe(2400);
  });

  it("holds a callout for exactly as long in either mode", () => {
    const budgets = [moving(), still()].map((clock) => {
      clock.dryStart();
      clock.hold(3050);
      return clock.dryEnd();
    });
    expect(budgets[0]).toBe(budgets[1]);
  });

  it("shortens a film that is part movement and part reading", () => {
    const film = (clock) => {
      clock.dryStart();
      clock.w(500);
      clock.hold(2400);
      clock.w(300);
      return clock.dryEnd();
    };
    expect(film(moving())).toBe(3200);
    expect(film(still())).toBe(2400);
  });
});

describe("the dry run", () => {
  it("measures without waiting, so twelve chapters cost microtasks", async () => {
    const clock = moving();
    clock.dryStart();
    /* Never advanced, never played: in dry mode a wait is already resolved. */
    await clock.wait(60000);
    await clock.wait(60000);
    expect(clock.dryEnd()).toBe(120000);
    expect(clock.cursor()).toBe(0);
  });

  it("lands a tween on its end state at once", async () => {
    const clock = moving();
    clock.dryStart();
    const seen = [];
    await clock.tween(400, (t) => seen.push(t));
    expect(seen).toEqual([1]);
    expect(clock.dryEnd()).toBe(400);
  });
});

describe("cancelling", () => {
  it("unwinds a suspended chapter through its own awaits", async () => {
    const clock = moving();
    clock.setPlaying(true);
    let reached = false;
    let caught = null;
    const chapter = (async () => {
      try {
        await clock.wait(1000);
        reached = true;
      } catch (error) {
        caught = error;
      }
    })();

    clock.advance(100);
    await settle();
    clock.cancel();
    await chapter;

    expect(caught).toBe(CANCEL);
    expect(reached).toBe(false);
  });

  it("leaves a fresh wait working after the cancel", async () => {
    const clock = moving();
    clock.setPlaying(true);
    clock.wait(1000).catch(() => {});
    clock.cancel();

    let landed = false;
    const waiting = clock.wait(100).then(() => { landed = true; });
    clock.advance(100);
    await settle();
    await waiting;
    expect(landed).toBe(true);
  });
});
