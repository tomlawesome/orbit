/**
 * The dawn's and the dusk's tiled starfields, built exactly as
 * design/v19/first-run.html builds them at 159ec9f: ONE Park–Miller stream
 * seeded 17170812, drawn on in the sheet's own order — dawn far, dawn near,
 * dusk far, dusk near — with a twinkle on every sixth star of a far tile.
 *
 * The order is the contract, as it is in $lib/sky.js: the stream is what makes
 * the field reproducible, so a screen that consumed it in a different order
 * would be a different sky. Computed once at module load and rendered as plain
 * markup, so the sign-in is still static HTML with no client work to do.
 */
import { seededRng } from "$lib/sky.js";

const rnd = seededRng(17170812);

/**
 * @param {number} n
 * @param {number} rMin
 * @param {number} rSpan
 * @param {number} oMin
 * @param {number} oSpan
 * @param {boolean} twinkle
 */
function tile(n, rMin, rSpan, oMin, oSpan, twinkle) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const star = {
      cx: (rnd() * 1600).toFixed(1),
      cy: (rnd() * 1000).toFixed(1),
      r: (rMin + rnd() * rSpan).toFixed(2),
      opacity: (oMin + rnd() * oSpan).toFixed(2),
      /** @type {string | null} */
      delay: null,
    };
    if (twinkle && i % 6 === 0) star.delay = (rnd() * 5.6).toFixed(1);
    out.push(star);
  }
  return out;
}

export const DAWN_FAR = tile(100, 0.4, 0.5, 0.10, 0.25, true);
export const DAWN_NEAR = tile(44, 0.8, 0.8, 0.35, 0.35, false);
export const DUSK_FAR = tile(100, 0.4, 0.55, 0.14, 0.28, true);
export const DUSK_NEAR = tile(48, 0.8, 0.85, 0.40, 0.38, false);

/*
 * THE NEWCOMER'S FIELD (§15 second pass, ruling 4). The sheet draws two more
 * tiles off this same stream before it — the home frame's pair — and the
 * stream's ORDER is the contract, so they are drawn here and dropped rather
 * than skipped: the newcomer's sky is then the stars the sheet gives it and
 * not a different sky with the same parameters. The home frame in the product
 * paints its own field from $lib/sky.js and has no use for these two.
 */
tile(95, 0.4, 0.5, 0.12, 0.23, false);
tile(46, 0.8, 0.7, 0.30, 0.40, false);
export const NEWCOMER_FAR = tile(95, 0.4, 0.5, 0.12, 0.23, false);
export const NEWCOMER_NEAR = tile(46, 0.8, 0.7, 0.30, 0.40, false);
