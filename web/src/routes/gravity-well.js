/**
 * The gravity well's generated sky, carried across from
 * design/family/404-gravity.html with its seeded RNG intact: the starfield,
 * and the tangential smears of lensed starlight ringing the hole.
 *
 * Since #790 the starfield falls into the hole rather than drifting past it.
 * A star layer is one band of stars, 450–1100 out from the hole with soft
 * edges, thinning as 1/r²: that is the one distribution a shrinking copy of
 * the band can hand over to the next copy at the same density, so three
 * copies a third of a cycle apart (see +error.svelte) read as one steady
 * field. The bands are not built as DOM: they are returned as SVG markup for
 * +error.svelte to rasterise once, because Safari gives a scaled SVG group a
 * bitmap the size of the group's whole extent and redraws it as the scale
 * changes — six of them at twice the frame hung a laptop (#790). Only the
 * lensed arcs are still built as live nodes, into the well's own <svg>.
 *
 * Imperative DOM by design — it builds SVG nodes directly. Svelte renders the
 * markup and stands back.
 */

/**
 * @returns {{ farBand: string, nearBand: string }} each star layer as SVG
 *   markup, in a 2200×2200 box centred on the hole (viewBox -1100 -1100 2200
 *   2200).
 */
export function mountGravityWell() {
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(4040404);
  const NS = "http://www.w3.org/2000/svg";

  /**
   * One star's markup. The twinkle the drifting sky had is gone with it — a
   * raster holds still, and the infall's own motion carries the life instead.
   * @param {string[]} sink @param {Record<string, string>} attrs
   */
  const circle = (sink, attrs) => {
    sink.push(`<circle ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`);
  };

  /** Hole-relative coordinates. @param {number} n @param {(x: number, y: number) => void} place */
  const band = (n, place) => {
    let made = 0;
    while (made < n) {
      const r = 450 * Math.exp(rng() * Math.log(1100 / 450));
      const w = r < 560 ? (r - 450) / 110 : r > 900 ? (1100 - r) / 200 : 1;
      if (rng() > w) continue;
      const a = rng() * Math.PI * 2;
      place(r * Math.cos(a), r * Math.sin(a));
      made++;
    }
  };

  /** @param {string[]} sink @param {number} x @param {number} y */
  const farStar = (sink, x, y) => {
    circle(sink, { cx: x.toFixed(1), cy: y.toFixed(1), r: (0.35 + rng() * 0.65).toFixed(2), opacity: (0.1 + rng() * 0.28).toFixed(2) });
    /* The drift's twinkle picks, kept so the seeded layout stays the one reviewed. */
    if (rng() < 0.14) rng();
  };
  /** @param {string[]} sink @param {number} x @param {number} y */
  const nearStar = (sink, x, y) => {
    const r = 0.9 + rng() * 0.9, cx = x.toFixed(1), cy = y.toFixed(1);
    circle(sink, { cx, cy, r: (r * 3.6).toFixed(1), fill: "url(#stargl)" });
    circle(sink, { cx, cy, r: r.toFixed(2), fill: "#e8edff", opacity: (0.4 + rng() * 0.4).toFixed(2) });
    if (rng() < 0.28) rng();
  };

  /** @type {string[]} */
  const farBand = [];
  /** @type {string[]} */
  const nearBand = [];
  band(150, (x, y) => farStar(farBand, x, y));
  band(36, (x, y) => nearStar(nearBand, x, y));

  // lensed starlight: tangential smears ringing the hole
  const arcs = document.getElementById("lensarcs");
  for (let i = 0; arcs && i < 46; i++) {
    const rad = 138 + rng() * 150;
    const a0 = rng() * Math.PI * 2;
    const sweep = (0.25 + rng() * 0.7) * (60 / rad);
    const a1 = a0 + sweep;
    const x0 = 800 + rad * Math.cos(a0), y0 = 450 + rad * Math.sin(a0);
    const x1 = 800 + rad * Math.cos(a1), y1 = 450 + rad * Math.sin(a1);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rad.toFixed(1)} ${rad.toFixed(1)} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`);
    p.setAttribute("stroke", "#cdd6ee");
    p.setAttribute("stroke-width", (0.7 + rng() * 0.9).toFixed(2));
    p.setAttribute("stroke-linecap", "round");
    // tighter to the hole = brighter, more smeared
    p.setAttribute("opacity", (0.24 * (170 / rad) ** 1.6).toFixed(2));
    if (rng() < 0.35) p.setAttribute("filter", "url(#b1)");
    arcs.appendChild(p);
  }

  return {
    farBand: `<g fill="#dbe2f5">${farBand.join("")}</g>`,
    nearBand: `<defs>${STARGL}</defs>${nearBand.join("")}`,
  };
}

/** The near stars' glow. */
const STARGL = '<radialGradient id="stargl" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#e8edff" stop-opacity=".45"/><stop offset="100%" stop-color="#e8edff" stop-opacity="0"/></radialGradient>';
