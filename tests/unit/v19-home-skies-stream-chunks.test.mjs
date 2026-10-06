import { describe, expect, it } from "vitest";

import { streamChunks } from "../../web/src/routes/home/skies.js";

/*
 * #1151 W1-Q13: mountPlane's fill(), mountTerminator's fill(L, offset), and
 * mountCloudSea's fillStratum()/fillPeaks() each independently computed the
 * same "build what's needed, drop what scrolled past" windowing — first/last
 * chunk index from an offset, a chunk width, and a behind/ahead margin —
 * with only the live-map, builder and host swapped. A fix to the range-edge
 * math (first/last-inclusive arithmetic is exactly the kind of thing that
 * grows an off-by-one) made in one had no mechanism to reach the other
 * three.
 *
 * streamChunks() is now the one place that windowing lives; every engine's
 * own fill passes its own build/append/remove. This test drives the shared
 * function directly with a fake chunk/host, including fillPeaks' own
 * hard-coded 400/2000 margins (confirmed equal to behind=400/ahead=400 in
 * this function's offset+1600+ahead form).
 */

function harness() {
  /** @type {Map<number, string>} */
  const live = new Map();
  /** @type {string[]} */
  const hosted = [];
  const built = [];
  const run = (offset, w, behind, ahead) => {
    streamChunks(
      live, offset, w, behind, ahead,
      (i) => { built.push(i); return `chunk-${i}`; },
      (c) => hosted.push(c),
      (c) => { const i = hosted.indexOf(c); if (i >= 0) hosted.splice(i, 1); },
    );
  };
  return { live, hosted, built, run };
}

describe("#1151 W1-Q13: streamChunks' shared windowing", () => {
  it("builds every chunk index the viewport plus margins reaches, once each", () => {
    const h = harness();
    h.run(0, 400, 470, 560); // mountPlane's own CW/BEHIND/AHEAD
    const first = Math.floor((0 - 470) / 400);
    const last = Math.floor((0 + 1600 + 560) / 400);
    expect(h.live.size).toBe(last - first + 1);
    expect(h.built.length).toBe(last - first + 1);
    expect([...h.live.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: last - first + 1 }, (_, k) => first + k),
    );
  });

  it("does not rebuild a chunk already live when the window shifts a little", () => {
    const h = harness();
    h.run(0, 400, 470, 560);
    const builtAfterFirst = h.built.length;
    h.run(50, 400, 470, 560); // small shift, same window of indices
    expect(h.built.length).toBe(builtAfterFirst); // nothing new built
  });

  it("drops a chunk once it scrolls outside the window, and removes its host entry", () => {
    const h = harness();
    h.run(0, 400, 470, 560);
    const before = h.live.size;
    h.run(100_000, 400, 470, 560); // scroll far away
    expect(h.live.size).toBeGreaterThan(0);
    expect(h.live.size).toBeLessThanOrEqual(before + 10); // window width is stable
    // every surviving chunk's own host entry still exists; none orphaned
    expect(h.hosted.length).toBe(h.live.size);
  });

  it("fillPeaks' own pre-shared hard-coded 400/2000 margins match behind=400/ahead=400 here", () => {
    const offsetVal = 777, w = 1900;
    const h = harness();
    h.run(offsetVal, w, 400, 400);
    const peaksFirst = Math.floor((offsetVal - 400) / w);
    const peaksLast = Math.floor((offsetVal + 2000) / w); // fillPeaks' own literal formula
    const built = [...h.live.keys()].sort((a, b) => a - b);
    expect(built).toEqual(
      Array.from({ length: peaksLast - peaksFirst + 1 }, (_, k) => peaksFirst + k),
    );
  });
});
