import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { journeyClock, WORLD_WAIT } from "../../web/src/lib/flight/journey-clock.js";

/*
 * #1262: the descent keeps time.
 *
 * The journey's clock (journey-clock.js, #1253) counts a stall as a frame
 * or so while `stalls(true)` is set, which the climb wants: a slow frame
 * pauses the climb rather than skipping it ahead. The climb sets it at its
 * warp and nothing cleared it, so a sign-out later on the same page ran its
 * whole descent on that capped clock, and over a slowly drawn world the
 * farewell (5.35s) came many seconds late, or not before the reader gave
 * up. On dev the descent ran on plain timers and always kept its time.
 *
 * A beat that throws must not take the beats after it down either: the
 * clock runs them from one frame loop, where dev's plain timers were each
 * their own.
 */

/** A page whose frames each take `ms` of real time. */
function slowPage(ms) {
  let now = 0;
  /** @type {Array<() => void>} */
  let queued = [];
  const env = {
    now: () => now,
    frame: (fn) => { queued.push(fn); return queued.length; },
    cancelFrame: () => {},
  };
  /** run frames until `until` real ms have passed */
  const run = (until) => {
    while (now < until && queued.length) {
      now += ms;
      const due = queued; queued = [];
      for (const fn of due) fn();
    }
  };
  return { env, run, get now() { return now; } };
}

/** schedule the farewell and say when (in real ms) it fired */
function farewellAt(clock, page) {
  let fired = null;
  clock.schedule(() => { fired = page.now; }, 5350);
  page.run(60_000);
  return fired;
}

describe("#1262: the journey clock and the descent", () => {
  it("capped (the climb's setting), slow frames stretch a journey", () => {
    const page = slowPage(200);
    const clock = journeyClock(page.env);
    clock.stalls(true);
    expect(farewellAt(clock, page)).toBeGreaterThan(15_000);
  });

  it("uncapped, the same frames keep the journey's time", () => {
    const page = slowPage(200);
    const clock = journeyClock(page.env);
    clock.stalls(true);
    clock.stalls(false);
    expect(farewellAt(clock, page)).toBeLessThanOrEqual(5350 + 200);
  });

  it("a beat that throws does not stop the beats after it", () => {
    const page = slowPage(16);
    const clock = journeyClock(page.env);
    const seen = [];
    clock.schedule(() => { throw new Error("a broken beat"); }, 100);
    clock.schedule(() => seen.push("dusk"), 3600);
    clock.schedule(() => seen.push("farewell"), 5350);
    const errors = [];
    const was = globalThis.reportError;
    globalThis.reportError = (e) => errors.push(e);
    try { page.run(10_000); } finally { globalThis.reportError = was; }
    expect(seen).toEqual(["dusk", "farewell"]);
    expect(errors.map(String)).toEqual(["Error: a broken beat"]);
  });

  it("the descent keeps time: it never turns the stall cap on", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../../web/src/lib/flight/Flight.svelte"), "utf8");
    const descent = src.slice(src.indexOf("function descentStep("), src.indexOf("/** Clear everything this component"));
    expect(descent).not.toMatch(/clock\.stalls\(activeEngine\(\)\.drawingWorld\)/u);
    const descend = src.slice(src.indexOf("export function descend("));
    expect(descend).toMatch(/clock\.stalls\(false\)/u);
  });

  it("#1299: a hold waits eight seconds for the world at most, and the climb says so", () => {
    expect(WORLD_WAIT).toBe(8000);
    const src = readFileSync(resolve(import.meta.dirname, "../../web/src/lib/flight/Flight.svelte"), "utf8");
    expect(src).toMatch(/clock\.holdAt\([^;]*WORLD_WAIT\)/u);
  });

  it("#1222: a hold lets go by itself when its cap passes, the world ready or not", async () => {
    vi.useFakeTimers();
    try {
      const page = slowPage(16);
      const clock = journeyClock(page.env);
      let fired = null;
      clock.holdAt(500, new Promise(() => {}), 300);
      clock.schedule(() => { fired = page.now; }, 800);
      await vi.advanceTimersByTimeAsync(300);
      page.run(10_000);
      expect(fired).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  /**
   * #1299 (owner, 2026-10-07): Firefox's world needs about 2.1 s to ready,
   * so the climb waits up to 8 s for it, counted from when the journey
   * reaches the hold rather than from when the hold was set.
   * Frames of 16 ms; real timers and the world's promise follow the page's
   * clock, which stops once nothing is left to draw.
   */
  async function flyTo(clock, page, { readyAt = Infinity, until = 20_000 } = {}) {
    /** @type {() => void} */
    let ready = () => {};
    const world = new Promise((resolve) => { ready = () => resolve(undefined); });
    return { world, async run() {
      for (let frames = 0; frames < until / 16; frames++) {
        await vi.advanceTimersByTimeAsync(16);
        if (page.now + 16 >= readyAt) ready();
        await Promise.resolve();
        page.run(page.now + 16);
      }
    } };
  }

  it("#1299: a hold reached at T with the world ready at T+2.1 s still flies the world", async () => {
    vi.useFakeTimers();
    try {
      const page = slowPage(16);
      const clock = journeyClock(page.env);
      const flight = await flyTo(clock, page, { readyAt: 1000 + 2100, until: 6000 });
      let warp = null;
      clock.holdAt(1000, flight.world, WORLD_WAIT);
      clock.schedule(() => { warp = page.now; }, 1010);
      await flight.run();
      expect(warp).not.toBeNull();
      expect(warp).toBeGreaterThanOrEqual(3100);
    } finally { vi.useRealTimers(); }
  });

  it("#1299: the cap counts from the hold, not from when it was set", async () => {
    vi.useFakeTimers();
    try {
      const page = slowPage(16);
      const clock = journeyClock(page.env);
      const flight = await flyTo(clock, page, { until: 16_000 });
      let warp = null;
      clock.holdAt(5000, flight.world, WORLD_WAIT);
      clock.schedule(() => { warp = page.now; }, 5010);
      await flight.run();
      expect(warp).not.toBeNull();
      expect(warp).toBeGreaterThanOrEqual(5000 + WORLD_WAIT);
      expect(warp).toBeLessThan(5000 + WORLD_WAIT + 100);
    } finally { vi.useRealTimers(); }
  });
});
