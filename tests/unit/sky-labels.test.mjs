import { describe, expect, it } from "vitest";

/*
 * #1461: planet names within N days. The label placer is round 4's
 * `placeLabels` (design/v19/home-sun/round-6/src/core.js) carried over
 * verbatim into a pure module, with the text measure passed in so this file
 * can give it a fake one.
 *
 * Names this file fixes for the build (web/src/lib/data/sky-labels.js):
 *   placeLabels(wanted, planets, fixed, scene, measure) -> labels   (verbatim placer)
 *   namedPlanets(planets, labelDays, pin?)               -> wanted   (who gets a name)
 *   placeSkyLabels(planets, { labelDays, pin, fixed, scene, measure }) -> labels
 *     = namedPlanets, then placeLabels over every planet as the discs.
 * A planet is { id, title, days, x, y, pr, rpx, theta } (core.js `geo`, with
 * `days` for core.js `d`). `scene` is { W, H, CX, CY, font }. `measure(text, px)`
 * is the text width. A label is { id, title, x, y, leader, crowded } where x, y
 * are the centre of the name (core.js).
 */
const MODULE = new URL("../../web/src/lib/data/sky-labels.js", import.meta.url).href;
const load = () => import(/* @vite-ignore */ MODULE);

const scene = { W: 780, H: 640, CX: 390, CY: 320, font: 12 };
const measure = (/** @type {string} */ text, /** @type {number} */ px) => text.length * px * 0.5;
/* the placer's own geometry (core.js): label box height 14, width measure + 2 */
const H = 14;
const box = (/** @type {{ x: number, y: number, title: string }} */ l) => {
  const w = measure(l.title, scene.font) + 2;
  return { x0: l.x - w / 2, x1: l.x + w / 2, y0: l.y - H / 2, y1: l.y + H / 2 };
};
const overlap = (/** @type {any} */ a, /** @type {any} */ b, /** @type {number} */ pad) =>
  a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;
const hitsDisc = (/** @type {any} */ r, /** @type {any} */ c, /** @type {number} */ pad) => {
  const nx = Math.max(r.x0, Math.min(c.x, r.x1)), ny = Math.max(r.y0, Math.min(c.y, r.y1));
  return Math.hypot(nx - c.x, ny - c.y) < c.r + pad;
};

/** A planet on the dial: bearing a degree a day, radius by a plain ramp. */
function planet(/** @type {string} */ id, /** @type {number} */ days, /** @type {number} */ pr = 8) {
  const theta = (Math.max(-90, Math.min(days, 430)) - 90) * Math.PI / 180;
  const rpx = 120 + Math.min(Math.max(days, 0), 365) * 0.6;
  return { id, title: `Planet ${id}`, days, rpx, pr, theta, x: scene.CX + Math.cos(theta) * rpx, y: scene.CY + Math.sin(theta) * rpx };
}
const FIVE = [planet("d5", 5), planet("d29", 29), planet("d30", 30), planet("d31", 31), planet("d200", 200)];
const ids = (/** @type {Array<{ id: string }>} */ labels) => labels.map((l) => l.id).sort();
const nameBox = { x0: scene.CX - 50, x1: scene.CX + 50, y0: scene.CY + 20, y1: scene.CY + 40 };

describe("which planets get a name", () => {
  it("names the planets due in 30 days or fewer at N = 30: 5, 29 and 30, not 31 or 200", async () => {
    const { placeSkyLabels } = await load();
    const labels = placeSkyLabels(FIVE, { labelDays: 30, fixed: [nameBox], scene, measure });
    expect(ids(labels)).toEqual(["d29", "d30", "d5"]);
  });

  it("names every planet at N = 365, however far off", async () => {
    const { placeSkyLabels } = await load();
    const labels = placeSkyLabels([...FIVE, planet("d365", 365), planet("d400", 400)], { labelDays: 365, fixed: [nameBox], scene, measure });
    expect(ids(labels)).toEqual(["d200", "d29", "d30", "d31", "d365", "d400", "d5"]);
  });

  it("names none at N = 0, overdue planets included", async () => {
    const { placeSkyLabels } = await load();
    const labels = placeSkyLabels([...FIVE, planet("late", -10)], { labelDays: 0, fixed: [nameBox], scene, measure });
    expect(labels).toEqual([]);
  });

  it("names an overdue planet whenever N is above 0", async () => {
    const { placeSkyLabels } = await load();
    const labels = placeSkyLabels([planet("late", -40), planet("d200", 200)], { labelDays: 1, fixed: [nameBox], scene, measure });
    expect(ids(labels)).toEqual(["late"]);
  });

  it("never names the pinned planet, whatever N is", async () => {
    const { placeSkyLabels } = await load();
    for (const labelDays of [30, 365]) {
      const labels = placeSkyLabels(FIVE, { labelDays, pin: "d29", fixed: [nameBox], scene, measure });
      expect(ids(labels), `N = ${labelDays}`).not.toContain("d29");
      expect(labels.length).toBeGreaterThan(0);
    }
  });

  it("namedPlanets is the same choice on its own", async () => {
    const { namedPlanets } = await load();
    expect(namedPlanets(FIVE, 30).map((/** @type {any} */ p) => p.id).sort()).toEqual(["d29", "d30", "d5"]);
    expect(namedPlanets(FIVE, 30, "d5").map((/** @type {any} */ p) => p.id).sort()).toEqual(["d29", "d30"]);
    expect(namedPlanets(FIVE, 365)).toHaveLength(5);
    expect(namedPlanets(FIVE, 0)).toHaveLength(0);
  });
});

