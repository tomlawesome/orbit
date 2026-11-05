/*
 * Planet names on the sky (#1461): who gets a name, and where it goes.
 *
 * `placeLabels` is round 4's label placer, carried over verbatim from
 * design/v19/home-sun/round-6/src/core.js (ratified, round 6 verdict L) with
 * the one change the module needs: the text measure is passed in, so a unit
 * test can give it a fake and the browser a canvas. It works in the mock-up's
 * scene pixels; `skyLabelsOf` converts the dial's own units in and the placed
 * names back out.
 */

/** The mock-up's two scenes (core.js SCENES): S is scene px per dial unit, name the household name's size in dial units. */
export const SKY_SCENES = {
  desk: { S: 1.684, W: 780, H: 640, CX: 390, CY: 320, font: 12, name: 10 },
  pocket: { S: 0.942, W: 390, H: 372, CX: 195, CY: 186, font: 12, name: 14 / 0.942 },
};

/**
 * @typedef {{ id: string, title: string, days: number, x: number, y: number, pr: number, rpx: number, theta: number }} SkyPlanet
 * @typedef {{ W: number, H: number, CX: number, CY: number, font: number }} SkyScene
 * @typedef {{ x0: number, y0: number, x1: number, y1: number }} SkyBox
 * @typedef {{ id: string, title: string, x: number, y: number, leader: { x1: number, y1: number, x2: number, y2: number } | null, crowded: boolean }} SkyLabel
 * @typedef {(text: string, px: number) => number} Measure
 */

const hit = (/** @type {SkyBox} */ r, /** @type {{ x: number, y: number, r: number }} */ c, /** @type {number} */ pad) => {
  const nx = Math.max(r.x0, Math.min(c.x, r.x1)), ny = Math.max(r.y0, Math.min(c.y, r.y1));
  return Math.hypot(nx - c.x, ny - c.y) < c.r + pad;
};
const overlap = (/** @type {SkyBox} */ a, /** @type {SkyBox} */ b, /** @type {number} */ pad) =>
  a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;

/**
 * Round 4's label placer, verbatim.
 * @param {SkyPlanet[]} wanted
 * @param {SkyPlanet[]} planets  every planet: the discs a name keeps clear of
 * @param {SkyBox[]} fixed
 * @param {SkyScene} sc
 * @param {Measure} measure
 * @returns {SkyLabel[]}
 */
export function placeLabels(wanted, planets, fixed, sc, measure) {
  const h = 14, gap = 4;
  /** @type {SkyBox[]} */
  const placed = [];
  /** @type {SkyLabel[]} */
  const out = [];
  const discs = planets.map((p) => ({ x: p.x, y: p.y, r: p.pr + 1.5 }));
  const inBounds = (/** @type {SkyBox} */ r) => r.x0 >= 4 && r.x1 <= sc.W - 4 && r.y0 >= 4 && r.y1 <= sc.H - 4;
  const clear = (/** @type {SkyBox} */ r) => inBounds(r) && !placed.some((q) => overlap(r, q, 3)) && !fixed.some((q) => overlap(r, q, 3)) && !discs.some((c) => hit(r, c, 2));
  [...wanted].sort((a, b) => a.rpx - b.rpx).forEach((p) => {
    const w = measure(p.title, sc.font) + 2;
    const at = (/** @type {number} */ th, /** @type {number} */ extra) => {
      const ring = p.rpx + p.pr + gap + extra, ux = Math.cos(th), uy = Math.sin(th);
      const ax = sc.CX + ring * ux, ay = sc.CY + ring * uy, cx = ax + ux * w / 2, cy = ay + uy * h / 2;
      return { ring, r: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }, cx, cy };
    };
    /** @type {any} */
    let best = null;
    const ownClear = (/** @type {SkyBox} */ r) => !hit(r, { x: p.x, y: p.y, r: p.pr + 1.5 }, 2);
    for (let k = 0; k <= 140 && !best; k++) {
      for (const sgn of (k === 0 ? [0] : [1, -1])) {
        const th = p.theta + sgn * k * Math.PI / 180;
        let c = at(th, 0);
        for (let e = 1; e <= 30 && !ownClear(c.r); e++) c = at(th, e);
        if (clear(c.r)) { best = { ...c, deg: sgn * k }; break; }
      }
    }
    if (!best) { best = { ...at(p.theta, 0), deg: 0, crowded: true }; }
    placed.push(best.r);
    const moved = Math.abs(best.deg) * Math.PI / 180 * best.ring;
    let leader = null;
    const r = best.r;
    const nx = Math.max(r.x0, Math.min(p.x, r.x1)), ny = Math.max(r.y0, Math.min(p.y, r.y1));
    const gapPx = Math.hypot(nx - p.x, ny - p.y) - p.pr;
    if (moved > h && gapPx > 7) {
      const d = Math.hypot(nx - p.x, ny - p.y) || 1;
      leader = { x1: p.x + (nx - p.x) / d * (p.pr + 1), y1: p.y + (ny - p.y) / d * (p.pr + 1), x2: nx, y2: ny };
    }
    out.push({ id: p.id, title: p.title, x: best.cx, y: best.cy, leader, crowded: Boolean(best.crowded) });
  });
  return out;
}

