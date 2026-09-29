/**
 * The stumble's sky (#1139) — static, unlike the 404's falling one: this
 * page draws one field of stars and leaves it be. Computed once, on the
 * server too, so the HTML arrives with the sky already in it, the same
 * reason gravity-well.js's still sky is server-rendered.
 *
 * Four frame-areas (x -800..2400, y -600..1600, against the 1600x1000
 * scene) so the field still fills a phone screen once stumble.css draws the
 * box smaller than the viewport.
 */
import { seededRng } from "$lib/sky.js";

const SEED = 500500;
const FAR_COUNT = 480;
const NEAR_COUNT = 160;

/**
 * One star, drawn in the fixed order x, y, r, o so a given seed always
 * yields the same field. Left as raw numbers, formatted at render time
 * (.toFixed(1) for coordinates, .toFixed(2) for radii/opacity), exactly as
 * the 404's own stars are (+error.svelte).
 * @param {() => number} rng
 * @param {(v: number) => number} radiusOf
 */
function star(rng, radiusOf) {
  const x = -800 + rng() * 3200;
  const y = -600 + rng() * 2200;
  const r = radiusOf(rng());
  const o = 0.3 + rng() * 0.6;
  return { x, y, r, o };
}

/**
 * @returns {{ far: { x: number, y: number, r: number, o: number }[], near: { x: number, y: number, r: number, o: number }[] }}
 */
export function createStars() {
  const rng = seededRng(SEED);
  const far = Array.from({ length: FAR_COUNT }, () => star(rng, (v) => 0.5 + v * 0.9));
  const near = Array.from({ length: NEAR_COUNT }, () => star(rng, (v) => 1.3 + v * 1.1));
  return { far, near };
}
