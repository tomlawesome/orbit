/**
 * The create screen's living backdrop (#474/#475, §14) — the instance's OWN
 * households, floating in the distance behind the new-entry card, and the
 * chart in progress they share the sky with.
 *
 * Ported from design/v19/create-v3.html, ratified by the owner on 2026-09-02.
 * Unlike the relay's satellites (#475) this sky has no craft and nothing to
 * aim at: every mark sits at a fixed logical point in a 1600×1000 chart space
 * that `preserveAspectRatio="xMidYMid slice"` maps onto the viewport, so
 * placement never needs the card's real on-screen box. That is why this
 * module, alone among the backdrops, never reads layout at all.
 *
 * Two differences from the mockup, neither able to move a pixel:
 *
 *   1. THE ROLL. The mockup rolled its own seed (`Math.random()` once, on
 *      load). This module never calls Math.random(): the caller hands in the
 *      one seed for this load, mirroring satellites.js and home.behaviour.js.
 *   2. THE GENERATOR. The mockup carried its own inline Park-Miller LCG and
 *      chunk hash. Those are gone; every random draw here comes from
 *      `streamFactory` in $lib/sky.js, the one copy the whole app shares.
 *
 * THE HOUSEHOLDS are not a fixed sample: `galaxy` is `galaxyOf(workspace,
 * today)` from $lib/data/chart.js, the same transform home draws its own sky
 * from, so the systems in this backdrop are always this instance's real
 * households, in their real true bearings — never the mockup's hard-coded
 * four. The primary household (the one you are inside) is never drawn, same
 * law as home. The named constellations sharing the sky with them ARE the
 * mockup's own — real star patterns, borrowed by name, unrelated to Orbit's
 * data — and stay a fixed list exactly as the sheet drew them.
 */
import { streamFactory } from "$lib/sky.js";

const NS = "http://www.w3.org/2000/svg";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

/**
 * @param {string} name
 * @param {Record<string, string>} [attrs]
 * @returns {SVGElement}
 */
function svgEl(name, attrs) {
  const e = document.createElementNS(NS, name);
  if (attrs) for (const key in attrs) e.setAttribute(key, attrs[key]);
  return e;
}

/* ---- the window: chunks rolled ahead, dropped behind, never revisited ---- */
const CHUNK = 800; /* world units rolled at a time for the three star layers */
const AHEAD = 760; /* rolled this far past the right edge, before it is needed */
const BEHIND = 340; /* held this far past the left edge, then discarded */

/* The named constellations sharing the sky with your households — real star
 * patterns, borrowed by name, drawn quieter than any household mark so the
 * households stay the only things up there that mean anything. Fixed sky,
 * not data: identical to design/v19/create-v3.html's own FIGURES. */
const FIGURES = [
  { name: "CASSIOPEIA", pts: [[-48, 6], [-24, -14], [0, 4], [24, -16], [48, 2]], links: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  { name: "CYGNUS", pts: [[0, -32], [0, -6], [0, 20], [0, 40], [-32, -2], [30, -12]], links: [[0, 1], [1, 2], [2, 3], [4, 1], [5, 1]] },
  { name: "LYRA", pts: [[-18, -30], [0, -12], [16, 6], [4, 26], [-14, 10]], links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1]] },
  { name: "VELA", pts: [[-38, 14], [-10, -24], [26, -12], [34, 20]], links: [[0, 1], [1, 2], [2, 3], [3, 0]] },
  { name: "ANDROMEDA", pts: [[-46, 18], [-18, 6], [10, -6], [38, -22], [24, 10]], links: [[0, 1], [1, 2], [2, 3], [2, 4]] },
  { name: "PERSEUS", pts: [[-32, -24], [-10, -6], [6, 18], [30, 28], [18, -18]], links: [[0, 1], [1, 2], [2, 3], [1, 4]] },
];

/* The static protractor over the chart with the card: fixed sky furniture,
 * not drawn from data, so it is one literal block rather than a generator. */