/**
 * Which planets get a name (decision 39): due in `labelDays` days or fewer,
 * overdue included; 365 is every planet, 0 none. The pinned planet's callout
 * names it, so it gets no label.
 * @template {{ id: string, days: number }} P
 * @param {P[]} planets
 * @param {number} labelDays
 * @param {string | null} [pin]
 * @returns {P[]}
 */
export function namedPlanets(planets, labelDays, pin = null) {
  if (!(labelDays > 0)) return [];
  return planets.filter((p) => (labelDays >= 365 || p.days <= labelDays) && p.id !== pin);
}

/**
 * Names for a set of planets: `namedPlanets`, then `placeLabels` with every
 * planet as a disc to keep clear of.
 * @param {SkyPlanet[]} planets
 * @param {{ labelDays: number, pin?: string | null, fixed?: SkyBox[], scene: SkyScene, measure: Measure }} options
 * @returns {SkyLabel[]}
 */
export function placeSkyLabels(planets, { labelDays, pin = null, fixed = [], scene, measure }) {
  const wanted = namedPlanets(planets, labelDays, pin);
  if (!wanted.length) return [];
  return placeLabels(wanted, planets, fixed, scene, measure);
}

/**
 * Where each dial writes the household's name, in dial units (the app's own:
 * home's `#dial-name` and the pocket's), and the box names keep clear of.
 */
const NAME_AT = { desk: { y: 212, size: 10 }, pocket: { y: 218, size: 15 } };

/**
 * The names for a dial, in the dial's own units, ready to draw.
 *
 * `bodies` are the dial's seated planets: `place` is the seated placement
 * (desk `placement`, pocket `pocketPlacement`) and `radius` the drawn radius
 * in dial units. The placer runs in the mock-up's scene px and the answer is
 * brought back to dial units, so the same label draws inside the dial's svg.
 * A suggestion is drawn and kept clear of, but never named.
 *
 * @param {{ id: string, title: string, days: number, suggestion?: boolean, place: { angle: number, radius: number, x: number, y: number }, radius: number }[]} bodies
 * `nameAt` says where the household's name is drawn, where a dial does not
 * write it at the app's own spot. With `px` the answer stays in the scene's own pixels (the mock-up's picture,
 * drawn at its own size, as the Settings preview does) and `font` is the scene's.
 *
 * @param {{ scene: "desk" | "pocket", labelDays: number, pin?: string | null, name?: string, nameAt?: { y: number, size: number }, measure: Measure, px?: boolean }} options
 * @returns {{ labels: SkyLabel[], font: number, scale: number }}  font in the answer's units; scale is scene px per unit
 */
export function skyLabelsOf(bodies, { scene, labelDays, pin = null, name = "", nameAt, measure, px = false }) {
  const sc = SKY_SCENES[scene], S = sc.S;
  const font = px ? sc.font : sc.font / S;
  if (!(labelDays > 0) || !bodies.length) return { labels: [], font, scale: px ? 1 : S };
  const planets = bodies.map((b) => ({
    id: b.id, title: b.title, days: b.days, suggestion: Boolean(b.suggestion),
    x: sc.CX + (b.place.x - 190) * S, y: sc.CY + (b.place.y - 190) * S,
    pr: b.radius * S, rpx: b.place.radius * S, theta: b.place.angle,
  }));
  const wanted = namedPlanets(planets.filter((p) => !p.suggestion), labelDays, pin);
  if (!wanted.length) return { labels: [], font, scale: px ? 1 : S };
  /* the household name, centred under the sun */
  const at = nameAt ?? NAME_AT[scene], w = measure(name, at.size * S);
  const y = sc.CY + (at.y - 190) * S;
  const fixed = [{ x0: sc.CX - w / 2, x1: sc.CX + w / 2, y0: y - at.size * S * 0.8, y1: y + at.size * S * 0.25 }];
  const placed = placeLabels(wanted, planets, fixed, sc, measure);
  if (px) return { labels: placed, font, scale: 1 };
  const back = (/** @type {number} */ v, /** @type {number} */ c) => 190 + (v - c) / S;
  const labels = placed.map((l) => ({
    ...l,
    x: back(l.x, sc.CX), y: back(l.y, sc.CY),
    leader: l.leader && { x1: back(l.leader.x1, sc.CX), y1: back(l.leader.y1, sc.CY), x2: back(l.leader.x2, sc.CX), y2: back(l.leader.y2, sc.CY) },
  }));
  return { labels, font, scale: S };
}

/** @type {CanvasRenderingContext2D | null} */
let canvas = null;
/**
 * The browser's text measure (core.js), or null where there is no canvas
 * (the server render): the names are then drawn once the page is in a browser.
 * @returns {Measure | null}
 */
export function canvasMeasure() {
  if (typeof document === "undefined") return null;
  canvas ??= document.createElement("canvas").getContext("2d");
  const context = canvas;
  if (!context) return null;
  return (text, px) => {
    context.font = `400 ${px}px "Inter Variable"`;
    return context.measureText(text).width;
  };
}
