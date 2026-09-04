// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { mountStation } from "../../web/src/lib/backdrops/station.js";

/*
 * #472/#475: administration's station backdrop takes its one seed from the
 * caller (`data.fixtures ? seedFromWorkspace(primary) : rollSeed()` on the
 * screen) and never rolls its own — every random draw in the module comes
 * from $lib/sky.js's shared streamFactory, addressed by that seed. This is
 * the ratchet on that contract: the same seed, galaxy and facts must produce
 * the same arrangement every time (what the fidelity gate depends on), and a
 * different seed must not collide by accident.
 *
 * Like the create backdrop, this module places the sky and the households in
 * a fixed 1600×1000 chart space and the station's own slot geometry — never
 * against real layout — so happy-dom's lack of a layout engine does not
 * matter here at all. `document.fonts` is also absent in happy-dom, which is
 * what lets `mountStation` build synchronously below (the module's own
 * `else boot()` branch, the same one constellations.js and satellites.js
 * fall back to under test).
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
const FACTS = { domain: "in.lawson-home.orbit", systems: 5, crew: 5 };

/** @type {(() => void)[]} */
const teardowns = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()?.();
});

/** @param {number} seed */
function arrangementFor(seed) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const teardown = mountStation(root, { seed, galaxy: GALAXY, primary: "hh-lawson-1", facts: FACTS });
  teardowns.push(teardown);
  teardowns.push(() => root.remove());
  const html = root.innerHTML;
  teardown();
  root.remove();
  return html;
}

describe("the station backdrop's seeding contract", () => {
  it("draws the same arrangement from the same seed, galaxy and facts", () => {
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

  it("captions the station with the caller's real facts, not the sheet's literals", () => {
    const html = arrangementFor(424242);
    expect(html).toContain("THE PLATFORM · IN.LAWSON-HOME.ORBIT");
    expect(html).toContain("5 SYSTEMS ABOARD · 5 CREW");
    /* §15-2g: join requests are a household-management fact, never an
       admin one — the caption must not invent one. */
    expect(html).not.toContain("JOIN REQUEST");
  });

  it("tears down everything it mounted", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const teardown = mountStation(root, { seed: 424242, galaxy: GALAXY, primary: "hh-lawson-1", facts: FACTS });
    expect(root.innerHTML.length).toBeGreaterThan(0);
    teardown();
    expect(root.innerHTML).toBe("");
    root.remove();
  });
});
