import { describe, expect, it } from "vitest";

// The sky's placement is plain ESM inside web/, which root vitest excludes
// from COLLECTION (#425: web's own suites are Playwright); importing a module
// from there is fine — only test files are excluded.
import { dimFor, minSeparationFor, placeGalaxy, reachOn } from "../../web/src/routes/home/placement.js";
import { galaxyOf } from "../../web/src/lib/data/chart.js";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

const TODAY = "2026-08-13"; // DESIGN_TODAY: the date every mockup was drawn against
const GALAXY = galaxyOf(WORKSPACE_FIXTURE, TODAY);
const PRIMARY = WORKSPACE_FIXTURE.activeHouseholdId;
const OTHERS = Object.keys(GALAXY).filter((id) => id !== PRIMARY);

/*
 * The hero at the fidelity gate's own viewport: .page is 1160 wide capped,
 * with 24px of padding either side, inside a 1600x1000 frame, and the hero is
 * min-height:100vh. This is the geometry the ratified mockup was measured at,
 * so it is the geometry the numbers below are pinned to.
 */
const DESK = { width: 1112, height: 1000 };
/* .dialwrap is 640 wide; +88 clears the constellation's own r-40 ring. */
const KEEP_OUT = 640 / 2 + 88;

const place = (options = {}) =>
  placeGalaxy({ galaxy: GALAXY, camera: PRIMARY, ...DESK, keepOut: KEEP_OUT, ...options });

const visible = (placed) => placed.filter((point) => !point.isCamera);
const degrees = (point) => (Math.atan2(point.oy, point.ox) * 180) / Math.PI;
const byId = (placed) => new Map(placed.map((point) => [point.id, point]));

/** The bearing the fixture's own absolute coordinates say a household is on. */
const trueBearing = (from, to) =>
  (Math.atan2(GALAXY[to].pos[1] - GALAXY[from].pos[1], GALAXY[to].pos[0] - GALAXY[from].pos[0]) * 180) /
  Math.PI;

const VIEWPORTS = [
  { width: 1112, height: 1000 },
  { width: 1112, height: 800 },
  { width: 1112, height: 700 },
  { width: 1400, height: 1200 },
  { width: 860, height: 900 },
];

