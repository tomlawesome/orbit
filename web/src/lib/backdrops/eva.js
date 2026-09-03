/**
 * The EVA hull backdrop — settings' own spacewalk (#472, §15).
 *
 * Ported from design/v19/settings-eva.html, itself design/v19/
 * settings-concept-eva.html (the §15 "EVA wins... EVA SHIPS AS IT IS for now"
 * ruling, 2026-08-17; built now per the owner's 2026-09-03 instruction on
 * #472: "just build it and we'll polish later if necessary") reconciled
 * against the current, ratified settings content. Every settings group is an
 * open access panel on the hull: a hatch swung back on its hinges, its
 * nomenclature stencilled on the plating beside it, its controls recessed in
 * the opening. This module draws the hull, the sky and the tether; the
 * screen that mounts it owns the actual controls, each wrapped in a
 * `[data-nomen]` element this module reads for panel geometry.
 *
 * Two differences from the mockup, neither able to move a pixel (the
 * satellites.js/constellations.js/station.js law):
 *
 *   1. THE ROLL. The mockup rolled its own seed (fixed under fixtures). This
 *      module never calls Math.random(): the caller hands in the one seed for
 *      this load — `data.fixtures ? seedFromWorkspace(primary) : rollSeed()`
 *      on the settings screen — and that is the ONLY place randomness enters
 *      the backdrop.
 *   2. THE GENERATOR. Every seeded draw — the sky's stars, households and
 *      figures, the hull's micrometeorite pocks and its bolt pattern, the
 *      tether's rest phase — comes from `streamFactory` in $lib/sky.js, the
 *      one generator every seeded surface in Orbit draws from, addressed by a
 *      small integer lane and a chunk index exactly as the mockup's own copy
 *      of it is.
 *
 * THE HOUSEHOLDS drawn in the distant sky are not a fixed sample: `galaxy` is
 * `galaxyOf(workspace, today)` from $lib/data/chart.js, the same transform
 * home, create and administration draw their own skies from, so the systems
 * out here are always this instance's real households on their real true
 * bearings. The primary household (the one this settings screen belongs to)
 * is never drawn, same law as home and administration.
 *
 * UNLIKE the other living backdrops, this one is not a fixed-width design
 * space sliced to fit: the hull's geometry comes from the real page's own
 * `[data-nomen]` elements (their actual `getBoundingClientRect()`), because
 * the whole conceit is that a hatch stands exactly where its panel already
 * is. The engine therefore works in real viewport pixels and rebuilds itself
 * on resize, exactly as the mockup does.
 *
 * Imperative DOM by the same law as the other backdrops: rewriting a seeded,
 * scroll-driven hull as reactive markup is the translation that loses the
 * design. The screen that mounts this owns nothing but the element to draw
 * into, the seed to draw it from, and the real households to populate its
 * sky with.
 */
import { streamFactory } from "$lib/sky.js";

const NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} name
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
function svgEl(name, attrs) {
  const e = document.createElementNS(NS, name);
  if (attrs) for (const key in attrs) e.setAttribute(key, String(attrs[key]));
  return e;
}
/** @param {string} d @param {Record<string, string | number>} [attrs] */
const path = (d, attrs) => svgEl("path", Object.assign({ d }, attrs));
/** @param {number} n */
const F = (n) => n.toFixed(1);
/** @param {number} v @param {number} a @param {number} b */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

/** @param {string} s @param {Record<string, string | number>} attrs */
function txt(s, attrs) {
  const t = /** @type {SVGTextElement} */ (svgEl("text", Object.assign({ "font-family": MONO }, attrs)));
  t.textContent = s;
  return t;
}
/** The smallest hull tags (rail numbers, padeye labels) knock themselves out
 *  of the plate stroke-first, the way a real placard is painted. */
function tagged(/** @type {SVGTextElement} */ t) {
  t.setAttribute("paint-order", "stroke");
  t.setAttribute("stroke", "var(--tag-ground)");
  t.setAttribute("stroke-width", "2.6");
  t.setAttribute("stroke-linejoin", "round");
  t.setAttribute("stroke-opacity", ".9");
  return t;
}
/** @param {string} s @param {number} x @param {number} y @param {number} size
 *  @param {string} track @param {string} [fill] @param {string} [anchor] */
function stencil(s, x, y, size, track, fill, anchor) {
  return txt(s, {
    x: F(x), y: F(y), "font-size": size, "letter-spacing": track,
    "text-anchor": anchor || "start", fill: fill || "var(--stencil)",
  });
}
/** @param {SVGTextElement} t */
function halo(t) {
  t.setAttribute("paint-order", "stroke");
  t.setAttribute("stroke", "var(--bg)");
  t.setAttribute("stroke-width", "3.2");
  t.setAttribute("stroke-linejoin", "round");
  t.setAttribute("stroke-opacity", ".72");
  return t;
}

/* genuine asterisms, genuine names — never an invented word (§14), identical
   to every other ported sheet's own copy */
const FIGURES = [
  { name: "CASSIOPEIA", pts: [[0, 22], [24, 4], [48, 18], [72, 2], [96, 20]], edges: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  { name: "CYGNUS", pts: [[46, 0], [46, 40], [46, 74], [46, 100], [8, 36], [86, 30]], edges: [[0, 1], [1, 2], [2, 3], [4, 1], [1, 5]] },
  { name: "LYRA", pts: [[0, 0], [12, 30], [38, 24], [46, 52], [20, 58]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1]] },
  { name: "PERSEUS", pts: [[0, 8], [20, 26], [38, 20], [54, 42], [74, 48], [62, 72], [42, 62]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [3, 6], [6, 5]] },
  { name: "ANDROMEDA", pts: [[0, 4], [30, 16], [62, 26], [94, 40], [36, 50]], edges: [[0, 1], [1, 2], [2, 3], [1, 4]] },
  { name: "VELA", pts: [[0, 28], [34, 0], [70, 16], [56, 54], [16, 60]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] },
];

const GEN_STEPS = 7; /* generators either side of the crown */

/**
 * Mounts the sky, the hull and the tether into `root`, and returns a
 * teardown that removes everything this call added and every listener it
 * registered.
 *
 * @param {HTMLElement} root  a `display:contents` element to draw the
 *   backdrop into — the caller's CSS, not this module, decides its stacking
 * @param {{
 *   seed: number,
 *   galaxy: Record<string, { name: string, pos: [number, number], planets: Array<[number, number, number, string]>, items?: number }>,
 *   primary: ?string,
 * }} args
 * @returns {() => void}
 */
