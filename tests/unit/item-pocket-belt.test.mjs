import { describe, expect, it } from "vitest";

// The pocket's belt (#1072, design/v19/phone-vision/proposal.md §2.3): the
// arithmetic that seats the phone's low arc, proved here rather than found in
// a browser — the same precedent as v19-belt.test.mjs for the desk's ring.
import {
  MIN_GAP, POCKET_CREST, POCKET_FALL, POCKET_PAPER_STEP, POCKET_RIDE,
  bodiesOf, geometryOf, pocketPapersOf, pocketXOf, seatOf,
} from "../../web/src/routes/item/[[id]]/band.js";
import { searchBelt } from "../../web/src/routes/item/[[id]]/pocket-find.js";

/** @param {number} n @returns {any[]} */
const docs = (n) => Array.from({ length: n }, (_, j) => ({ id: `d${j}`, name: `Paper ${j}`, size: "1 KB" }));
/** A small manifest in the belt's own row shape. */
const MANIFEST = /** @type {any[]} */ ([
  { id: "a", title: "Gutter clearing", section: "Home", kind: "service", provider: null, days: -16, t: "T+16d", when: "28 Jul", longWhen: "28 July 2026", urg: "over", docs: [] },
  { id: "b", title: "Car MOT", section: "Vehicles", kind: "inspection", provider: "Kwik", days: 16, t: "T-16d", when: "29 Aug", longWhen: "29 August 2026", urg: "soon", docs: docs(7) },
  { id: "c", title: "Boiler service", section: "Home", kind: "service", provider: "British Gas", days: 22, t: "T-22d", when: "4 Sept", longWhen: "4 September 2026", urg: "soon", docs: docs(1) },
]);

/** Where a seat `u` item-steps from the apex projects, on the arc itself. */
const at = (/** @type {any} */ geom, /** @type {number} */ u) => geom.project(geom.PHI_APEX - u * MIN_GAP, geom.A, 0);

describe("the pocket's geometry", () => {
  for (const W of [390, 360]) {
    it(`seats by rank as fractions of the width at ${W}`, () => {
      const geom = geometryOf(W, 360, { pocket: true });
      expect(geom.pocket).toBe(true);
      expect(at(geom, 0).x).toBeCloseTo(W / 2, 6);
      expect(at(geom, 0).y).toBeCloseTo(POCKET_CREST, 6);
      /* round 1's drawing: papers ±0.20, neighbours ±0.39, next-but-ones ±0.58 */
      expect(at(geom, POCKET_PAPER_STEP).x - W / 2).toBeCloseTo(0.20 * W, 6);
      expect(W / 2 - at(geom, -POCKET_PAPER_STEP).x).toBeCloseTo(0.20 * W, 6);
      expect(at(geom, 1).x - W / 2).toBeCloseTo(0.39 * W, 6);
      expect(at(geom, 2).x - W / 2).toBeCloseTo(0.58 * W, 6);
      /* sooner is left, later is right, and the arc falls away from the crest */
      expect(at(geom, -1).x).toBeLessThan(at(geom, 1).x);
      expect(at(geom, 1).y).toBeGreaterThan(at(geom, POCKET_PAPER_STEP).y);
    });
  }

  it("falls POCKET_FALL from the crest to the screen's edge", () => {
    const W = 390;
    const geom = geometryOf(W, 360, { pocket: true });
    const edge = pocketXOf(0, W) + W / 2;
    let u = 1;
    while (at(geom, u).x < edge) u += 0.001;
    expect(at(geom, u).y - POCKET_CREST).toBeCloseTo(POCKET_FALL, 0);
  });

  it("leaves the desk's ring as it was", () => {
    const desk = geometryOf(1600, 1000);
    expect(desk.pocket).toBeUndefined();
    expect(desk.A).toBeGreaterThanOrEqual(1150);
  });
});

describe("the pocket's seats", () => {
  const geom = geometryOf(390, 360, { pocket: true });
  const bodies = bodiesOf(MANIFEST, geom.GAP_SCALE, { pocket: true });

  it("keeps the manifest's order and seats items a step apart", () => {
    const items = bodies.filter((b) => b.kind === "item");
    expect(items.map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(items.map((b) => b.off)).toEqual([0, MIN_GAP, 2 * MIN_GAP]);
  });

  it("lets two papers ride and clumps the rest", () => {
    expect(pocketPapersOf(7)).toEqual({ ride: 2, clump: 5 });
    expect(pocketPapersOf(2)).toEqual({ ride: 2, clump: 0 });
    expect(pocketPapersOf(0)).toEqual({ ride: 0, clump: 0 });
    const riding = bodies.filter((b) => b.kind === "doc" && b.itemIdx === 1);
    expect(riding).toHaveLength(POCKET_RIDE);
    /* one each side of their item, at the papers' step */
    expect(riding.map((b) => (b.off - MIN_GAP) / MIN_GAP).map((v) => Math.round(v * 1000) / 1000))
      .toEqual([-POCKET_PAPER_STEP, POCKET_PAPER_STEP].map((v) => Math.round(v * 1000) / 1000));
    /* a paper's caption is its whole name; the painter wraps it */
    expect(riding[0].label).toBe("Paper 0");
  });

  it("seats the centred item on the crest exactly, jumble eased out", () => {
    const i = bodies.findIndex((b) => b.id === "b");
    const s = seatOf(bodies, i, { roll: bodies[i].off, berth: 0.28, geom });
    const p = geom.project(s.phi, s.rho, s.h);
    expect(p.x).toBeCloseTo(195, 6);
    expect(p.y).toBeCloseTo(POCKET_CREST, 6);
  });
});

describe("the belt's find sheet", () => {
  const geom = geometryOf(390, 360, { pocket: true });
  const bodies = bodiesOf(MANIFEST, geom.GAP_SCALE, { pocket: true });

  it("offers the two soonest items before anything is typed", () => {
    const found = searchBelt("", bodies);
    expect(found.items.map((one) => one.body.id)).toEqual(["a", "b"]);
    expect(found.documents).toEqual([]);
    expect(found.nothing).toBe(false);
  });

  it("finds items by title, section and provider, starts-with first", () => {
    expect(searchBelt("home", bodies).items.map((one) => one.body.id)).toEqual(["a", "c"]);
    expect(searchBelt("british", bodies).items.map((one) => one.body.id)).toEqual(["c"]);
    expect(searchBelt("s", bodies).items[0].body.id).toBe("a");
  });

  it("finds every paper, including those packed in the clump", () => {
    const found = searchBelt("paper 6", bodies);
    expect(found.documents.map((hit) => hit.doc.id)).toEqual(["d6"]);
    expect(found.documents[0].itemIdx).toBe(1);
  });

  it("says when nothing matches", () => {
    expect(searchBelt("zeppelin", bodies)).toMatchObject({ query: "zeppelin", nothing: true });
  });
});
