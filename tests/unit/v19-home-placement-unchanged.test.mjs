import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { constellationPosOf } from "../../web/src/lib/data/chart.js";
import { placeGalaxy } from "../../web/src/routes/home/placement.js";

/*
 * The other half of #670's fix, and the half that is easy to lose.
 *
 * The floor pass must be a no-op for any sky that is already legal. If it
 * moves an under-capacity sky by even a pixel, the v19 visual fidelity gate
 * fails against its committed baselines -- and the acceptance criteria require
 * that gate green at ZERO pixel difference, because these are ratified screens
 * rather than an approximation of them.
 *
 * The fidelity gate is expensive and needs browsers, so it is not the thing to
 * find this with. These 784 skies were captured from the placement as it stood
 * immediately before the fix (commit 9accbc4), filtered to those already
 * satisfying the 80px floor. Any difference here is a regression in a sky the
 * fix had no business touching.
 *
 * Regenerating this fixture to make a failure go away would defeat its whole
 * purpose. If placement is deliberately changed for legal skies, that is a
 * design change to ratified screens and needs the owner, not a new fixture.
 */

const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/v19-placement-under-capacity.json"), "utf8"),
);

const VIEWPORTS = {
  desk: { width: 1600, height: 1000, keepOut: 180 },
  laptop: { width: 1280, height: 800, keepOut: 150 },
  newcomer: { width: 480, height: 480, keepOut: 0 },
};

describe("#670 the floor pass leaves legal skies alone", () => {
  it("captured a meaningful number of skies to guard", () => {
    /* A fixture that silently emptied would make every assertion below
       vacuous, which is the failure this whole file exists to avoid. */
    expect(FIXTURE.length).toBeGreaterThan(700);
  });

  it("places every already-legal sky exactly where it did before the fix", () => {
    const moved = [];
    for (const sky of FIXTURE) {
      const viewport = VIEWPORTS[sky.viewport];
      const galaxy = {};
      for (const [id] of sky.points) galaxy[id] = { name: id, pos: constellationPosOf(id) };
      const placed = placeGalaxy({ galaxy, camera: null, ...viewport, screen: viewport.width })
        .filter((point) => !point.isCamera);
      const now = new Map(placed.map((p) => [p.id, p]));
      for (const [id, ox, oy, banded] of sky.points) {
        const point = now.get(id);
        if (!point) { moved.push(`${sky.viewport} n=${sky.n} seed=${sky.seed}: ${id} vanished`); continue; }
        if (+point.ox.toFixed(6) !== ox || +point.oy.toFixed(6) !== oy || point.banded !== banded) {
          moved.push(
            `${sky.viewport} n=${sky.n} seed=${sky.seed}: ${id} ` +
            `(${ox},${oy},banded=${banded}) -> (${+point.ox.toFixed(6)},${+point.oy.toFixed(6)},banded=${point.banded})`,
          );
        }
      }
    }
    expect(moved.slice(0, 5)).toEqual([]);
    expect(moved).toHaveLength(0);
  });
});