const INPROGRESS_HTML = `
    <g fill="none" stroke="var(--chart-line)" stroke-width="1.4">
      <path d="M 800 262 A 388 388 0 0 1 1188 650" stroke-dasharray="6 8" opacity=".8"/>
      <path d="M 412 650 A 388 388 0 0 1 800 262" stroke-dasharray="6 8" opacity=".45"/>
    </g>
    <g stroke="var(--chart-line)" stroke-width="1.3" opacity=".72">
      <line x1="1188" y1="650" x2="1170" y2="650"/><line x1="1178" y1="552" x2="1160" y2="548"/>
      <line x1="1147" y1="459" x2="1130" y2="452"/><line x1="1097" y1="379" x2="1083" y2="369"/>
      <line x1="1029" y1="317" x2="1019" y2="303"/><line x1="948" y1="279" x2="943" y2="262"/>
    </g>
    <g stroke="var(--chart-line)" stroke-width="1" opacity=".42">
      <line x1="1185.2" y1="602.7" x2="1171.2" y2="604.4"/>
      <line x1="1162.2" y1="511.0" x2="1149.2" y2="515.9"/>
      <line x1="1117.8" y1="427.4" x2="1106.4" y2="435.5"/>
      <line x1="1054.6" y1="357.2" x2="1045.4" y2="367.7"/>
      <line x1="976.1"  y1="304.3" x2="969.8"  y2="316.8"/>
      <line x1="887.3"  y1="271.9" x2="884.1"  y2="285.6"/>
    </g>
    <g stroke="var(--chart-ink)" stroke-width="1.35" opacity=".82">
      <path d="M 800 500 m -13 0 h 26 M 800 500 m 0 -13 v 26"/>
      <line x1="0" y1="500" x2="40" y2="500"/><line x1="1560" y1="500" x2="1600" y2="500"/>
    </g>
    <g stroke="var(--chart-ink)" stroke-width="1" stroke-dasharray="3 7" opacity=".5">
      <line x1="800" y1="637" x2="800" y2="516"/>
    </g>
    <g fill="var(--chart-ink)" font-size="10" letter-spacing=".16em"
       font-family="ui-monospace,SFMono-Regular,Menlo,monospace" opacity=".9">
      <text x="822" y="483">PENDING ENTRY</text>
      <text x="1204" y="655">0&#176;</text><text x="932" y="250">75&#176;</text>
    </g>`;

const mod = (a, n) => ((a % n) + n) % n;
/* A household is in one place, and so is a constellation: neither may be on
 * screen twice at once. Both step through a fixed cycle keyed to the chunk's
 * address; the cycle's starting point is the only part the seed decides. */
const cyc = (n, idx, off) => mod(idx + off, n);

/**
 * Mounts the streaming sky and the instance's own households into `root`, and
 * returns a teardown that removes everything this call added.
 *
 * @param {HTMLElement} root  the element to draw the backdrop into
 * @param {{ seed: number, galaxy: Record<string, { name: string, pos: [number, number], planets: Array<[number, number, number, string]>, items?: number }>, primary: ?string }} args
 * @returns {() => void}
 */
