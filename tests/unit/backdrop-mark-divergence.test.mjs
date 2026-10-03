// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

/*
 * #1151 W1-Q2: station.js (administration) and constellations.js (create)
 * each carry their own copy of the household-mark and constellation-figure
 * drawing -- the same shapes, the same element structure, independently
 * tuned. This mounts both with a handful of seeds (the chunk roll decides
 * whether a mark lands in the very first window, so this tries several
 * until both land) and reads the household ring's own stroke-width and
 * stroke-dasharray, and the figure label's own font-size, straight off the
 * rendered SVG.
 */

const FIGURE_NAMES = ["CASSIOPEIA", "CYGNUS", "LYRA", "PERSEUS", "ANDROMEDA", "VELA"];

const GALAXY = {
  h1: { name: "Household One", pos: [0.6, 0.8], planets: [[0, 0, 4, "--chart-ink"]], items: 2 },
};

/** @param {SVGElement | null} root */
function householdRing(root) {
  return root?.querySelector('circle[r="50"]') ?? null;
}

/** @param {SVGElement | null} root */
function figureLabel(root) {
  if (!root) return null;
  for (const text of root.querySelectorAll("text")) {
    if (FIGURE_NAMES.includes(text.textContent ?? "")) return text;
  }
  return null;
}

/**
 * Mounts with seeds until both a household ring and a figure label have
 * appeared in the same mount, or gives up. Each attempt gets a fresh root
 * and is torn down before the next, same as a real screen never keeps two
 * backdrops alive at once.
 * @param {(root: HTMLElement, args: any) => () => void} mount
 * @param {(seed: number) => any} argsFor
 */
function findMarks(mount, argsFor) {
  for (let seed = 1; seed <= 80; seed++) {
    const root = document.createElement("div");
    const teardown = mount(root, argsFor(seed));
    const ring = householdRing(root);
    const label = figureLabel(root);
    if (ring && label) {
      const found = {
        seed,
        ring: { strokeWidth: ring.getAttribute("stroke-width"), dasharray: ring.getAttribute("stroke-dasharray") },
        label: { fontSize: label.getAttribute("font-size") },
      };
      teardown();
      return found;
    }
    teardown();
  }
  throw new Error("no seed in range produced both a household ring and a figure label");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("household-mark and constellation-figure drawing (#1151 W1-Q2)", () => {
  it("draws the same ring and label constants on administration and create", async () => {
    const { mountStation } = await import("../../web/src/lib/backdrops/station.js");
    const { mountConstellations } = await import("../../web/src/lib/backdrops/constellations.js");

    const station = findMarks(mountStation, (seed) => ({
      seed, galaxy: GALAXY, primary: null, facts: { domain: "orbit.example", systems: 1, crew: 1 },
    }));
    const create = findMarks(mountConstellations, (seed) => ({ seed, galaxy: GALAXY, primary: null }));

    expect(create.ring).toEqual(station.ring);
    expect(create.label).toEqual(station.label);
  });
});
