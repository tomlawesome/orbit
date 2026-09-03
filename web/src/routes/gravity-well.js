/**
 * The gravity well's generated sky, carried across from
 * design/family/404-gravity.html with its seeded RNG intact: a starfield that
 * avoids the hole, and the tangential smears of lensed starlight ringing it.
 *
 * Imperative DOM by design — it builds SVG nodes directly. Svelte renders the
 * markup and stands back.
 */
export function mountGravityWell() {
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(4040404);
  const NS = "http://www.w3.org/2000/svg";
  // Both ids are in the static markup this mounts into, so they always resolve.
  const far = /** @type {Element} */ (document.getElementById("farstars"));
  const near = /** @type {Element} */ (document.getElementById("nearstars"));
  /** @param {number} x @param {number} y */
  const hole = (x, y) => Math.hypot(x - 800, y - 450);
  let made = 0;
  while (made < 110) {
    const x = rng() * 1600, y = rng() * 1000;
    if (hole(x, y) < 150) continue;
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1));
    c.setAttribute("r", (0.35 + rng() * 0.65).toFixed(2));
    c.setAttribute("opacity", (0.1 + rng() * 0.28).toFixed(2));
    if (rng() < 0.14) { c.setAttribute("class", "tw"); c.style.animationDelay = (rng() * 6).toFixed(1) + "s"; }
    far.appendChild(c); made++;
  }
  made = 0;
  while (made < 30) {
    const x = rng() * 1600, y = rng() * 1000;
    if (hole(x, y) < 170) continue;
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
    near.appendChild(c); made++;
  }
  // lensed starlight: tangential smears ringing the hole. Also always present.
  const arcs = /** @type {Element} */ (document.getElementById("lensarcs"));
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
