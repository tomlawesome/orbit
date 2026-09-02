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
 * issue) is a hard floor: no two DRAWN centres closer than twice the hit
 * radius, ever, achieved by construction rather than by relaxation -- a
 * relaxation is asymptotic and cannot guarantee a floor. Where even the floor
 * pass's last legal rank cannot hold every yielded household, the survivors
 * beyond capacity are marked `undrawn` rather than placed sub-floor (owner
 * ruling, 2026-09-02) -- so the assertion below is over drawn points only.
 *
 * These fixtures use the product's own position function rather than
 * hand-placed coordinates. Households sit on a ring at distance 640-760 and
 * are spread only by bearing, so a square-scatter fixture does not model the
 * real crowding at all; one was written first and discarded for giving
 * confidently wrong answers.
 *
 * The viewports and the keepOut/width/height they carry are the PRODUCT'S OWN
 * geometry, not stand-in numbers (this rewrite, 2026-09-02, superseding a
 * keepOut of 180/150 that under-modelled the real figure by 2-3x and so missed
 * failures below 1440x900 -- see #670's 2026-09-02 comment):
 *
 *   - the sky renders only at viewport width >= 901 AND height >= 601
 *     (`pocket.css`) -- shorter or narrower than that is the pocket dialect,
 *     which does not draw this sky at all;
 *   - the hero's width is the container, capped at 1160, with 24px of padding
 *     either side: `min(1160, vw - 48)` (`home.css`, `+page.svelte`);
 *   - the hero's height is the full viewport height: `min-height:100vh`
 *     (`home.css`);
 *   - the keep-out is the dial's own footprint plus its ring margin:
 *     `min(640, vw - 456) / 2 + 88` (`home.css`, `home.behaviour.js`).
 *
 * CLOSED GAP (found writing the previous rewrite, 2026-09-02; closed by the
 * follow-up ruling the same day): two of the eight viewports below
 * ("boundary 901x601", "tablet landscape 1180x820") used to fail with
 * `placement.js` UNCHANGED by the undrawn rule above -- a BAND CROSSING the
 * undrawn rule did not touch, because `relayEdge`'s ranks for the top edge
 * and the bottom edge were laid out independently, each routing only around
 * true bearings and its own earlier ranks, with no awareness of what the
 * OTHER edge had already placed. On a thin band both edges' last legal ranks
 * could land within the floor of each other astride the equator, e.g.
 * oy=-5.5 (top, its own last legal rank) and oy=65.5 (bottom, its own last
 * legal rank) at 901x601 -- 71px apart, each individually within its own
 * edge's capacity and so never routed to `undrawn`. The follow-up ruling
 * authorised exactly the fix flagged above: `relayEdge` now treats the
 * opposite band edge's banded members as obstacles too, through the existing
 * `freeOn` forbidden-interval mechanism, laying the bottom edge first and the
 * top edge second within each floor-pass iteration so the obstacle set is
 * well-defined. See #670 for the reproduction and both rulings.
 */

const FLOOR = HIT_RADIUS * 2;

/** The product's own keep-out, hero width and hero height for a viewport. */
function heroFor(vw, vh) {
  return {
    width: Math.min(1160, vw - 48),
    height: vh,
    keepOut: Math.min(640, vw - 456) / 2 + 88,
    screen: vw,
  };
}

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

/** The closest pair of DRAWN centres, and who they are. An undrawn household
    is not on the sky (#670, owner ruling 2026-09-02) and so cannot offend. */
function closestPair(placed) {
  const drawn = placed.filter((point) => !point.undrawn);
  let best = { gap: Infinity, pair: null };
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const gap = Math.hypot(drawn[j].ox - drawn[i].ox, drawn[j].oy - drawn[i].oy);
      if (gap < best.gap) best = { gap, pair: [drawn[i].id, drawn[j].id] };
    }
  }
  return best;
}

function place(ids, viewport) {
  return placeGalaxy({ galaxy: skyOf(ids), camera: null, ...heroFor(viewport.width, viewport.height) })
    .filter((point) => !point.isCamera);
}

/*
 * Every viewport here renders the desk sky (width >= 901, height >= 601;
 * anything smaller is the pocket dialect and never reaches `placeGalaxy` for
 * this chart at all -- see pocket.css). Chosen to span the desk range from
 * its smallest legal corner up to a full desk, including the two geometries
 * the 2026-09-02 audit found still failing under the OLD 150/180 keepOut
 * modelling (1280x720 and 1280x800) so this fixture would have caught them.
 */
const VIEWPORTS = [
  { name: "boundary 901x601", width: 901, height: 601 },
  { name: "laptop short 1280x720", width: 1280, height: 720 },
  { name: "laptop 1280x800", width: 1280, height: 800 },
  { name: "tablet landscape 1180x820", width: 1180, height: 820 },
  { name: "laptop 1440x900", width: 1440, height: 900 },
  { name: "desk 1600x1000", width: 1600, height: 1000 },
];

describe("#670 hit circles never overlap among drawn households", () => {
  for (const viewport of VIEWPORTS) {
    it(`keeps every drawn pair at least ${FLOOR}px apart on the ${viewport.name}`, () => {
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
    const placed = place(idsFor(7, 12), VIEWPORTS[VIEWPORTS.length - 1]);
    const { gap } = closestPair(placed);
    expect(gap).toBeGreaterThanOrEqual(FLOOR);
  });

  it("never marks a household undrawn at 1440x900 or wider", () => {
    const wide = VIEWPORTS.filter((v) => v.width >= 1440);
    const undrawn = [];
    for (const viewport of wide) {
      for (const count of [4, 6, 8, 12]) {
        for (let seed = 1; seed <= 150; seed++) {
          const placed = place(idsFor(seed, count), viewport);
          for (const point of placed) {
            if (point.undrawn) undrawn.push(`${viewport.name} n=${count} seed=${seed}: ${point.id}`);
          }
        }
      }
    }
    expect(undrawn.slice(0, 5)).toEqual([]);
    expect(undrawn).toHaveLength(0);
  });
});
