/**
 * The shared sky (#445).
 *
 * POL-11 says every page's starfield drifts; until now that was enforced by
 * five parallel copies of the generator, which had already begun to diverge.
 * The seeded RNG and the two-layer tiled field live here once. The three
 * bespoke atmosphere skies (404, maintenance, sunset) keep their own shapes
 * for now — unifying them without moving a pixel is phase 2 — but they should
 * draw their randomness from here.
 *
 * Park–Miller, seeded, so a given seed always yields the same sky and the
 * fidelity gate can hold it still.
 */
/**
 * @param {number} seed
 * @returns {() => number} the next value in [0, 1)
 */
export function seededRng(seed) {
  /* The guard was only in skies.js's private copy (#475): a seed of 0, a
     negative one, or one at or past the modulus collapses the generator to
     zeros forever. Identical output to the old body for every seed already in
     use, which is what the fidelity baselines depend on. */
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

/**
 * A fresh seed for this load — "never the same arrangement twice" (§14).
 *
 * The ONE place randomness enters a backdrop. Pin this and the whole stream is
 * reproducible, chunk for chunk, which is what lets the fidelity gate compare
 * a living sky against a still mockup.
 */
/** @returns {number} */
export function rollSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

/**
 * The seed a fixture run must use: derived from the workspace, because that is
 * the only stable thing about such a run, and hashed (FNV-1a, 32-bit) because a
 * name is not a number. Two runs of the gate roll the same sky; two different
 * workspaces do not.
 */
/**
 * @param {string} id  the workspace's own identifier
 * @returns {number}
 */
export function seedFromWorkspace(id) {
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i++) {
    h ^= String(id).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h | 0) % 2147483646) + 1;
}

/**
 * Chunk n of layer L as a pure function of (seed, layer, n) — the whole of the
 * never-loop law in three lines. A stretch of sky can be rolled the instant
 * before it is revealed and thrown away once it has passed, and nothing is ever
 * tiled or repeated.
 *
 * Every ratified §14 mockup carries a copy of exactly this; it lives here now
 * so a screen inherits it rather than retyping it (#445, #475).
 */
/**
 * @param {number} seed
 * @returns {(layer: number, idx: number) => () => number}
 */
export function streamFactory(seed) {
  return (/** @type {number} */ layer, /** @type {number} */ idx) => {
    const h = (seed ^ Math.imul(idx + 1, 2654435761) ^ Math.imul(layer + 1, 40503)) | 0;
    const r = seededRng((Math.abs(h) % 2147483646) + 1);
    r(); r(); r();
    return r;
  };
}

/** Home's exact layer recipe — the item view shows the same sky by sharing it. */
export const TILED_LAYERS = [
  { count: 95, rMin: 0.4, rSpan: 0.5, oMin: 0.12, oSpan: 0.23 },
  { count: 46, rMin: 0.8, rSpan: 0.7, oMin: 0.3, oSpan: 0.4 },
];
export const TILED_SEED = 17170812;

const NS = "http://www.w3.org/2000/svg";

/** Fills existing far/near tile groups. One rng, far then near — the call
 *  order is part of the contract, because it is what makes seeds stable.
 *  Typed as the plain `Element` the body actually calls `appendChild` on
 *  (rather than `SVGGElement`) so callers that only have an untyped
 *  `getElementById(...)` result don't need a cast just to pass it through.
 * @param {?Element} farTile
 * @param {?Element} nearTile
 * @param {() => number} [rng]
 */
export function fillStarTiles(farTile, nearTile, rng = seededRng(TILED_SEED)) {
  [farTile, nearTile].forEach((tile, index) => {
    const { count, rMin, rSpan, oMin, oSpan } = TILED_LAYERS[index];
    for (let i = 0; i < count; i++) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", (rng() * 1600).toFixed(1));
      c.setAttribute("cy", (rng() * 1000).toFixed(1));
      c.setAttribute("r", (rMin + rng() * rSpan).toFixed(2));
      c.setAttribute("opacity", (oMin + rng() * oSpan).toFixed(2));
      /** @type {Element} */ (tile).appendChild(c);
    }
  });
}

/** Builds the whole tiled sky into a container (the item view's shape).
 * @param {Element} root
 * @param {string} idPrefix
 */
export function mountTiledSky(root, idPrefix) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1600 1000");
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  const tiles = ["far", "near"].map((cls) => {
    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("class", cls);
    layer.setAttribute("fill", cls === "far" ? "var(--star-far, #e9edf8)" : "var(--star-near, #f4f0ff)");
    const tile = document.createElementNS(NS, "g");
    tile.id = `${cls}tile-${idPrefix}`;
    const repeat = document.createElementNS(NS, "use");
    repeat.setAttribute("href", `#${tile.id}`);
    repeat.setAttribute("x", "1600");
    layer.append(tile, repeat);
    svg.appendChild(layer);
    return tile;
  });
  fillStarTiles(tiles[0], tiles[1]);
  root.appendChild(svg);
}