describe("where the names go", () => {
  it("no two names overlap, and none touches a planet disc, by the placer's own padding (3 and 2)", async () => {
    const { placeSkyLabels } = await load();
    const planets = [planet("a", 3), planet("b", 9), planet("c", 14), planet("d", 20), planet("e", 26), planet("f", 60), planet("g", 120)];
    const labels = placeSkyLabels(planets, { labelDays: 365, fixed: [nameBox], scene, measure });
    expect(labels).toHaveLength(planets.length);
    const placed = labels.filter((l) => !l.crowded);
    expect(placed.length).toBeGreaterThan(0);
    placed.forEach((l, i) => {
      const r = box(l);
      placed.slice(i + 1).forEach((m) => expect(overlap(r, box(m), 3), `${l.id} / ${m.id}`).toBe(false));
      planets.forEach((p) => expect(hitsDisc(r, { x: p.x, y: p.y, r: p.pr + 1.5 }, 2), `${l.id} over disc ${p.id}`).toBe(false));
    });
  });

  it("keeps names inside the picture, 4 px from each edge", async () => {
    const { placeSkyLabels } = await load();
    const labels = placeSkyLabels(FIVE, { labelDays: 365, fixed: [nameBox], scene, measure });
    labels.filter((l) => !l.crowded).forEach((l) => {
      const r = box(l);
      expect(r.x0).toBeGreaterThanOrEqual(4);
      expect(r.y0).toBeGreaterThanOrEqual(4);
      expect(r.x1).toBeLessThanOrEqual(scene.W - 4);
      expect(r.y1).toBeLessThanOrEqual(scene.H - 4);
    });
  });

  it("avoids the household's name box in the middle", async () => {
    const { placeSkyLabels } = await load();
    /* a planet straight below the sun, so its name would sit on the box if the box were not there */
    const below = { ...planet("below", 90), theta: Math.PI / 2, rpx: 50, pr: 4, x: scene.CX, y: scene.CY + 50 };
    const labels = placeSkyLabels([below], { labelDays: 365, fixed: [nameBox], scene, measure });
    expect(labels).toHaveLength(1);
    expect(labels[0].crowded).toBe(false);
    expect(overlap(box(labels[0]), nameBox, 3)).toBe(false);
  });

  it("gives the same output for the same input, and does not change its input", async () => {
    const { placeSkyLabels } = await load();
    const planets = structuredClone(FIVE);
    const first = placeSkyLabels(planets, { labelDays: 365, fixed: [nameBox], scene, measure });
    const second = placeSkyLabels(planets, { labelDays: 365, fixed: [nameBox], scene, measure });
    expect(second).toEqual(first);
    expect(planets).toEqual(FIVE);
  });

  it("placeLabels takes the measure as its fifth argument and returns a centre and an optional leader per name", async () => {
    const { placeLabels } = await load();
    const out = placeLabels(FIVE.slice(0, 2), FIVE, [nameBox], scene, measure);
    expect(out.map((/** @type {any} */ l) => l.id).sort()).toEqual(["d29", "d5"]);
    for (const l of out) {
      expect(l).toEqual(expect.objectContaining({ title: l.title, x: expect.any(Number), y: expect.any(Number), crowded: expect.any(Boolean) }));
      expect(l.leader === null || typeof l.leader.x1 === "number").toBe(true);
    }
  });
});