// #428, the owner's ruling of 2026-08-16: every household's placement derives
// from its absolute coordinate, flights never reshuffle what the sky already
// taught, and the overlap relaxation is deterministic.
describe("the fixed map", () => {
  it("places the mockup's constellations where the mockup draws them", () => {
    // Lifted from the ratified sky at the gate's own viewport. If these move,
    // the home fidelity baseline has moved with them and the change is wrong.
    const drawn = {
      "hh-seaside-4551": [-414.385, -204.842],
      "hh-mumdad-2480": [267.077, 308.438],
      "hh-narrow-15033": [-360.195, 274.867],
      "hh-grans-1307": [525.967, -134.042],
    };
    const placed = byId(place());
    for (const [id, [ox, oy]] of Object.entries(drawn)) {
      expect(Math.hypot(placed.get(id).ox - ox, placed.get(id).oy - oy), id).toBeLessThan(0.01);
    }
  });

  it("draws every household on its exact true bearing, at every viewport", () => {
    // The one exception is #428's own AC6, and it announces itself: a bearing
    // with no position both clear of the chart and inside the sky slides to
    // the band edge, and says so with `banded`. Everything else is exact.
    let bent = 0;
    for (const viewport of VIEWPORTS) {
      for (const camera of Object.keys(GALAXY)) {
        for (const point of visible(place({ camera, ...viewport }))) {
          if (point.banded) { bent += 1; continue; }
          const error = Math.abs(degrees(point) - trueBearing(camera, point.id));
          expect(
            Math.min(error, 360 - error),
            `${point.id} from ${camera} at ${viewport.width}x${viewport.height}`,
          ).toBeLessThan(1);
        }
      }
    }
    // The exception must stay an exception; most of the sky is always true.
    expect(bent).toBeLessThan(VIEWPORTS.length * Object.keys(GALAXY).length * OTHERS.length * 0.5);
  });

  it("never bends a bearing at the viewport the design was drawn at", () => {
    // From your own household, on a desk, nothing negotiates at all: every
    // constellation is exactly where its coordinate says.
    expect(visible(place()).some((point) => point.banded)).toBe(false);
  });

  it("is a pure function: the same sky, camera and viewport give the same answer", () => {
    for (const camera of Object.keys(GALAXY)) {
      const once = visible(place({ camera }));
      const twice = visible(place({ camera }));
      expect(twice.map((p) => [p.id, p.ox, p.oy])).toEqual(once.map((p) => [p.id, p.ox, p.oy]));
    }
  });

  it("cannot feel the order the households arrived in", () => {
    // The workspace read can return households in any order — a rename, a new
    // join, a re-sort. Walking Object.entries() let that order reach the
    // relaxation, so the same sky could arrange itself two ways.
    const shuffled = {};
    for (const id of [...Object.keys(GALAXY)].reverse()) shuffled[id] = GALAXY[id];
    const straight = visible(place());
    const backwards = visible(
      placeGalaxy({ galaxy: shuffled, camera: PRIMARY, ...DESK, keepOut: KEEP_OUT }),
    );
    expect(backwards.map((p) => [p.id, p.ox, p.oy])).toEqual(straight.map((p) => [p.id, p.ox, p.oy]));
  });

  it("leaves the survivors exactly where they were when a household leaves the set", () => {
    const whole = byId(visible(place()));
    for (const dropped of OTHERS) {
      const subset = Object.fromEntries(Object.entries(GALAXY).filter(([id]) => id !== dropped));
      const survivors = visible(
        placeGalaxy({ galaxy: subset, camera: PRIMARY, ...DESK, keepOut: KEEP_OUT }),
      );
      expect(survivors).toHaveLength(OTHERS.length - 1);
      for (const point of survivors) {
        const before = whole.get(point.id);
        expect(point.ox, `${point.id} without ${dropped}`).toBeCloseTo(before.ox, 9);
        expect(point.oy, `${point.id} without ${dropped}`).toBeCloseTo(before.oy, 9);
      }
    }
  });

  it("keeps every bearing when the set changes, whatever the viewport", () => {
    // Radius is negotiable and a crowded sky may spend it; the bearing is the
    // part that carries meaning and it survives any change to the set.
    for (const viewport of VIEWPORTS) {
      const whole = byId(visible(place(viewport)));
      for (const dropped of OTHERS) {
        const subset = Object.fromEntries(Object.entries(GALAXY).filter(([id]) => id !== dropped));
        for (const point of visible(
          placeGalaxy({ galaxy: subset, camera: PRIMARY, ...viewport, keepOut: KEEP_OUT }),
        )) {
          expect(degrees(point), `${point.id} without ${dropped}`).toBeCloseTo(
            degrees(whole.get(point.id)), 6,
          );
        }
      }
    }
  });

  it("returns every household, with the camera marked and at the centre", () => {
    const placed = place();
    expect(placed.map((point) => point.id)).toEqual([...Object.keys(GALAXY)].sort());
    const self = placed.find((point) => point.isCamera);
    expect(self.id).toBe(PRIMARY);
    expect([self.ox, self.oy]).toEqual([0, 0]);
  });

  it("puts a household back on the pixel it left after a flight and back", () => {
    const before = visible(place({ camera: PRIMARY })).map((p) => [p.id, p.ox, p.oy]);
    for (const away of OTHERS) {
      place({ camera: away }); // fly out
      const home = visible(place({ camera: PRIMARY })).map((p) => [p.id, p.ox, p.oy]);
      expect(home, `flew to ${away} and back`).toEqual(before);
    }
  });

  it("shows reciprocity: fly to a household and the one you left is dead astern", () => {
    // On a sky tall enough that no bearing has to yield, the reverse bearing
    // is exact — which is what makes the map learnable.
    const tall = { width: 1400, height: 1200 };
    for (const away of OTHERS) {
      const out = byId(visible(place({ camera: PRIMARY, ...tall }))).get(away);
      const back = byId(visible(place({ camera: away, ...tall }))).get(PRIMARY);
      if (out.banded || back.banded) continue;
      const opposed = Math.abs(Math.abs(degrees(out) - degrees(back)) - 180);
      expect(opposed, `${PRIMARY} <-> ${away}`).toBeLessThan(1);
    }
  });

  it("never draws a constellation on the chart, from any camera or viewport (#427)", () => {
    // The keep-out is the one hard guarantee: the separation may go unmet on a
    // crowded small desk, and a bearing may yield at a band edge, but nothing
    // is ever drawn over the gravity well.
    for (const viewport of VIEWPORTS) {
      for (const camera of Object.keys(GALAXY)) {
        for (const point of visible(place({ camera, ...viewport }))) {
          expect(
            Math.hypot(point.ox, point.oy),
            `${point.id} from ${camera} at ${viewport.width}x${viewport.height}`,
          ).toBeGreaterThanOrEqual(KEEP_OUT - 0.001);
        }
      }
    }
  });

  it("keeps the whole sky within reach of the hero", () => {
    // The visible sky is an ellipse 40px wider than the hero, and an outward
    // push may overshoot it by 40px and no more — the cap that stops a
    // separation shoving a constellation off the desk entirely.
    for (const viewport of VIEWPORTS) {
      for (const camera of Object.keys(GALAXY)) {
        for (const point of visible(place({ camera, ...viewport }))) {
          const where = `${point.id} from ${camera} at ${viewport.width}x${viewport.height}`;
          expect(Math.abs(point.ox), where).toBeLessThanOrEqual(viewport.width / 2 + 80.001);
          expect(Math.abs(point.oy), where).toBeLessThanOrEqual(viewport.height / 2);
        }
      }
    }
  });

  it("never draws a constellation past the screen edge, at every desk width (#485)", () => {
    // The keep-out kept a constellation off the dial; nothing kept it on the
    // screen. Below 1096px the dial (and so the keep-out) shrinks with the
    // viewport (home.css's `.dialwrap>svg`), so this checks the coupled
    // relationship the shipped CSS actually produces, not a fixed keep-out.
    const widths = [901, 950, 1000, 1096, 1200, 1600];
    for (const width of widths) {
      const height = 1000;
      const keepOut = Math.min(408, (width - 456) / 2 + 88);
      const skies = [
        ...Object.keys(GALAXY).map((camera) => visible(place({ camera, width, height, keepOut }))),
        // §11/#453: the newcomer's labelled sky has no chart to clear.
        visible(placeGalaxy({ galaxy: GALAXY, camera: null, width, height, keepOut: 0 })),
      ];
      for (const sky of skies) {
        for (const point of sky) {
          expect(Math.abs(point.ox), `${point.id} at ${width}x${height}`).toBeLessThanOrEqual(
            width / 2 - 130 + 0.001,
          );
        }
      }
    }
  });

  it("degrades rather than throws where there is no camera or no sky", () => {
    expect(placeGalaxy({ galaxy: {}, camera: null, ...DESK, keepOut: 0 })).toEqual([]);
    // §11/#453: the newcomer stands at the map origin, with no chart to clear.
    const newcomer = placeGalaxy({ galaxy: GALAXY, camera: null, ...DESK, keepOut: 0 });
    expect(newcomer).toHaveLength(Object.keys(GALAXY).length);
    for (const point of newcomer) {
      const error = Math.abs(degrees(point) - trueBearing(PRIMARY, point.id));
      if (point.id === PRIMARY) continue; // the origin has no bearing from itself
      expect(Math.min(error, 360 - error), point.id).toBeLessThan(1);
    }
  });
});