export function mountEva(root, { seed, galaxy, primary }) {
  const streamFor = streamFactory(seed);

  const SYSTEMS = Object.entries(galaxy ?? {})
    .filter(([id]) => id !== primary)
    .map(([id, hh]) => ({ id, name: hh.name, pos: hh.pos, planets: hh.planets, items: hh.items ?? 0 }));

  const skyDiv = document.createElement("div");
  skyDiv.className = "layer sky";
  skyDiv.setAttribute("aria-hidden", "true");
  const skySvg = svgEl("svg", { preserveAspectRatio: "none" });
  skyDiv.appendChild(skySvg);

  const hullDiv = document.createElement("div");
  hullDiv.className = "layer hull";
  hullDiv.setAttribute("aria-hidden", "true");
  const hullSvg = svgEl("svg", { preserveAspectRatio: "none" });
  hullDiv.appendChild(hullSvg);

  const rigDiv = document.createElement("div");
  rigDiv.className = "layer rig";
  rigDiv.setAttribute("aria-hidden", "true");
  const rigSvg = svgEl("svg", { preserveAspectRatio: "none" });
  rigDiv.appendChild(rigSvg);

  root.append(skyDiv, hullDiv, rigDiv);

  /* ---- one seed, an endless stream --------------------------------------
     Chunk n of lane L is a pure function of (seed, L, n): rolled the instant
     before it enters the frame, destroyed for good once it leaves, so the
     sky never loops. Lanes: 0 cloudbank, 1 dust, 2 far stars, 3 figures,
     4 households, 5 near stars, 6 hull fasteners, 7 micrometeorite pocks,
     8 tether roll. */
  /** @param {SVGElement} host @param {number} speed @param {number} par
   *  @param {number} chunkH @param {number} margin @param {number} lane
   *  @param {number} span
   *  @param {(g: SVGGElement, rng: () => number, i: number) => void} build */
  function Stream(host, speed, par, chunkH, margin, lane, span, build) {
    return {
      host, speed, par, chunkH, margin, lane, build, span, live: /** @type {Map<number, SVGGElement>} */ (new Map()),
      update(/** @type {number} */ T, /** @type {number} */ sy) {
        const off = this.speed * T + this.par * sy;
        const a = Math.floor((off - this.margin) / this.chunkH);
        const b = Math.floor((off + this.span + this.margin) / this.chunkH);
        for (const i of [...this.live.keys()])
          if (i < a || i > b) { /** @type {SVGGElement} */ (this.live.get(i)).remove(); this.live.delete(i); }
        for (let i = a; i <= b; i++) if (!this.live.has(i)) {
          const g = /** @type {SVGGElement} */ (svgEl("g", { transform: `translate(0,${(i * this.chunkH).toFixed(1)})` }));
          this.build(g, streamFor(this.lane, i), i);
          this.host.appendChild(g); this.live.set(i, g);
        }
        this.host.setAttribute("transform", `translate(0,${(-off).toFixed(1)})`);
      },
    };
  }

  let W = 0, H = 0, layers = /** @type {ReturnType<typeof Stream>[]} */ ([]);
  let skyRoot = /** @type {?SVGGElement} */ (null);
  let hullWorld = /** @type {?SVGGElement} */ (null);
  let lampG = /** @type {?SVGGElement} */ (null);
  let hullGeom = /** @type {?{ cx: number, hullL: number, hullR: number, ry: number, top: number, capC: number, capBottom: number, bot: number }} */ (null);
  let tetherRoll = /** @type {?{ phase: number, phase2: number, amp: number }} */ (null);
  let T0 = 0, T = 0, frozen = false, travel = 1, furniture = 1;
  let raf = /** @type {?number} */ (null);
  let scrollQueued = false;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const still = () => motion.matches;

  /* ---------------------------------------------------------------------
     THE SKY (the field: clock + parallax, never looping)
     ------------------------------------------------------------------- */
  function stars(/** @type {SVGGElement} */ g, /** @type {() => number} */ r, /** @type {number} */ n,
    /** @type {number} */ r0, /** @type {number} */ r1, /** @type {number} */ o0, /** @type {number} */ o1, /** @type {number} */ ch) {
    for (let i = 0; i < n; i++) g.appendChild(svgEl("circle", {
      cx: F(-0.25 * W + r() * 1.5 * W), cy: (r() * ch).toFixed(1),
      r: (r0 + r() * r1).toFixed(2), opacity: (o0 + r() * o1).toFixed(2),
    }));
  }
  function household(/** @type {SVGGElement} */ g, /** @type {() => number} */ r, /** @type {number} */ i) {
    if (SYSTEMS.length === 0) return;
    const n = SYSTEMS.length;
    const hh = SYSTEMS[(((i * 3) % n) + n) % n];
    const bearing = Math.atan2(hh.pos[1], hh.pos[0]);
    const x = W / 2 + Math.cos(bearing) * W * 0.40;
    const y = 90 + r() * 300;
    const far = r();
    const sc = 0.76 - far * 0.22;
    const dim = (0.84 - far * 0.16).toFixed(2);
    const root2 = /** @type {SVGGElement} */ (svgEl("g", { transform: `translate(${F(x)},${F(y)})`, opacity: dim }));
    const s = svgEl("g", { transform: `scale(${sc.toFixed(3)})` });
    s.appendChild(svgEl("circle", { r: "44", fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1.4", "stroke-dasharray": "3 8" }));
    s.appendChild(svgEl("circle", { r: "2.8", fill: "var(--chart-ink)" }));
    for (const [px, py, pr, tok] of hh.planets)
      s.appendChild(svgEl("circle", { cx: F(px * 0.86), cy: F(py * 0.86), r: String(pr), fill: `var(${tok})`, opacity: ".92" }));
    root2.appendChild(s);
    root2.appendChild(svgEl("line", {
      x1: "0", y1: F(-(44 * sc + 5)), x2: "0", y2: F(-(44 * sc + 16)),
      stroke: "var(--chart-ink)", "stroke-width": "1", opacity: ".66",
    }));
    root2.appendChild(halo(txt(hh.name.toUpperCase(), {
      x: "0", y: F(-(44 * sc + 26)), "font-size": "10", "letter-spacing": ".13em",
      "text-anchor": "middle", opacity: ".92", fill: "var(--chart-ink)",
    })));
    root2.appendChild(halo(txt(hh.items + (hh.items === 1 ? " ITEM" : " ITEMS"), {
      x: "0", y: F(44 * sc + 21), "font-size": "8.5", "letter-spacing": ".12em",
      "text-anchor": "middle", opacity: ".72", fill: "var(--chart-ink)",
    })));
    g.appendChild(root2);
  }
  function figure(/** @type {SVGGElement} */ g, /** @type {() => number} */ r) {
    const f = FIGURES[Math.floor(r() * FIGURES.length)];
    const spanx = Math.max(...f.pts.map((p) => p[0])), spany = Math.max(...f.pts.map((p) => p[1]));
    const sc = 0.85 + r() * 0.4;
    const x = W / 2 - (spanx * sc) / 2 + (r() - 0.5) * W * 0.95;
    const y = 40 + r() * 340;
    const root2 = /** @type {SVGGElement} */ (svgEl("g", {
      transform: `translate(${F(x)},${F(y)}) scale(${sc.toFixed(3)})`,
      opacity: (0.42 + r() * 0.14).toFixed(2),
    }));
    let d = "";
    for (const [a, b] of f.edges) d += `M ${f.pts[a][0]} ${f.pts[a][1]} L ${f.pts[b][0]} ${f.pts[b][1]} `;
    root2.appendChild(svgEl("path", { d, fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1.1", opacity: ".62" }));
    for (const [px, py] of f.pts)
      root2.appendChild(svgEl("circle", { cx: String(px), cy: String(py), r: (1.5 + r() * 1).toFixed(2), fill: "var(--star-far)", opacity: ".9" }));
    root2.appendChild(halo(txt(f.name, {
      x: F(spanx / 2), y: F(spany + 20), "font-size": "8.5", "letter-spacing": ".2em",
      "text-anchor": "middle", opacity: ".85", fill: "var(--chart-ink)",
    })));
    g.appendChild(root2);
  }
  /* the day-side packs are not looking at stars, they are looking DOWN at
     weather: soft banks that only exist where --cloud-op says they do */
  function cloudbank(/** @type {SVGGElement} */ g, /** @type {() => number} */ r) {
    const n = 3 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const x = -0.2 * W + r() * 1.4 * W, y = r() * 440;
      const w = W * (0.07 + r() * 0.11), h = w * (0.15 + r() * 0.10);
      const bank = svgEl("g", { opacity: (0.34 + r() * 0.42).toFixed(2), filter: "url(#eva-soft)" });
      for (let j = 0; j < 6; j++) {
        const t = j / 5;
        bank.appendChild(svgEl("ellipse", {
          cx: F(x + w * (t - 0.5) * 1.7), cy: F(y + (r() - 0.5) * h * 0.8),
          rx: F(w * (0.26 + r() * 0.26)), ry: F(h * (0.5 + r() * 0.8)), fill: "#ffffff",
        }));
      }
      g.appendChild(bank);
    }
  }

  function drawSky() {
    skySvg.textContent = "";
    skySvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const sdefs = svgEl("defs");
    const soft = svgEl("filter", { id: "eva-soft", x: "-40%", y: "-70%", width: "180%", height: "240%" });
    soft.appendChild(svgEl("feGaussianBlur", { stdDeviation: "9" }));
    sdefs.appendChild(soft);
    skySvg.appendChild(sdefs);
    skyRoot = /** @type {SVGGElement} */ (svgEl("g"));
    skySvg.appendChild(skyRoot);
    const gCloud = svgEl("g", { opacity: "var(--cloud-op)" });
    const gDust = svgEl("g", { fill: "var(--star-far)", opacity: "var(--stars)" });
    const gFar = svgEl("g", { fill: "var(--star-far)", opacity: "var(--stars)" });
    const gFig = svgEl("g", { opacity: "var(--field-op)" });
    const gHH = svgEl("g", { opacity: "var(--field-op)" });
    const gNear = svgEl("g", { fill: "var(--star-near)", opacity: "var(--stars)" });
    for (const L of [gCloud, gDust, gFar, gFig, gHH, gNear]) skyRoot.appendChild(L);

    const dens = (/** @type {number} */ chunkH, /** @type {number} */ per) => Math.max(4, Math.round((W * chunkH) / per));
    layers = [
      Stream(gCloud, 1.1, 0.045, 460, 460, 0, H + 200, (g, r) => cloudbank(g, r)),
      Stream(gDust, 1.5, 0.050, 320, 320, 1, H + 200, (g, r) => stars(g, r, dens(320, 6200), 0.26, 0.3, 0.07, 0.13, 320)),
      Stream(gFar, 2.7, 0.072, 300, 300, 2, H + 200, (g, r) => stars(g, r, dens(300, 9600), 0.45, 0.55, 0.16, 0.28, 300)),
      Stream(gFig, 3.3, 0.088, 520, 520, 3, H + 200, (g, r) => { if (r() < 0.5) figure(g, r); }),
      Stream(gHH, 4.8, 0.110, 470, 470, 4, H + 200, (g, r, i) => { if (r() < 0.68) household(g, r, i); }),
      Stream(gNear, 7.6, 0.150, 300, 300, 5, H + 200, (g, r) => stars(g, r, dens(300, 42000), 0.9, 0.8, 0.34, 0.44, 300)),
    ];
  }

  /* ---------------------------------------------------------------------
     THE HULL (the overlay world: bolted to the page, 1:1, no clock)
     ------------------------------------------------------------------- */
  function courseArc(/** @type {NonNullable<typeof hullGeom>} */ g0, /** @type {number} */ y, /** @type {number} */ sag) {
    return `M ${F(g0.hullL)} ${F(y)} Q ${F(g0.cx)} ${F(y + sag * 2)} ${F(g0.hullR)} ${F(y)}`;
  }
  /** @param {"linearGradient" | "radialGradient"} kind */
  function grad(kind, /** @type {string} */ id, /** @type {Record<string, string | number>} */ attrs,
    /** @type {[string, string, number][]} */ stops) {
    const g = svgEl(kind, Object.assign({ id, gradientUnits: "userSpaceOnUse" }, attrs));
    for (const [o, c, op] of stops) g.appendChild(svgEl("stop", { offset: o, "stop-color": c, "stop-opacity": op }));
    return g;
  }

  /** @typedef {{ x: number, y: number, w: number, h: number, nomen: string, sub: string, hinge: number, airlock: boolean }} Panel */

  /** ---- ONE ACCESS PANEL: opening, chamfer, hinges, swung door, plant marking */
  function accessPanel(/** @type {SVGElement} */ g, /** @type {Panel} */ m) {
    const s = m.hinge;
    const pad = 15, gap = 23, leafW = 31, tp = 11;
    const x = m.x - pad, y = m.y - pad, w = m.w + pad * 2, h = m.h + pad * 2, rx = 12;
    const hx = s < 0 ? x : x + w;
    const fx = s < 0 ? x + w : x;
    const doorA = hx + s * gap, doorB = hx + s * (gap + leafW);

    const shadow = svgEl("g", { opacity: ".5" });
    shadow.appendChild(path(`M ${F(doorA)} ${F(y + 6)} L ${F(doorB + s * 8)} ${F(y - tp + 6)}
      L ${F(doorB + s * 8)} ${F(y + h + tp + 10)} L ${F(doorA)} ${F(y + h + 6)} Z`,
      { fill: "rgba(0,0,0,.35)" }));
    g.appendChild(shadow);
    const door = svgEl("g");
    door.appendChild(path(`M ${F(doorA)} ${F(y + 2)} L ${F(doorB)} ${F(y - tp)}
      L ${F(doorB)} ${F(y + h + tp)} L ${F(doorA)} ${F(y + h - 2)} Z`,
      { fill: "var(--door-back)" }));
    door.appendChild(path(`M ${F(doorA)} ${F(y + 2)} L ${F(doorA + s * 5)} ${F(y + 1)}
      L ${F(doorA + s * 5)} ${F(y + h - 1)} L ${F(doorA)} ${F(y + h - 2)} Z`,
      { fill: "var(--door-edge)" }));
    for (let q = 1; q * 26 < h; q++) {
      const t = (q * 26) / h;
      door.appendChild(path(`M ${F(doorA)} ${F(y + 2 + (h - 4) * t)} L ${F(doorB)} ${F(y - tp + (h + tp * 2) * t)}`,
        { stroke: "var(--seam)", "stroke-width": ".8", opacity: ".5", fill: "none" }));
    }
    door.appendChild(path(`M ${F(doorA)} ${F(y + 2)} L ${F(doorB)} ${F(y - tp)}`,
      { stroke: "var(--metal-hi)", "stroke-width": "1", opacity: ".45", fill: "none" }));
    const pcx = Math.min(doorA, doorB) + 7;
    door.appendChild(svgEl("rect", { x: F(pcx), y: F(y + h * 0.42), width: F(leafW - 15), height: "16", rx: "2", fill: "var(--door)", stroke: "var(--metal-lo)", "stroke-width": ".8" }));
    door.appendChild(svgEl("rect", { x: F(pcx + 2.5), y: F(y + h * 0.42 + 4), width: F(leafW - 20), height: "2", rx: "1", fill: "var(--stencil-sub)", opacity: ".55" }));
    door.appendChild(svgEl("rect", { x: F(pcx + 2.5), y: F(y + h * 0.42 + 9), width: F(leafW - 24), height: "2", rx: "1", fill: "var(--stencil-sub)", opacity: ".4" }));
    door.appendChild(path(`M ${F(doorB)} ${F(y - tp)} L ${F(doorB)} ${F(y + h + tp)}`,
      { stroke: "var(--metal-hi)", "stroke-width": "1.4", opacity: ".5", fill: "none" }));
    door.appendChild(path(`M ${F(doorA)} ${F(y + 2)} L ${F(doorA)} ${F(y + h - 2)}`,
      { stroke: "rgba(0,0,0,.45)", "stroke-width": "2", fill: "none" }));
    g.appendChild(door);

    for (const t of [0.14, 0.5, 0.86]) {
      const ky = y + h * t;
      const a = Math.min(hx + s * 2, doorA + s * 2), b = Math.max(hx + s * 2, doorA + s * 2);
      const kn = svgEl("g");
      kn.appendChild(svgEl("rect", { x: F(a - 1), y: F(ky - 10), width: F(b - a + 2), height: "20", rx: "3", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1" }));
      const px = (a + b) / 2;
      kn.appendChild(svgEl("rect", { x: F(px - 4.6), y: F(ky - 15), width: "9.2", height: "30", rx: "4.6", fill: "var(--metal)", stroke: "var(--metal-lo)", "stroke-width": "1" }));
      kn.appendChild(svgEl("line", { x1: F(px), y1: F(ky - 19), x2: F(px), y2: F(ky + 19), stroke: "var(--metal-lo)", "stroke-width": "3.6", "stroke-linecap": "round" }));
      kn.appendChild(svgEl("line", { x1: F(px - 1.1), y1: F(ky - 17), x2: F(px - 1.1), y2: F(ky + 17), stroke: "var(--metal-hi)", "stroke-width": "1.1", opacity: ".85" }));
      kn.appendChild(svgEl("circle", { cx: F(px), cy: F(ky - 20), r: "3.1", fill: "var(--metal)", stroke: "var(--metal-hi)", "stroke-width": ".9" }));
      kn.appendChild(svgEl("line", { x1: F(px - 3), y1: F(ky + 20), x2: F(px + 3), y2: F(ky + 20), stroke: "var(--metal-hi)", "stroke-width": "1.1", opacity: ".7" }));
      for (const fy of [ky - 6.5, ky + 6.5])
        kn.appendChild(svgEl("circle", { cx: F(hx + s * 7), cy: F(fy), r: "1.6", fill: "var(--metal-hi)", opacity: ".6" }));
      g.appendChild(kn);
    }
    g.appendChild(svgEl("rect", { x: F(s < 0 ? hx - 9 : hx + 1), y: F(y + 4), width: "8", height: F(h - 8), rx: "2", fill: "var(--metal-lo)", opacity: ".9" }));

    g.appendChild(svgEl("rect", { x: F(x), y: F(y), width: F(w), height: F(h), rx: String(rx), fill: "var(--recess)" }));
    g.appendChild(svgEl("rect", { x: F(x - 1.5), y: F(y - 1.5), width: F(w + 3), height: F(h + 3), rx: F(rx + 1.5), fill: "none", stroke: "var(--lip-lo)", "stroke-width": "3" }));
    g.appendChild(path(`M ${F(x - 1)} ${F(y + h - rx)} L ${F(x - 1)} ${F(y + rx - 1)}
        Q ${F(x - 1)} ${F(y - 1)} ${F(x + rx)} ${F(y - 1)} L ${F(x + w - rx)} ${F(y - 1)}`,
      { fill: "none", stroke: "var(--lip-hi)", "stroke-width": "2", "stroke-linecap": "round" }));

    for (const t of [0.28, 0.72]) {
      const cy = y + h * t, cx = fx - s * 7.5;
      g.appendChild(svgEl("circle", { cx: F(cx), cy: F(cy), r: "4.2", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1" }));
      g.appendChild(svgEl("line", { x1: F(cx - 2.4), y1: F(cy - 2.4), x2: F(cx + 2.4), y2: F(cy + 2.4), stroke: "var(--metal-hi)", "stroke-width": "1.2", opacity: ".85" }));
    }

    g.appendChild(stencil(m.nomen, x + 2, y - 17, 11.5, ".2em"));
    g.appendChild(stencil(m.sub, x + w - 1, y - 17, 8.5, ".16em", "var(--stencil-sub)", "end"));
    g.appendChild(path(`M ${F(x + 2)} ${F(y - 11)} L ${F(x + w - 1)} ${F(y - 11)}`,
      { stroke: "var(--stencil-sub)", "stroke-width": ".8", opacity: ".45", fill: "none" }));
  }

  /** ---- THE AIRLOCK: the round crew-lock hatch, closed, with Quest's own nomenclature */
  function airlockHatch(/** @type {SVGElement} */ g, /** @type {Panel} */ m) {
    const cx = m.x + m.w / 2, cy = m.y + 110, R = Math.min(150, m.w * 0.46);
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(cy), r: F(R + 15), fill: "var(--plate-shade)", opacity: ".55" }));
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(cy), r: F(R + 15), fill: "none", stroke: "var(--lip-lo)", "stroke-width": "3" }));
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(cy), r: F(R + 9), fill: "none", stroke: "var(--lip-hi)", "stroke-width": "1.4" }));
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(cy), r: F(R), fill: "var(--door)", stroke: "var(--metal-lo)", "stroke-width": "2" }));
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(cy), r: F(R), fill: "url(#eva-hatchface)" }));
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(cy), r: F(R - 7), fill: "none", stroke: "var(--seam)", "stroke-width": "1" }));
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI * 2 * k) / 6 + 0.26;
      const rx = cx + Math.cos(a) * (R - 15), ry = cy + Math.sin(a) * (R - 15);
      g.appendChild(svgEl("rect", {
        x: F(rx - 7), y: F(ry - 4), width: "14", height: "8", rx: "2",
        transform: `rotate(${F((a * 180) / Math.PI)} ${F(rx)} ${F(ry)})`,
        fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1",
      }));
    }
    g.appendChild(svgEl("rect", { x: F(cx - 38), y: F(cy + R - 30), width: "76", height: "10", rx: "5", fill: "var(--metal-lo)", stroke: "var(--metal-hi)", "stroke-width": "1.2" }));
    for (const sx of [-31, 31])
      g.appendChild(svgEl("rect", { x: F(cx + sx - 3.5), y: F(cy + R - 21), width: "7", height: "11", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": ".8" }));
    const wy = cy - R * 0.46;
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(wy), r: "40", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "2.4" }));
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI * 2 * k) / 8 + 0.4;
      g.appendChild(svgEl("circle", { cx: F(cx + Math.cos(a) * 35), cy: F(wy + Math.sin(a) * 35), r: "1.8", fill: "var(--metal-hi)", opacity: ".6" }));
    }
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(wy), r: "31", fill: "var(--recess)" }));
    g.appendChild(svgEl("circle", { cx: F(cx), cy: F(wy), r: "31", fill: "var(--alk-glow)", opacity: ".38" }));
    g.appendChild(path(`M ${F(cx - 23)} ${F(wy + 14)} Q ${F(cx - 6)} ${F(wy - 19)} ${F(cx + 19)} ${F(wy - 22)}`,
      { fill: "none", stroke: "#ffffff", "stroke-width": "4", opacity: ".2" }));
    g.appendChild(path(`M ${F(cx - R - 15)} ${F(cy - 26)} h -26 v 52 h 26`,
      { fill: "none", stroke: "var(--metal)", "stroke-width": "3" }));
    g.appendChild(svgEl("circle", { cx: F(cx - R - 41), cy: F(cy), r: "6", fill: "var(--metal-lo)", stroke: "var(--metal-hi)", "stroke-width": "1.2" }));

    g.appendChild(stencil(m.nomen, cx, cy - R - 44, 12.5, ".26em", "var(--stencil)", "middle"));
    g.appendChild(stencil(m.sub, cx, cy - R - 29, 8.5, ".2em", "var(--stencil-sub)", "middle"));
    g.appendChild(stencil("RETURN TO AIRLOCK", cx, cy + R + 34, 10.5, ".3em", "var(--stencil)", "middle"));
    g.appendChild(path(`M ${F(cx)} ${F(cy + R + 46)} v 26 m -6 -8 l 6 8 l 6 -8`,
      { fill: "none", stroke: "var(--stencil-sub)", "stroke-width": "1.4" }));
    g.appendChild(stencil("EQUIP LOCK", cx - R - 46, cy + 4, 9, ".2em", "var(--stencil-sub)", "end"));
    g.appendChild(stencil("EVA 04 · 6h 12m", cx + R + 46, cy + 4, 9, ".2em", "var(--stencil-sub)"));
  }

  /** ---- an EVA handrail: two standoffs, a bar, and a number */
  function handrail(/** @type {SVGElement} */ g, /** @type {number} */ x, /** @type {number} */ y0,
    /** @type {number} */ y1, /** @type {number} */ n, /** @type {boolean} */ num) {
    const segH = 330, bar = 9;
    for (let y = y0; y < y1; y += segH) {
      const a = y + 16, b = Math.min(y + segH - 22, y1);
      if (b - a < 60) continue;
      g.appendChild(svgEl("rect", { x: F(x + 7), y: F(a + 5), width: F(bar), height: F(b - a), rx: F(bar / 2), fill: "rgba(0,0,0,.22)" }));
      for (const sy of [a + 10, b - 10]) {
        g.appendChild(svgEl("rect", { x: F(x - 13), y: F(sy - 9), width: "26", height: "18", rx: "3", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1" }));
        for (const fx of [-8.5, 8.5])
          g.appendChild(svgEl("circle", { cx: F(x + fx), cy: F(sy), r: "1.9", fill: "var(--metal-hi)", opacity: ".7" }));
        g.appendChild(svgEl("rect", { x: F(x - 3.5), y: F(sy - 5), width: "7", height: "10", fill: "var(--metal)", opacity: ".9" }));
      }
      g.appendChild(svgEl("rect", { x: F(x - bar / 2), y: F(a), width: F(bar), height: F(b - a), rx: F(bar / 2), fill: "var(--metal)", stroke: "var(--metal-lo)", "stroke-width": "1" }));
      g.appendChild(svgEl("rect", { x: F(x - bar / 2 + 1.6), y: F(a + 4), width: "2.2", height: F(b - a - 8), rx: "1.1", fill: "var(--metal-hi)", opacity: ".75" }));
      if (num) {
        const t = tagged(stencil("HR " + String(400 + (n % 60) * 7).padStart(4, "0"), x + 24, a + 22, 8, ".18em", "var(--stencil-sub)"));
        t.setAttribute("transform", `rotate(90 ${F(x + 24)} ${F(a + 22)})`);
        g.appendChild(t);
      }
      n++;
    }
  }
  /** ---- a tether anchor: a padeye welded to a base plate */
  function padeye(/** @type {SVGElement} */ g, /** @type {number} */ x, /** @type {number} */ y, /** @type {?string} */ label) {
    g.appendChild(svgEl("rect", { x: F(x - 14), y: F(y - 11), width: "28", height: "22", rx: "3", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1" }));
    for (const [dx, dy] of [[-9, -6], [9, -6], [-9, 6], [9, 6]])
      g.appendChild(svgEl("circle", { cx: F(x + dx), cy: F(y + dy), r: "1.7", fill: "var(--metal-hi)", opacity: ".65" }));
    g.appendChild(path(`M ${F(x - 7)} ${F(y)} a 7 8 0 1 1 14 0`, { fill: "none", stroke: "var(--metal)", "stroke-width": "3.2" }));
    g.appendChild(path(`M ${F(x - 6)} ${F(y - 1)} a 6 7 0 1 1 12 0`, { fill: "none", stroke: "var(--metal-hi)", "stroke-width": "1", opacity: ".7" }));
    if (label) g.appendChild(tagged(stencil(label, x + 26, y + 3, 8, ".18em", "var(--stencil-sub)")));
  }

  function drawHull() {
    hullSvg.textContent = "";
    hullSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const defs = svgEl("defs");
    hullSvg.appendChild(defs);

    const sy = window.scrollY;
    const rectOf = (/** @type {Element} */ e) => {
      const b = e.getBoundingClientRect();
      return { x: b.left + window.scrollX, y: b.top + sy, w: b.width, h: b.height };
    };
    const panels = /** @type {Panel[]} */ ([...document.querySelectorAll("[data-nomen]")].map((e) => Object.assign(
      rectOf(e),
      {
        nomen: /** @type {HTMLElement} */ (e).dataset.nomen ?? "",
        sub: /** @type {HTMLElement} */ (e).dataset.sub ?? "",
        hinge: Number(/** @type {HTMLElement} */ (e).dataset.hinge || -1),
        airlock: e.id === "airlock",
      },
    )));
    if (!panels.length) return;

    const col = panels[0];
    const cx = W / 2;
    const skyMin = clamp(W * 0.055, 28, 112);
    const hullR = Math.min(W / 2 - skyMin, col.w / 2 + 168);
    const hullL = cx - hullR, hullRt = cx + hullR;
    const ry = hullR * 0.072;
    const marginL = col.x - hullL;
    furniture = clamp((marginL - 56) / 46, 0, 1);

    const capBottom = col.y - 132;
    const capC = capBottom - ry;
    const top = capC - ry;
    const docH = Math.max(document.documentElement.scrollHeight, sy + H);
    const bot = docH + 420;
    const g0 = { cx, hullL, hullR: hullRt, ry, top, capC, capBottom, bot };
    hullGeom = g0;

    hullWorld = /** @type {SVGGElement} */ (svgEl("g"));
    hullSvg.appendChild(hullWorld);

    defs.appendChild(grad("linearGradient", "eva-cyl", { x1: F(hullL), y1: "0", x2: F(hullRt), y2: "0" },
      [["0", "var(--plate-shade)", 1], [".14", "var(--plate)", 1], [".46", "var(--plate-lit)", 1],
        [".76", "var(--plate)", 1], ["1", "var(--plate-shade)", 1]]));
    defs.appendChild(grad("linearGradient", "eva-sun", { x1: F(hullL), y1: F(top), x2: F(hullRt), y2: F(top + H * 1.2) },
      [["0", "var(--sun-tint)", 0.9], [".42", "var(--sun-tint)", 0.14], ["1", "var(--sun-tint)", 0]]));
    defs.appendChild(grad("linearGradient", "eva-aft", { x1: "0", y1: F(bot - H * 2.1), x2: "0", y2: F(bot) },
      [["0", "#000000", 0], ["1", "#000000", 0.55]]));
    defs.appendChild(grad("radialGradient", "eva-lamp",
      { cx: "0", cy: "0", r: F(Math.max(W, H) * 0.46), fx: "0", fy: "0" },
      [["0", "var(--lamp)", 0.95], [".26", "var(--lamp)", 0.52], [".62", "var(--lamp)", 0.16], ["1", "var(--lamp)", 0]]));
    {
      const hf = svgEl("radialGradient", { id: "eva-hatchface", cx: ".34", cy: ".26", r: ".78", fx: ".34", fy: ".26" });
      for (const [o, c, op] of [[0, "#ffffff", 0.13], [0.55, "#ffffff", 0.03], [1, "#000000", 0.26]])
        hf.appendChild(svgEl("stop", { offset: String(o), "stop-color": String(c), "stop-opacity": op }));
      defs.appendChild(hf);
    }
    const body = `M ${F(hullL)} ${F(capC)} A ${F(hullR)} ${F(ry)} 0 0 1 ${F(hullRt)} ${F(capC)}
                  L ${F(hullRt)} ${F(bot)} L ${F(hullL)} ${F(bot)} Z`;
    const clip = svgEl("clipPath", { id: "eva-hullclip" });
    clip.appendChild(path(body));
    defs.appendChild(clip);
    const skin = svgEl("g", { "clip-path": "url(#eva-hullclip)" });
    hullWorld.appendChild(skin);
    skin.appendChild(path(body, { fill: "url(#eva-cyl)" }));

    const pitch = 132;
    for (let y = capBottom + pitch; y < bot; y += pitch) {
      skin.appendChild(path(courseArc(g0, y, ry * 0.92), { fill: "none", stroke: "var(--seam)", "stroke-width": "1.4" }));
      skin.appendChild(path(courseArc(g0, y + 2.2, ry * 0.92), { fill: "none", stroke: "var(--seam-hi)", "stroke-width": "1" }));
    }
    for (let k = -GEN_STEPS; k <= GEN_STEPS; k++) {
      if (!k) continue;
      const gx = cx + hullR * Math.sin((k / (GEN_STEPS + 0.6)) * (Math.PI / 2));
      skin.appendChild(path(`M ${F(gx)} ${F(capBottom)} L ${F(gx)} ${F(bot)}`, { stroke: "var(--seam)", "stroke-width": "1", opacity: ".75", fill: "none" }));
      skin.appendChild(path(`M ${F(gx + 1.6)} ${F(capBottom)} L ${F(gx + 1.6)} ${F(bot)}`, { stroke: "var(--seam-hi)", "stroke-width": ".9", fill: "none" }));
    }
    {
      const r = streamFor(6, 1);
      for (let y = capBottom + pitch; y < bot; y += pitch)
        for (let k = -GEN_STEPS; k <= GEN_STEPS; k++) {
          if (!k || r() < 0.45) continue;
          const gx = cx + hullR * Math.sin((k / (GEN_STEPS + 0.6)) * (Math.PI / 2));
          const yy = y + ry * 0.92 * 2 * (1 - Math.pow((gx - cx) / hullR, 2)) * 0.5;
          skin.appendChild(svgEl("circle", { cx: F(gx), cy: F(yy + 9), r: "1.5", fill: "var(--metal-lo)", stroke: "var(--metal-hi)", "stroke-width": ".5", opacity: ".55" }));
        }
    }

    for (let c = Math.floor(top / 400); c * 400 < bot; c++) {
      const r = streamFor(7, c);
      const n = Math.round((hullR * 2 * 400) / 17000);
      for (let i = 0; i < n; i++) {
        const px = hullL + r() * hullR * 2, py = c * 400 + r() * 400;
        if (py < capBottom + 8) continue;
        const rad = 1.0 + r() * r() * 4.0;
        skin.appendChild(svgEl("circle", { cx: F(px), cy: F(py), r: F(rad), fill: "var(--pock)" }));
        skin.appendChild(path(`M ${F(px - rad)} ${F(py)} a ${F(rad)} ${F(rad)} 0 0 1 ${F(rad * 2)} 0`, { fill: "none", stroke: "var(--pock-rim)", "stroke-width": "1.1" }));
        if (rad > 2.6)
          skin.appendChild(svgEl("circle", { cx: F(px), cy: F(py), r: F(rad * 2.1), fill: "none", stroke: "var(--pock-rim)", "stroke-width": ".7", opacity: ".45" }));
      }
    }

    const ring = svgEl("g");
    hullWorld.appendChild(ring);
    ring.appendChild(svgEl("ellipse", { cx: F(cx), cy: F(capC), rx: F(hullR), ry: F(ry), fill: "var(--plate-shade)" }));
    ring.appendChild(svgEl("ellipse", { cx: F(cx), cy: F(capC), rx: F(hullR * 0.9), ry: F(ry * 0.9), fill: "none", stroke: "var(--seam)", "stroke-width": "1.2" }));
    for (let k = 0; k < 16; k++) {
      const a = (Math.PI * 2 * k) / 16;
      const bx = cx + Math.cos(a) * hullR * 0.955, by = capC + Math.sin(a) * ry * 0.955;
      ring.appendChild(svgEl("circle", { cx: F(bx), cy: F(by), r: "2.6", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1" }));
    }
    ring.appendChild(path(`M ${F(hullL)} ${F(capC)} A ${F(hullR)} ${F(ry)} 0 0 0 ${F(hullRt)} ${F(capC)}`, { fill: "none", stroke: "var(--metal-hi)", "stroke-width": "1.6", opacity: ".55" }));
    ring.appendChild(path(`M ${F(hullL)} ${F(capC)} A ${F(hullR)} ${F(ry)} 0 0 1 ${F(hullRt)} ${F(capC)}`, { fill: "none", stroke: "var(--metal-hi)", "stroke-width": "1.4", opacity: ".7" }));
    ring.appendChild(stencil("ORB-1 · SEG 04 · FWD", cx, capBottom + 26, 10, ".26em", "var(--stencil)", "middle"));
    ring.appendChild(stencil("MMOD SHIELD · DO NOT STEP", cx, capBottom + 41, 8, ".2em", "var(--stencil-sub)", "middle"));

    hullWorld.appendChild(path(`M ${F(hullL)} ${F(capC)} L ${F(hullL)} ${F(bot)}`, { stroke: "var(--metal-hi)", "stroke-width": "1.2", opacity: ".28", fill: "none" }));
    hullWorld.appendChild(path(`M ${F(hullRt)} ${F(capC)} L ${F(hullRt)} ${F(bot)}`, { stroke: "var(--metal-hi)", "stroke-width": "1.2", opacity: ".28", fill: "none" }));

    const furn = svgEl("g", { opacity: furniture.toFixed(2) });
    hullWorld.appendChild(furn);
    const railL = hullL + marginL * 0.42, railR = W - railL;
    if (furniture > 0) {
      handrail(furn, railL, capBottom + 40, bot - 160, 3, true);
      handrail(furn, railR, capBottom + 40, bot - 160, 21, false);
      let k = 0;
      for (let y = capBottom + 210; y < bot - 200; y += 330, k++) {
        padeye(furn, railL, y, k % 2 ? null : "WIF " + (11 + k));
        padeye(furn, railR, y, null);
      }
      const tx = railR - 21, ty = capBottom + 250;
      const t = stencil("EVA TRANSLATION PATH", tx, ty, 8.5, ".24em", "var(--stencil-sub)");
      t.setAttribute("transform", `rotate(90 ${F(tx)} ${F(ty)})`);
      furn.appendChild(t);
    }

    if (furniture > 0) {
      const conX = Math.min(railR + 26, hullRt - 24);
      const cg = svgEl("g", { opacity: (furniture * 0.95).toFixed(2) });
      for (const dx of [-4.5, 4.5]) {
        cg.appendChild(path(`M ${F(conX + dx + 2)} ${F(capBottom + 60)} L ${F(conX + dx + 2)} ${F(bot - 120)}`, { stroke: "rgba(0,0,0,.32)", "stroke-width": "5", fill: "none" }));
        cg.appendChild(path(`M ${F(conX + dx)} ${F(capBottom + 60)} L ${F(conX + dx)} ${F(bot - 120)}`, { stroke: "var(--metal-lo)", "stroke-width": "5.4", fill: "none" }));
        cg.appendChild(path(`M ${F(conX + dx - 1.4)} ${F(capBottom + 60)} L ${F(conX + dx - 1.4)} ${F(bot - 120)}`, { stroke: "var(--metal)", "stroke-width": "1.4", opacity: ".8", fill: "none" }));
      }
      for (let y = capBottom + 120; y < bot - 140; y += 230) {
        cg.appendChild(svgEl("rect", { x: F(conX - 10), y: F(y - 6), width: "20", height: "12", rx: "3", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1" }));
        cg.appendChild(svgEl("circle", { cx: F(conX), cy: F(y), r: "1.7", fill: "var(--metal-hi)", opacity: ".65" }));
      }
      hullWorld.appendChild(cg);
    }

    const pg = svgEl("g");
    hullWorld.appendChild(pg);
    for (const m of panels) {
      if (m.airlock) airlockHatch(pg, m);
      else accessPanel(pg, m);
    }

    hullWorld.appendChild(path(body, { fill: "url(#eva-sun)", opacity: "var(--sunwash)" }));
    const lampWrap = svgEl("g", { "clip-path": "url(#eva-hullclip)" });
    hullWorld.appendChild(lampWrap);
    lampG = /** @type {SVGGElement} */ (svgEl("g"));
    lampWrap.appendChild(lampG);
    const pool = svgEl("circle", { r: F(Math.max(W, H) * 0.46), fill: "url(#eva-lamp)", opacity: "var(--lamp-op)" });
    lampG.appendChild(pool);
    hullWorld.appendChild(path(body, { fill: "url(#eva-aft)" }));
  }

  /* ---------------------------------------------------------------------
     THE RIG (yours: fixed in the frame — the tether, and the hook on the rail)
     ------------------------------------------------------------------- */
  function drawRig() {
    rigSvg.textContent = "";
    rigSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const r = streamFor(8, 5);
    tetherRoll = { phase: r() * 6.28, phase2: r() * 6.28, amp: 5 + r() * 3 };
    const g = svgEl("g", { id: "eva-tether", opacity: furniture.toFixed(2) });
    rigSvg.appendChild(g);
  }
  function drawTether() {
    const g = document.getElementById("eva-tether");
    const card = document.querySelector(".card");
    if (!g || !hullGeom || !card || !tetherRoll) return;
    g.textContent = "";
    const hookX = hullGeom.hullL + (card.getBoundingClientRect().left + window.scrollX - hullGeom.hullL) * 0.42;
    const hookY = H * 0.38;
    const sw = frozen ? 0 : 1;
    const s1 = Math.sin(T * 0.42 + tetherRoll.phase) * tetherRoll.amp * sw;
    const s2 = Math.sin(T * 0.27 + tetherRoll.phase2) * tetherRoll.amp * 1.8 * sw;

    const d = `M ${F(hookX - 13)} ${F(hookY + 41)}
               C ${F(hookX - 16 + s1)} ${F(hookY + 155 + s2)},
                 ${F(hookX - 64 + s2)} ${F(hookY + 258 - s1)},
                 -40.0 ${F(H + 60)}`;
    g.appendChild(path(d, { fill: "none", stroke: "rgba(0,0,0,.45)", "stroke-width": "8", opacity: ".5" }));
    g.appendChild(path(d, { fill: "none", stroke: "var(--metal-lo)", "stroke-width": "6.4" }));
    g.appendChild(path(d, { fill: "none", stroke: "var(--metal)", "stroke-width": "4" }));
    g.appendChild(path(d, { fill: "none", stroke: "var(--metal-hi)", "stroke-width": "1.2", opacity: ".55" }));

    const h = svgEl("g", { transform: `translate(${F(hookX)},${F(hookY)}) rotate(${F(s1 * 0.4)})` });
    const RH = 17, cyh = -10, C = 2 * Math.PI * RH;
    const pt = (/** @type {number} */ a) => [RH * Math.cos((a * Math.PI) / 180), cyh + RH * Math.sin((a * Math.PI) / 180)];
    const ring = (/** @type {number} */ from, /** @type {number} */ to, /** @type {number} */ w, /** @type {string} */ col, /** @type {number | undefined} */ op) =>
      svgEl("circle", {
        cx: "0", cy: F(cyh), r: String(RH), fill: "none",
        stroke: col, "stroke-width": w, "stroke-linecap": "round", opacity: op == null ? 1 : op,
        "stroke-dasharray": `${F((C * ((to - from + 360) % 360)) / 360)} ${F(C)}`,
        "stroke-dashoffset": F((-C * from) / 360),
      });
    const [ax, ay] = pt(38), [bx, by] = pt(-52);
    h.appendChild(ring(38, 308, 9, "var(--metal-lo)", undefined));
    h.appendChild(ring(38, 308, 6.4, "var(--metal)", undefined));
    h.appendChild(svgEl("rect", { x: "-4.5", y: "-48", width: "9", height: "96", rx: "4.5", fill: "var(--metal)", stroke: "var(--metal-lo)", "stroke-width": "1" }));
    h.appendChild(svgEl("rect", { x: "-2.9", y: "-46", width: "2.2", height: "92", rx: "1.1", fill: "var(--metal-hi)", opacity: ".7" }));
    h.appendChild(ring(58, 132, 9, "var(--metal-lo)", undefined));
    h.appendChild(ring(58, 132, 6.4, "var(--metal)", undefined));
    h.appendChild(ring(58, 132, 1.4, "var(--metal-hi)", 0.5));
    h.appendChild(path(`M ${F(bx)} ${F(by)} L ${F(ax)} ${F(ay)}`, { fill: "none", stroke: "var(--metal-hi)", "stroke-width": "2.2", opacity: ".9" }));
    h.appendChild(svgEl("circle", { cx: F(bx), cy: F(by), r: "2.4", fill: "var(--metal-lo)", stroke: "var(--metal-hi)", "stroke-width": "1" }));
    const [shx, shy] = pt(138);
    h.appendChild(path(`M ${F(shx)} ${F(shy)} L -13 23`, { fill: "none", stroke: "var(--metal)", "stroke-width": "7", "stroke-linecap": "round" }));
    h.appendChild(svgEl("rect", { x: "-18.5", y: "21", width: "11", height: "7", rx: "3", fill: "var(--metal-lo)", stroke: "var(--metal)", "stroke-width": "1" }));
    h.appendChild(svgEl("circle", { cx: "-13", cy: "34", r: "7", fill: "none", stroke: "var(--metal)", "stroke-width": "4" }));
    h.appendChild(svgEl("circle", { cx: "-13", cy: "34", r: "7", fill: "none", stroke: "var(--metal-hi)", "stroke-width": "1", opacity: ".5" }));
    g.appendChild(h);
  }

  /* ---------------------------------------------------------------------
     THE SCROLL (hand-over-hand: pure position, kept under reduced motion)
     ------------------------------------------------------------------- */
  function applyScroll() {
    const y = Math.max(0, window.scrollY);
    const room = Math.max(1, document.documentElement.scrollHeight - H);
    travel = clamp(y / room, 0, 1);
    if (hullWorld) hullWorld.setAttribute("transform", `translate(0,${F(-y)})`);
    if (lampG) {
      lampG.setAttribute("transform", `translate(${F(W * 0.42)},${F(y + H * 0.46)})`);
      /** @type {SVGElement} */ (lampG.firstChild)?.setAttribute("opacity", `calc(var(--lamp-op) * ${(0.7 + 0.6 * travel).toFixed(3)})`);
    }
    if (skyRoot) skyRoot.setAttribute("transform", `rotate(${F(-3.4 * travel)} ${F(W / 2)} ${F(H * 2.4)})`);
    for (const L of layers) L.update(T, y);
  }

  function frame(/** @type {number} */ now) {
    if (!frozen) T = T0 + now / 1000;
    const y = Math.max(0, window.scrollY);
    for (const L of layers) L.update(T, y);
    drawTether();
    raf = frozen ? null : requestAnimationFrame(frame);
  }
  function run() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    if (frozen || still()) { T = T0; frame(0); }
    else raf = requestAnimationFrame(frame);
  }
  function rebuild() {
    W = Math.max(320, window.innerWidth);
    H = Math.max(420, window.innerHeight);
    drawSky(); drawHull(); drawRig(); applyScroll(); run();
  }

  const onScroll = () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; applyScroll(); drawTether(); });
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  const onMotionChange = () => { frozen = still(); run(); };
  motion.addEventListener("change", onMotionChange);
  if (still()) frozen = true;

  let resizeT = /** @type {?ReturnType<typeof setTimeout>} */ (null);
  const onResize = () => { if (resizeT) clearTimeout(resizeT); resizeT = setTimeout(rebuild, 120); };
  window.addEventListener("resize", onResize);

  /* Built once the faces are in, as the other backdrops are: the stencils
     carry the mono face, and a face only starts loading once something laid
     out has asked for it, so the layout is forced first; `fonts.ready` then
     settles once those loads land, and at once when nothing is loading (as
     under test, where happy-dom has no `document.fonts` at all). The panels
     this module reads (`[data-nomen]`) are Svelte's own markup, so the
     CALLER awaits a tick after setting its view before mounting this —
     the same shape administration and create already use. */
  let torn = false;
  const boot = () => { if (!torn) rebuild(); };
  if (document.fonts) {
    void document.documentElement.getBoundingClientRect();
    document.fonts.ready.then(boot);
  } else boot();

  return () => {
    torn = true;
    if (raf !== null) cancelAnimationFrame(raf);
    if (resizeT) clearTimeout(resizeT);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    motion.removeEventListener("change", onMotionChange);
    root.textContent = "";
  };
}
