import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { journeyClock } from "../../web/src/lib/flight/journey-clock.js";

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
});
