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
 * field. A drifting layer is the original: stars spread over the whole frame,
 * keeping clear of the hole.
 *
 * Imperative DOM by design — it builds SVG nodes directly. Svelte renders the
 * markup and stands back.
 */

/**
 * @param {{ farFalls: boolean, nearFalls: boolean }} sky — which layers fall
 *   (band) and which drift (spread); the #790 review switch, until ratified.
 */
export function mountGravityWell({ farFalls, nearFalls }) {
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(4040404);
  const NS = "http://www.w3.org/2000/svg";
  const far = document.getElementById("farstars"), near = document.getElementById("nearstars");
  if (!far || !near) return;
  /** @param {number} x @param {number} y */
  const hole = (x, y) => Math.hypot(x - 800, y - 450);

  /** @param {number} n @param {(x: number, y: number) => void} place */
  const band = (n, place) => {
    let made = 0;
    while (made < n) {
      const r = 450 * Math.exp(rng() * Math.log(1100 / 450));
      const w = r < 560 ? (r - 450) / 110 : r > 900 ? (1100 - r) / 200 : 1;
      if (rng() > w) continue;
      const a = rng() * Math.PI * 2;
      place(800 + r * Math.cos(a), 450 + r * Math.sin(a));
      made++;
    }
  };
  /** @param {number} n @param {number} clear @param {(x: number, y: number) => void} place */
  const spread = (n, clear, place) => {
    let made = 0;
    while (made < n) {
      const x = rng() * 1600, y = rng() * 1000;
      if (hole(x, y) < clear) continue;
      place(x, y);
      made++;
    }
  };

  /** @param {number} x @param {number} y */
  const farStar = (x, y) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1));
    c.setAttribute("r", (0.35 + rng() * 0.65).toFixed(2));
    c.setAttribute("opacity", (0.1 + rng() * 0.28).toFixed(2));
    if (rng() < 0.14) { c.setAttribute("class", "tw"); c.style.animationDelay = (rng() * 6).toFixed(1) + "s"; }
    far.appendChild(c);
  };
  /** @param {number} x @param {number} y */
  const nearStar = (x, y) => {
    const r = 0.9 + rng() * 0.9;
    const g = document.createElementNS(NS, "circle");
    g.setAttribute("cx", x.toFixed(1)); g.setAttribute("cy", y.toFixed(1));
    g.setAttribute("r", (r * 3.6).toFixed(1)); g.setAttribute("fill", "url(#stargl)");
    near.appendChild(g);
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1));
    c.setAttribute("r", r.toFixed(2)); c.setAttribute("fill", "#e8edff");
    c.setAttribute("opacity", (0.4 + rng() * 0.4).toFixed(2));
    if (rng() < 0.28) { c.setAttribute("class", "tw"); c.style.animationDelay = (rng() * 6).toFixed(1) + "s"; }
    near.appendChild(c);
  };

  if (farFalls) band(150, farStar); else spread(110, 150, farStar);
  if (nearFalls) band(36, nearStar); else spread(30, 170, nearStar);

  // lensed starlight: tangential smears ringing the hole
  const arcs = document.getElementById("lensarcs");
  if (!arcs) return;
  for (let i = 0; i < 46; i++) {
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
}