export function mountConstellations(root, { seed, galaxy, primary }) {
  const streamFor = streamFactory(seed);

  /* your households, in the order the workspace lists them, minus the one
     you are inside — never drawn, same law as home */
  const SYSTEMS = Object.entries(galaxy ?? {})
    .filter(([id]) => id !== primary)
    .map(([id, hh]) => ({ id, name: hh.name, pos: hh.pos, planets: hh.planets, items: hh.items ?? 0 }));

  /* ---- the DOM this mount owns --------------------------------------- */
  const lyrFar = /** @type {SVGGElement} */ (svgEl("g", { fill: "var(--star-far)" }));
  const lyrSpark = /** @type {SVGGElement} */ (svgEl("g", { fill: "var(--star-near)" }));
  const lyrNear = /** @type {SVGGElement} */ (svgEl("g", { fill: "var(--star-near)" }));
  const skySvg = svgEl("svg", { viewBox: "0 0 1600 1000", preserveAspectRatio: "xMidYMid slice" });
  skySvg.append(lyrFar, lyrSpark, lyrNear);
  const skyDiv = document.createElement("div");
  skyDiv.className = "sky";
  skyDiv.setAttribute("aria-hidden", "true");
  skyDiv.appendChild(skySvg);

  const inprogress = /** @type {SVGGElement} */ (svgEl("g", { id: "inprogress" }));
  inprogress.innerHTML = INPROGRESS_HTML;
  const lyrDeep = /** @type {SVGGElement} */ (svgEl("g"));
  const lyrSys = /** @type {SVGGElement} */ (svgEl("g"));
  const chartSvg = svgEl("svg", { viewBox: "0 0 1600 1000", preserveAspectRatio: "xMidYMid slice" });
  chartSvg.append(inprogress, lyrDeep, lyrSys);
  const chartDiv = document.createElement("div");
  chartDiv.className = "chartback";
  chartDiv.setAttribute("aria-hidden", "true");
  chartDiv.appendChild(chartSvg);

  root.append(skyDiv, chartDiv);

  /* ---- the three star lanes ------------------------------------------- */
  function genFarStars(g, r) {
    for (let i = 0; i < 66; i++)
      g.appendChild(svgEl("circle", {
        cx: (r() * CHUNK).toFixed(1), cy: (r() * 1000).toFixed(1),
        r: (0.45 + r() * 0.6).toFixed(2), opacity: (0.17 + r() * 0.29).toFixed(2),
      }));
  }
  function genNearStars(g, r) {
    for (let i = 0; i < 32; i++)
      g.appendChild(svgEl("circle", {
        cx: (r() * CHUNK).toFixed(1), cy: (r() * 1000).toFixed(1),
        r: (0.9 + r() * 0.8).toFixed(2), opacity: (0.38 + r() * 0.48).toFixed(2),
      }));
  }
  /* the third, slowly twinkling depth (§14 backdrop iteration 2) */
  function genSparks(g, r) {
    for (let i = 0; i < 5; i++) {
      const c = /** @type {SVGCircleElement} */ (svgEl("circle", {
        class: "spark", cx: (r() * CHUNK).toFixed(1), cy: (r() * 1000).toFixed(1),
        r: (1.5 + r() * 0.9).toFixed(2),
      }));
      c.style.setProperty("--o", (0.55 + r() * 0.35).toFixed(2));
      c.style.animationDuration = (7 + r() * 6).toFixed(1) + "s";
      c.style.animationDelay = "-" + (r() * 9).toFixed(1) + "s";
      g.appendChild(c);
    }
  }

  /* --- one real household, riding at the height its own bearing gives it --- */
  function household(g, hh, x, r) {
    const bearing = Math.atan2(hh.pos[1], hh.pos[0]); /* sacred — never rolled */
    const spread = 300 + r() * 145;
    const y = 500 + Math.sin(bearing) * spread;
    const away = Math.cos(bearing) >= 0;
    const far = 0.58 + r() * 0.42; /* only the distance is rolled */
    const scale = 0.6 + (1 - far) * 0.4;
    const dim = (0.5 + (1 - far) * 0.3).toFixed(2);

    const node = /** @type {SVGGElement} */ (svgEl("g", {
      class: "csys", transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`,
      opacity: dim, style: `animation-delay:${(r() * 0.5).toFixed(2)}s`,
    }));
    const s = svgEl("g", { transform: `scale(${scale.toFixed(3)})` });
    s.appendChild(svgEl("circle", { r: "50", fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1.5", "stroke-dasharray": "3 7" }));
    s.appendChild(svgEl("circle", { r: "3", fill: "var(--chart-ink)" }));
    for (const [px, py, pr, tok] of hh.planets)
      s.appendChild(svgEl("circle", { cx: String(px), cy: String(py), r: String(pr), fill: `var(${tok})`, opacity: "1" }));
    node.appendChild(s);

    const lead = 50 * scale + 16, dir = away ? 1 : -1;
    node.appendChild(svgEl("path", {
      d: `M ${dir * (50 * scale + 4)} -${(34 * scale).toFixed(1)} ` +
        `L ${dir * lead} -${(52 * scale + 12).toFixed(1)} ` +
        `h ${dir * 16}`,
      fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1.15", opacity: ".9",
    }));
    const t = /** @type {SVGTextElement} */ (svgEl("text", {
      x: String(dir * (lead + 22)), y: String(-(52 * scale + 15)), "font-size": "10.5",
      "letter-spacing": ".16em", fill: "var(--chart-ink)", "font-family": MONO,
      "text-anchor": away ? "start" : "end",
    }));
    t.textContent = hh.name.toUpperCase();
    node.appendChild(t);
    const c = /** @type {SVGTextElement} */ (svgEl("text", {
      x: String(dir * (lead + 22)), y: String(-(52 * scale + 2)), "font-size": "8.5",
      "letter-spacing": ".12em", fill: "var(--chart-ink)", "font-family": MONO,
      "text-anchor": away ? "start" : "end", opacity: ".85",
    }));
    c.textContent = hh.items + (hh.items === 1 ? " ITEM" : " ITEMS");
    node.appendChild(c);
    g.appendChild(node);
  }

  /* --- one named constellation, quieter than any household ------------- */
  function figure(fig, x, y, r) {
    const scale = 0.72 + r() * 0.55;
    const tilt = (r() * 24 - 12).toFixed(1);
    const dim = (0.5 + r() * 0.2).toFixed(2);
    const node = /** @type {SVGGElement} */ (svgEl("g", {
      class: "csys", opacity: dim,
      transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${tilt}) scale(${scale.toFixed(3)})`,
      style: `animation-delay:${(r() * 0.6).toFixed(2)}s`,
    }));
    let d = "";
    for (const [a, b] of fig.links)
      d += `M ${fig.pts[a][0]} ${fig.pts[a][1]} L ${fig.pts[b][0]} ${fig.pts[b][1]} `;
    node.appendChild(svgEl("path", { d, fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1.2", opacity: ".78" }));
    for (const [px, py] of fig.pts)
      node.appendChild(svgEl("circle", { cx: String(px), cy: String(py), r: (1.4 + r() * 1).toFixed(2), fill: "var(--star-far)", opacity: ".9" }));
    const t = /** @type {SVGTextElement} */ (svgEl("text", {
      x: "0", y: "58", "font-size": "9.5", "letter-spacing": ".22em",
      fill: "var(--chart-ink)", "font-family": MONO, "text-anchor": "middle", opacity: ".85",
    }));
    t.textContent = fig.name;
    node.appendChild(t);
    return node;
  }

  /* every real household comes past in turn */
  function genHousehold(g, r, idx) {
    if (SYSTEMS.length === 0) return;
    household(g, SYSTEMS[cyc(SYSTEMS.length, idx, seed % SYSTEMS.length)], 170 + r() * 220, r);
  }
  function genFigure(g, r, idx) {
    if (r() > 0.86) return; /* the deep sky is allowed a gap */
    const f = FIGURES[cyc(FIGURES.length, idx, seed % FIGURES.length)];
    g.appendChild(figure(f, 180 + r() * 340, 140 + r() * 720, r));
  }

  const LAYERS = [
    { key: 0, node: lyrFar, w: CHUNK, speed: 1600 / 400, gen: genFarStars },
    { key: 1, node: lyrSpark, w: CHUNK, speed: 1600 / 300, gen: genSparks },
    { key: 2, node: lyrNear, w: CHUNK, speed: 1600 / 195, gen: genNearStars },
    { key: 4, node: lyrDeep, w: 700, speed: 1600 / 520, gen: genFigure, marks: true },
    { key: 3, node: lyrSys, w: 560, speed: 1600 / 400, gen: genHousehold, marks: true },
  ];
  for (const L of LAYERS) { L.chunks = new Map(); L.o0 = 0; }

  /* --- keeping the window stocked: rolled ahead, dropped behind --------- */
  function fillWindow(L, offset) {
    const first = Math.floor((offset - BEHIND) / L.w);
    const last = Math.floor((offset + 1600 + AHEAD) / L.w);
    for (let i = first; i <= last; i++) {
      if (L.chunks.has(i)) continue;
      const g = svgEl("g", { transform: `translate(${i * L.w},0)` });
      L.gen(g, streamFor(L.key, i), i);
      L.chunks.set(i, g);
      L.node.appendChild(g);
    }
    for (const [i, g] of L.chunks)
      if (i < first || i > last) { g.remove(); L.chunks.delete(i); }
  }

  /* The card can no longer own the middle for ever — the sky moves. It can
     own the OPENING, though: the window starts at whichever offset leaves
     the centre clearest, so the first thing you see is composed. */
  function tidyStart(L) {
    let best = 0, bestScore = -1e9;
    for (let o = 0; o < L.w; o += 20) {
      fillWindow(L, o);
      let onScreen = 0, behindCard = 0, clear = 9;
      for (const [i, g] of L.chunks) for (const m of g.querySelectorAll(".csys")) {
        const t = /translate\(([-\d.]+),([-\d.]+)\)/.exec(m.getAttribute("transform"));
        if (!t) continue;
        const x = i * L.w + parseFloat(t[1]) - o, y = parseFloat(t[2]);
        if (x < 60 || x > 1540) continue;
        onScreen++;
        const c = Math.hypot((x - 800) / 430, (y - 500) / 330);
        if (c < 1) behindCard++;
        clear = Math.min(clear, c);
      }
      const score = onScreen - 3 * behindCard + Math.min(clear, 2) * 0.3;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  /* --- one frame: advance every layer to its offset at clock t ---------- */
  function place(t) {
    for (const L of LAYERS) {
      const offset = L.o0 + t * L.speed;
      fillWindow(L, offset);
      L.node.setAttribute("transform", `translate(${(-offset).toFixed(1)},0)`);
    }
  }

  function build() {
    for (const L of LAYERS) { L.node.textContent = ""; L.chunks.clear(); L.o0 = 0; }
    for (const L of LAYERS) if (L.marks) L.o0 = tidyStart(L);
    for (const L of LAYERS) {
      fillWindow(L, L.o0);
      L.node.setAttribute("transform", `translate(${(-L.o0).toFixed(1)},0)`);
    }
  }

  /* --- the clock: honours prefers-reduced-motion the way satellites.js
     does — `still()` is read every frame rather than cached, so an
     OS-level change mid-session freezes or resumes the drift without a
     remount. */
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const still = () => motion.matches;
  let clock = 0, lastTs = /** @type {?number} */ (null), lastDrawn = -1;
  let raf = /** @type {?number} */ (null);
  function tick(ts) {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min(0.2, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!still()) clock += dt;
    if (clock !== lastDrawn) { place(clock); lastDrawn = clock; }
    raf = requestAnimationFrame(tick);
  }

  /* Built once the faces are in, as the sheet is and satellites.js is: a
     face only starts loading once something laid out has asked for it, so
     the layout is forced first; `fonts.ready` then settles once those loads
     land. Test DOMs have no `document.fonts` and build synchronously. */
  let torn = false;
  const boot = () => {
    if (torn) return;
    build();
    if (!still()) raf = requestAnimationFrame(tick);
  };
  if (document.fonts) {
    void document.documentElement.getBoundingClientRect();
    document.fonts.ready.then(boot);
  } else boot();

  return () => {
    torn = true;
    if (raf !== null) cancelAnimationFrame(raf);
    root.textContent = "";
  };
}
