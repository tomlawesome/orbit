import { afterEach, describe, expect, it, vi } from "vitest";

import { FIT_MS, frameCost, sayVerdict } from "$lib/flight/fitness.js";

/*
 * #1253: whether this machine can draw the flight's world is judged on warm
 * frames, by their median -- never on one cold frame.
 *
 * On the owner's Windows/Firefox machine with a real GPU a sign-in flew the
 * old canvas flight: the one timed frame came straight after the drawing was
 * resized, so it carried the driver's last shader work, the pictures' upload
 * and the render targets' allocation, which on Firefox (ANGLE, no parallel
 * compile) runs past 30ms on its own.
 */

/** A GL whose frames cost what `costs` says, in order, on a fake clock. */
function stubGl(costs) {
  let t = 0;
  const syncs = [];
  const gl = { RGBA: 1, UNSIGNED_BYTE: 2, readPixels: vi.fn((x, y, w, h) => syncs.push([x, y, w, h])) };
  const draw = vi.fn(() => { t += costs.shift() ?? 0; });
  return { gl, draw, now: () => t, syncs };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the flight world's frame check (#1253)", () => {
  it("does not time the cold frames: two slow first frames, then quick ones, is fit", () => {
    const { gl, draw, now, syncs } = stubGl([95, 60, 6, 7, 5, 6, 8]);
    expect(frameCost(gl, draw, { now })).toEqual({ fit: true, ms: 6 });
    /* each warm frame was finished (synced) before any was timed */
    expect(syncs.slice(0, 2)).toEqual([[0, 0, 1, 1], [0, 0, 1, 1]]);
  });

  it("one hitch among quick frames is not a slow machine", () => {
    const { gl, draw, now } = stubGl([0, 0, 6, 48, 7, 5]);
    expect(frameCost(gl, draw, { now })).toEqual({ fit: true, ms: 6 });
  });

  it("a GPU slow on every warm frame is unfit, and the median says by how much", () => {
    const { gl, draw, now } = stubGl([0, 0, 41, 44, 40, 43, 42]);
    const verdict = frameCost(gl, draw, { now });
    expect(verdict.fit).toBe(false);
    expect(verdict.ms).toBe(41);
  });

  it("stops timing as soon as most frames have agreed", () => {
    const fit = stubGl([0, 0, 5, 6, 7, 99, 99]);
    frameCost(fit.gl, fit.draw, { now: fit.now });
    expect(fit.draw).toHaveBeenCalledTimes(2 + 3);
    const slow = stubGl([0, 0, 50, 51, 52, 1, 1]);
    frameCost(slow.gl, slow.draw, { now: slow.now });
    expect(slow.draw).toHaveBeenCalledTimes(2 + 3);
  });

  it("the budget is the line: a median of exactly FIT_MS is fit", () => {
    const { gl, draw, now } = stubGl([0, 0, FIT_MS, FIT_MS, FIT_MS]);
    expect(frameCost(gl, draw, { now }).fit).toBe(true);
  });

  it("a frame that throws is unfit", () => {
    const gl = { RGBA: 1, UNSIGNED_BYTE: 2, readPixels: () => { throw new Error("context lost"); } };
    expect(frameCost(gl, () => {}, { now: () => 0 })).toEqual({ fit: false, ms: Infinity });
  });

  it("says its verdict in one console line", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    sayVerdict("on (frame 6 ms)");
    expect(info).toHaveBeenCalledWith("orbit · flight world: on (frame 6 ms)");
  });
});
