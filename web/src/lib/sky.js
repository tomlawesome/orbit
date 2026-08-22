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
export function seededRng(seed) {
  let s = seed;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

/** Home's exact layer recipe — the item view shows the same sky by sharing it. */
export const TILED_LAYERS = [
  { count: 95, rMin: 0.4, rSpan: 0.5, oMin: 0.12, oSpan: 0.23 },
  { count: 46, rMin: 0.8, rSpan: 0.7, oMin: 0.3, oSpan: 0.4 },
];
export const TILED_SEED = 17170812;

const NS = "http://www.w3.org/2000/svg";

/** Fills existing far/near tile groups. One rng, far then near — the call
 *  order is part of the contract, because it is what makes seeds stable. */
export function fillStarTiles(farTile, nearTile, rng = seededRng(TILED_SEED)) {
  [farTile, nearTile].forEach((tile, index) => {
    const { count, rMin, rSpan, oMin, oSpan } = TILED_LAYERS[index];
    for (let i = 0; i < count; i++) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", (rng() * 1600).toFixed(1));
      c.setAttribute("cy", (rng() * 1000).toFixed(1));
      c.setAttribute("r", (rMin + rng() * rSpan).toFixed(2));
      c.setAttribute("opacity", (oMin + rng() * oSpan).toFixed(2));
      tile.appendChild(c);
    }
  });
}

/** Builds the whole tiled sky into a container (the item view's shape). */
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
