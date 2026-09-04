/**
 * The gravity well's generated sky, carried across from
 * design/family/404-gravity.html with its seeded RNG intact: the starfield,
 * and the tangential smears of lensed starlight ringing the hole.
 *
 * Since #790 the starfield falls into the hole rather than drifting past it.
 * A falling layer is one band of stars, 450–1100 out from the hole with soft
 * edges, thinning as 1/r²: that is the one distribution a shrinking copy of
 * the band can hand over to the next copy at the same density, so three
 * copies a third of a cycle apart (see +error.svelte) read as one steady
 * field. A falling band is not built as DOM: it is returned as SVG markup for
 * +error.svelte to rasterise once, because Safari gives a scaled SVG group a
 * bitmap the size of the group's whole extent and redraws it as the scale
 * changes — six of them at twice the frame hung a laptop (#790). A drifting
 * layer is the original: stars spread over the whole frame, keeping clear of
 * the hole, built directly into the sky <svg>.
 *
 * Imperative DOM by design — it builds SVG nodes directly. Svelte renders the
 * markup and stands back.
 */

/**
 * @param {{ farFalls: boolean, nearFalls: boolean }} sky — which layers fall
 *   (band) and which drift (spread); the #790 review switch, until ratified.
 * @returns {{ farBand: string | null, nearBand: string | null }} each falling
 *   layer's stars as SVG markup, in a 2200×2200 box centred on the hole
 *   (viewBox -1100 -1100 2200 2200); null for a layer that drifts instead.
 */
export function mountGravityWell({ farFalls, nearFalls }) {
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(4040404);
  const NS = "http://www.w3.org/2000/svg";
  const far = document.getElementById("farstars"), near = document.getElementById("nearstars");
  /** @param {number} x @param {number} y */
  const hole = (x, y) => Math.hypot(x - 800, y - 450);

  /**
   * One star, either as a live <circle> in a drifting group or as markup for
   * a falling band. Only the live one can twinkle: a raster holds still, and
   * the infall's own motion carries the life instead.
   * @param {string[] | Element} sink @param {Record<string, string>} attrs @param {string} [twinkleDelay]
   */
  const circle = (sink, attrs, twinkleDelay) => {
    if (Array.isArray(sink)) {
      sink.push(`<circle ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`);
      return;
    }
    const c = document.createElementNS(NS, "circle");
    for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
    if (twinkleDelay !== undefined) { c.setAttribute("class", "tw"); c.style.animationDelay = twinkleDelay + "s"; }
    sink.appendChild(c);
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
  /** Frame coordinates. @param {number} n @param {number} clear @param {(x: number, y: number) => void} place */
  const spread = (n, clear, place) => {
    let made = 0;
    while (made < n) {
      const x = rng() * 1600, y = rng() * 1000;
      if (hole(x, y) < clear) continue;
      place(x, y);
      made++;
    }
  };

  /** @param {string[] | Element} sink @param {number} x @param {number} y */
  const farStar = (sink, x, y) => {
    const attrs = { cx: x.toFixed(1), cy: y.toFixed(1), r: (0.35 + rng() * 0.65).toFixed(2), opacity: (0.1 + rng() * 0.28).toFixed(2) };
    circle(sink, attrs, rng() < 0.14 ? (rng() * 6).toFixed(1) : undefined);
  };
  /** @param {string[] | Element} sink @param {number} x @param {number} y */
  const nearStar = (sink, x, y) => {
    const r = 0.9 + rng() * 0.9, cx = x.toFixed(1), cy = y.toFixed(1);
    circle(sink, { cx, cy, r: (r * 3.6).toFixed(1), fill: "url(#stargl)" });
    const attrs = { cx, cy, r: r.toFixed(2), fill: "#e8edff", opacity: (0.4 + rng() * 0.4).toFixed(2) };
    circle(sink, attrs, rng() < 0.28 ? (rng() * 6).toFixed(1) : undefined);
  };

  /** @type {string[]} */
  const farBand = [];
  /** @type {string[]} */
  const nearBand = [];
  if (farFalls) band(150, (x, y) => farStar(farBand, x, y));
  else if (far) spread(110, 150, (x, y) => farStar(far, x, y));
  if (nearFalls) band(36, (x, y) => nearStar(nearBand, x, y));
  else if (near) spread(30, 170, (x, y) => nearStar(near, x, y));

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
    farBand: farFalls ? `<g fill="#dbe2f5">${farBand.join("")}</g>` : null,
    nearBand: nearFalls ? `<defs>${STARGL}</defs>${nearBand.join("")}` : null,
  };
}

/** The near stars' glow, the same gradient the sky <svg> carries for the drifting layer. */
const STARGL = '<radialGradient id="stargl" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#e8edff" stop-opacity=".45"/><stop offset="100%" stop-color="#e8edff" stop-opacity="0"/></radialGradient>';