describe("the sky's measurements", () => {
  it("scales the minimum separation with the desk, between the drawn bounds", () => {
    expect(minSeparationFor(400)).toBe(230);
    expect(minSeparationFor(1112)).toBe(230);
    expect(minSeparationFor(1600)).toBeCloseTo(288, 6);
    expect(minSeparationFor(2400)).toBe(340);
  });

  it("gives upward bearings 60px more clearance than downward ones", () => {
    // The top of the sky carries the north-star create handle and the account
    // row (owner-found, 2026-08-15).
    const up = reachOn(-Math.PI / 2, 1112, 1000);
    const down = reachOn(Math.PI / 2, 1112, 1000);
    expect(down - up).toBeCloseTo(60, 6);
  });

  it("insets a horizontal bearing's reach from the edge, not past it (#485)", () => {
    // EDGE_INSET = 130 replaced REACH_PAD_X = 40: a ring centre used to be
    // allowed 40px PAST the hero's edge; now it stops 130px INSIDE it, the
    // room the constellation's own SVG and label need. At width 1112 that is
    // rx = 556 - 130 = 426 (was 556 + 40 = 596).
    expect(reachOn(0, 1112, 1000)).toBeCloseTo(426, 6);
  });

  it("dims with distance, between the drawn floor and ceiling", () => {
    expect(dimFor(0)).toBeCloseTo(0.9, 6);
    expect(dimFor(690)).toBeCloseTo(0.7846, 3);
    expect(dimFor(9999)).toBeCloseTo(0.45, 6);
  });
});
