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
 * field.
 *
 * The bands are painted onto <canvas> copies (paintSky), not built as SVG:
 * Safari gives a scaled SVG group a bitmap the size of the group's whole
 * extent and redraws it as the scale changes — six of them at twice the
 * frame hung a laptop — and a bitmap that goes through PNG (rasteriseSvg's
 * encode, then the <img> decode) costs whole seconds of main thread in
 * WebKit, during which the sky is blank and the well stutters. Painting 222
 * dots with the 2D API is a few milliseconds, synchronous, so the stars are
 * there on the first frame. Only the lensed arcs are still built as live
 * nodes, into the well's own <svg>.
 *
 * Imperative DOM by design — it builds SVG nodes directly. Svelte renders the
 * markup and stands back.
 */

/** @typedef {{ x: number, y: number, r: number, o: number }} Star — hole-relative units. */
/**
 * @typedef {object} Sky
 * @prop {{ far: Star[][], near: Star[][] }} first — the three bands each layer
 *   opens with, in copy order; the server renders them as the sky the HTML
 *   arrives with (+error.svelte), and the canvases then take the very same
 *   bands, so the handover moves nothing.
 * @prop {() => Star[]} far — the next far band from the seeded stream.
 * @prop {() => Star[]} near — likewise, near.
 * @prop {() => void} mountArcs — draws the lensed arcs into #lensarcs. Client only.
 */

/**
 * Seeds the sky. No DOM: safe on the server. The first three bands of each
 * layer are drawn before the lensed arcs, so the arcs (and the fidelity
 * baseline) stay put however many bands are drawn later.
 * @returns {Sky}
 */
export function createSky() {
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(4040404);
  const NS = "http://www.w3.org/2000/svg";

  /** @param {number} n @param {(x: number, y: number) => void} place */
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
  /* The drift's twinkle picks are still drawn from the RNG (the trailing
     rng() calls) so the seeded layout stays the one reviewed; a painted
     star holds still, and the infall's own motion carries the life. */
  const farBand = () => {
    /** @type {Star[]} */
    const stars = [];
    band(150, (x, y) => {
      stars.push({ x, y, r: 0.35 + rng() * 0.65, o: 0.1 + rng() * 0.28 });
      if (rng() < 0.14) rng();
    });
    return stars;
  };
  const nearBand = () => {
    /** @type {Star[]} */
    const stars = [];
    band(36, (x, y) => {
      const r = 0.9 + rng() * 0.9;
      stars.push({ x, y, r, o: 0.4 + rng() * 0.4 });
      if (rng() < 0.28) rng();
    });
    return stars;
  };
  const queued = { far: [farBand(), farBand(), farBand()], near: [nearBand(), nearBand(), nearBand()] };

  return {
    first: { far: [...queued.far], near: [...queued.near] },
    far: () => queued.far.shift() ?? farBand(),
    near: () => queued.near.shift() ?? nearBand(),
    mountArcs() {
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
    },
  };
}

/** Which stars each canvas currently shows, so a resize repaints the same sky. */
const showing = new WeakMap();

/**
 * Paints every .fall canvas in `host` at `side` pixels a side for the band's
 * 2200 units, so the canvas's centre is the hole. A canvas keeps the stars
 * it has; one without any yet takes the next band. Synchronous.
 * @param {HTMLElement} host @param {Sky} bands @param {number} side
 */
export function paintSky(host, bands, side) {
  for (const c of host.querySelectorAll("canvas.fall")) paintCopy(/** @type {HTMLCanvasElement} */ (c), bands, side);
}

/**
 * Fresh stars for one copy, for the instant it wraps unseen (opacity 0 at
 * the 0% keyframe): no star pattern ever comes round again, so the field
 * reads as continuous rather than as a loop.
 * @param {HTMLCanvasElement} canvas @param {Sky} bands @param {number} side
 */
export function renewCopy(canvas, bands, side) {
  showing.delete(canvas);
  paintCopy(canvas, bands, side);
}

/** @param {HTMLCanvasElement} c @param {Sky} bands @param {number} side */
function paintCopy(c, bands, side) {
  const near = c.classList.contains("fall-near");
  let stars = showing.get(c);
  if (!stars) showing.set(c, (stars = near ? bands.near() : bands.far()));
  c.width = side;
  c.height = side;
  const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  ctx.setTransform(side / 2200, 0, 0, side / 2200, side / 2, side / 2);
  for (const s of stars) {
    if (near) {
      /* The sheet's #stargl glow under a crisp core. */
      const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3.6);
      glow.addColorStop(0, "rgba(232,237,255,.45)");
      glow.addColorStop(1, "rgba(232,237,255,0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 3.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = s.o;
    ctx.fillStyle = near ? "#e8edff" : "#dbe2f5";
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
