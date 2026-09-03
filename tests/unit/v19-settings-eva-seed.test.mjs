// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { mountEva } from "../../web/src/lib/backdrops/eva.js";

/*
 * #472: settings' EVA hull backdrop takes its one seed from the caller
 * (`data.fixtures ? seedFromWorkspace(primary) : rollSeed()` on the screen)
 * and never rolls its own — every random draw in the module comes from
 * $lib/sky.js's shared streamFactory, addressed by that seed. This is the
 * ratchet on that contract: the same seed and galaxy must produce the same
 * arrangement every time (what the fidelity gate depends on), and a
 * different seed must not collide by accident.
 *
 * UNLIKE the station and constellations backdrops, this one measures REAL
 * layout — the hull's geometry comes from `[data-nomen]` elements'
 * `getBoundingClientRect()`, because the whole conceit is a hatch standing
 * exactly where its panel already is. happy-dom has no layout engine, so
 * every rect it reports is zeroed; the hull still resolves to a fixed,
 * degenerate-but-deterministic geometry from those zeros plus `window`'s own
 * stub dimensions; two runs with the same seed still have to agree byte for
 * byte, and that is what this test holds. `document.fonts` is also absent in
 * happy-dom, which is what lets `mountEva` build synchronously below (the
 * module's own `else boot()` branch, the same one station.js,
 * constellations.js and satellites.js fall back to under test).
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

/** One panel, the shape the real settings page renders (`[data-nomen]`). */
function addPanel(/** @type {HTMLElement} */ root, /** @type {string} */ nomen, /** @type {string} */ sub, /** @type {number} */ hinge) {
  const el = document.createElement("section");
  el.className = "card";
  el.dataset.nomen = nomen;
  el.dataset.sub = sub;
  el.dataset.hinge = String(hinge);
  root.appendChild(el);
  return el;
}

/** @type {(() => void)[]} */
const teardowns = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()?.();
});

/** @param {number} seed */
function arrangementFor(seed) {
  const page = document.createElement("div");
  document.body.appendChild(page);
  addPanel(page, "PANEL A-01 · YOU", "CREW ID · EMU 3005", -1);
  addPanel(page, "PANEL A-02 · YOUR SKY", "OPTICS BAY · TORQUE 12 N·m", -1);
  addPanel(page, "PANEL B-01 · REMINDERS", "CAUTION & WARNING", -1);
  addPanel(page, "PANEL B-02 · YOUR RELAY", "S-BAND · TDRS", 1);
  addPanel(page, "PANEL C-01 · YOUR SYSTEMS", "DOCKED ELEMENTS · 5", -1);
  const airlock = addPanel(page, "QUEST · JOINT AIRLOCK", "CREW LOCK · HATCH A/L 1", -1);
  airlock.id = "airlock";

  const root = document.createElement("div");
  document.body.appendChild(root);
  const teardown = mountEva(root, { seed, galaxy: GALAXY, primary: "hh-lawson-1" });
  teardowns.push(teardown);
  teardowns.push(() => { root.remove(); page.remove(); });
  const html = root.innerHTML;
  teardown();
  root.remove();
  page.remove();
  return html;
}

describe("the EVA hull backdrop's seeding contract", () => {
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

  it("stencils every panel's own nomenclature onto the hull", () => {
    const html = arrangementFor(424242);
    expect(html).toContain("PANEL A-01 · YOU");
    expect(html).toContain("PANEL C-01 · YOUR SYSTEMS");
    expect(html).toContain("QUEST · JOINT AIRLOCK");
  });

  it("tears down everything it mounted", () => {
    const page = document.createElement("div");
    document.body.appendChild(page);
    addPanel(page, "PANEL A-01 · YOU", "CREW ID · EMU 3005", -1);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const teardown = mountEva(root, { seed: 424242, galaxy: GALAXY, primary: "hh-lawson-1" });
    expect(root.innerHTML.length).toBeGreaterThan(0);
    teardown();
    expect(root.innerHTML).toBe("");
    root.remove();
    page.remove();
  });
});
