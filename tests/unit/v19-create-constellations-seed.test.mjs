// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { mountConstellations } from "../../web/src/lib/backdrops/constellations.js";

/*
 * #474/#475: the create screen's living backdrop takes its one seed from the
 * caller (`data.fixtures ? seedFromWorkspace(view.primary) : rollSeed()` on
 * the screen) and never rolls its own — every random draw in the module
 * comes from $lib/sky.js's shared streamFactory, addressed by that seed.
 * This is the ratchet on that contract: the same seed and galaxy must
 * produce the same arrangement every time (what the fidelity gate depends
 * on), and two different seeds must not collide by accident.
 *
 * Unlike the relay's satellites, this backdrop places everything in a fixed
 * 1600×1000 chart space (`preserveAspectRatio="xMidYMid slice"`) rather than
 * against real layout, so happy-dom's lack of a layout engine does not
 * matter here at all.
 */

const GALAXY = {
  "hh-lawson-1": { name: "Lawson Home", pos: [0, 0], planets: [], items: 6 },
  "hh-seaside-4551": {
    name: "Seaside Cottage", pos: [-617, -305], items: 3,
    planets: [[28, 10, 2.2, "--warm"], [-24, -8, 2, "--ok"], [-6, -26, 2.4, "--ok"]],
  },
  "hh-mumdad-2480": {
    name: "Mum & Dad’s", pos: [452, 522], items: 2,
    planets: [[19, 4, 2.2, "--ok"], [-27, -5, 2.4, "--ok"]],
  },
};

/** @type {(() => void)[]} */
const teardowns = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()?.();
});

/** @param {number} seed */
function arrangementFor(seed) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const teardown = mountConstellations(root, { seed, galaxy: GALAXY, primary: "hh-lawson-1" });
  teardowns.push(teardown);
  teardowns.push(() => root.remove());
  const html = root.innerHTML;
  teardown();
  root.remove();
  return html;
}

describe("the create backdrop's seeding contract", () => {
  it("draws the same arrangement from the same seed and galaxy", () => {
    const a = arrangementFor(424242);
    const b = arrangementFor(424242);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
  });

  it("draws a different arrangement from a different seed", () => {
    const a = arrangementFor(424242);
    const b = arrangementFor(99118822);
    expect(a).not.toBe(b);
  });

  it("never draws the primary household", () => {
    const html = arrangementFor(424242);
    expect(html).not.toContain("LAWSON HOME");
  });
});
