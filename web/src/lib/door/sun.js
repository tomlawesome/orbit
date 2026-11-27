/*
 * The sun's pixels (#119): the three radial glows worked out in floating point and dithered to eight bits, band by
 * band. This module touches no page and no host state, so the page (glows.js: paintSun) and the worker the host makes
 * (sun-worker.js) both run this one routine and the picture is the same pixels from either.
 */

/** @typedef {{ cx: number, cy: number, r: number, stops: [number, string, number][] }} SunDisc one radial gradient: centre, radius, and [offset, colour, opacity] stops */

/* the sun's own glows (the door's sunrise point, 800,920): three radial gradients, as the SVG had them, but drawn by
   hand (sunBand), because a browser draws a gradient this soft in eight bits and each level is a flat ring */
/** @type {SunDisc[]} */
export const SUN = [
  { cx: 800, cy: 922, r: 520, stops: [[0, "#e2772b", 0.3], [0.55, "#c2571f", 0.12], [1, "#000000", 0]] },
  { cx: 800, cy: 922, r: 240, stops: [[0, "#f8c95e", 0.55], [0.3, "#f4c048", 0.3], [0.6, "#f0b429", 0.1], [0.82, "#f0b429", 0.025], [1, "#f0b429", 0]] },
  { cx: 800, cy: 920, r: 86, stops: [[0, "#ffffff", 1], [0.15, "#fff6e2", 0.9], [0.3, "#ffedc2", 0.6], [0.45, "#ffe9c4", 0.34], [0.6, "#ffe4b8", 0.16], [0.75, "#ffe0b0", 0.06], [0.9, "#ffe0b0", 0.015], [1, "#ffe0b0", 0]] },
];

/* A gradient as soft as the sun's spans a few levels over hundreds of pixels, and eight bits draw each level as a
   flat ring; noise added to rings already drawn leaves each ring where it was. So the sun's gradients are worked
   out here in floating point, laid over one another as the SVG laid its circles, and brought down to eight bits
   with triangular noise of a level either way (the sum of two uniforms, less one) on the colour and on the alpha
   alike: the rings become grain too fine to see, and nothing is added on average. The same in every browser.
   Seeded by place, so it dithers the same way on every draw. The colour is kept as the canvas keeps it, times its
   alpha, and written back straight so the browser's own premultiplying lands on the very level chosen. Done in
   bands, for the caller to take a breath between each. */
/** @param {number} x @param {number} y @param {number} seed */
const hash = (x, y, seed) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
};
/** @param {number} r */
const tpdf = (r) => (r & 0xffff) / 0x10000 + (r >>> 16) / 0x10000 - 1;
/** @param {string} hex @returns {number[]} */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** the sun's discs with their colours as floating-point channels */
export const sunDiscs = () => SUN.map((d) => ({ ...d, stops: d.stops.map(([t, c, a]) => /** @type {[number, number[], number]} */ ([t, rgb(c), a])) }));
/** the rows in a band: about 600,000 pixels each @param {number} w */
export const sunRows = (w) => Math.max(1, Math.floor(6e5 / w));

/**
 * One band of the sun, rows y0 to y0 + n, into d (RGBA, straight alpha, zeroed), for a picture w wide at scale s.
 * @param {ReturnType<typeof sunDiscs>} discs @param {number} s @param {number} w @param {number} y0 @param {number} n @param {Uint8ClampedArray} d
 */
export function sunBand(discs, s, w, y0, n, d) {
  for (let y = 0, i = 0; y < n; y++) for (let x = 0; x < w; x++, i += 4) {
    const fx = (x + 0.5) / s, fy = (y0 + y + 0.5) / s;
    let R = 0, G = 0, B = 0, A = 0;
    for (const disc of discs) {
      const t = Math.hypot(fx - disc.cx, fy - disc.cy) / disc.r;
      if (t >= 1) continue;
      const st = disc.stops; let k = 1; while (k < st.length - 1 && st[k][0] < t) k++;
      const [t0, c0, a0] = st[k - 1], [t1, c1, a1] = st[k], u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      const a = a0 + (a1 - a0) * u;
      /* over: the SVG's own compositing of its circles, in floating point */
      R = (c0[0] + (c1[0] - c0[0]) * u) * a + R * (1 - a); G = (c0[1] + (c1[1] - c0[1]) * u) * a + G * (1 - a);
      B = (c0[2] + (c1[2] - c0[2]) * u) * a + B * (1 - a); A = a + A * (1 - a);
    }
    if (A <= 0) continue;
    const r1 = hash(x, y0 + y, 0x9e3779b9), r2 = hash(y0 + y, x, 0x7f4a7c15);
    const a8 = Math.min(255, Math.max(0, Math.round(A * 255 + tpdf(r1))));
    if (!a8) continue;
    const ta = tpdf(r2), u = 255 / a8;
    d[i] = Math.min(a8, Math.max(0, Math.round(R * 255 + ta))) * u;
    d[i + 1] = Math.min(a8, Math.max(0, Math.round(G * 255 + ta))) * u;
    d[i + 2] = Math.min(a8, Math.max(0, Math.round(B * 255 + ta))) * u;
    d[i + 3] = a8;
  }
}
