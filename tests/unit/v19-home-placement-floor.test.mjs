import { describe, expect, it } from "vitest";

import { constellationPosOf } from "../../web/src/lib/data/chart.js";
import { HIT_RADIUS, placeGalaxy } from "../../web/src/routes/home/placement.js";

/*
 * #670: two constellations can be placed on the same pixel, so a click aimed
 * at one household reaches another and sends a join request to a household
 * the person did not choose.
 *
 * The mechanism is capacity, not convergence. A bearing that cannot be
 * honoured yields to a band edge, which pins its `oy` and leaves it free only
 * to slide in `ox` within +/-bound. When more constellations yield to one edge
 * than that span holds at `minSep`, no arrangement satisfies the constraint:
 * the relaxation shoves them into the bound, where the clamp makes every
 * further shove a no-op, and they come to rest on top of each other. Adding
 * rounds changes nothing.
 *
 * The ratified answer (owner, 2026-09-01, on the Fable ruling recorded on the
 * issue) is a hard floor: no two drawn centres closer than twice the hit
 * radius, ever, achieved by construction rather than by relaxation -- a
 * relaxation is asymptotic and cannot guarantee a floor.
 *
 * These fixtures use the product's own position function rather than
 * hand-placed coordinates. Households sit on a ring at distance 640-760 and
 * are spread only by bearing, so a square-scatter fixture does not model the
 * real crowding at all; one was written first and discarded for giving
 * confidently wrong answers.
 */

const FLOOR = HIT_RADIUS * 2;

/** Deterministic ids, so a failure names a sky that can be re-run exactly. */
function idsFor(seed, count) {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, () => `hh_${Math.floor(next() * 1e9).toString(36)}`);
}

function skyOf(ids) {
  const galaxy = {};
  for (const id of ids) galaxy[id] = { name: id, pos: constellationPosOf(id) };
  return galaxy;
}

/** The closest pair of drawn centres, and who they are. */
function closestPair(placed) {
  let best = { gap: Infinity, pair: null };
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const gap = Math.hypot(placed[j].ox - placed[i].ox, placed[j].oy - placed[i].oy);
      if (gap < best.gap) best = { gap, pair: [placed[i].id, placed[j].id] };
    }
  }
  return best;
}

function place(ids, { width, height, keepOut }) {
  return placeGalaxy({ galaxy: skyOf(ids), camera: null, width, height, keepOut, screen: width })
    .filter((point) => !point.isCamera);
}

/* The viewports that matter: a desk, a laptop, and the newcomer sky, whose
   keepOut of 0 makes yielding the normal case rather than an unlucky one. */
const VIEWPORTS = [
  { name: "desk 1600x1000", width: 1600, height: 1000, keepOut: 180 },
  { name: "laptop 1280x800", width: 1280, height: 800, keepOut: 150 },
  { name: "newcomer 480x480", width: 480, height: 480, keepOut: 0 },
];

describe("#670 hit circles never overlap", () => {
  for (const viewport of VIEWPORTS) {
    it(`keeps every pair at least ${FLOOR}px apart on the ${viewport.name}`, () => {
      const offenders = [];
      for (const count of [4, 6, 8, 12]) {
        for (let seed = 1; seed <= 150; seed++) {
          const ids = idsFor(seed, count);
          const { gap, pair } = closestPair(place(ids, viewport));
          if (gap < FLOOR) {
            offenders.push(`n=${count} seed=${seed} gap=${gap.toFixed(2)}px (${pair?.join(" / ")})`);
          }
        }
      }
      /* Named rather than counted: a failure should say which sky to re-run,
         not merely how many there were. */
      expect(offenders.slice(0, 5)).toEqual([]);
      expect(offenders).toHaveLength(0);
    });
  }

  it("reproduces the original pile: twelve households, four yielded to one edge", () => {
    const placed = place(idsFor(7, 12), VIEWPORTS[0]);
    const { gap } = closestPair(placed);
    expect(gap).toBeGreaterThanOrEqual(FLOOR);
  });
});
