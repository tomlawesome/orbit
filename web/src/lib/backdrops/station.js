/**
 * The station backdrop — administration's own living sky (#472/#475, §14).
 *
 * Ported from design/v19/administration-iss.html, ratified by the owner: "the
 * administration backdrop could be based around the International Space
 * Station — YES I love this train of thought." The station IS this instance,
 * drawn in the family's chart pen: truss, ruled solar arrays, pressurised
 * modules, an arm, an aft port a resupply craft flies to. Behind it, this
 * instance's own households sit in the far distance on their true bearings,
 * seen against the real constellations this platform flies against — both
 * riding the far layer's drift; the station is near-field and rides the near
 * layer, with a slow attitude sway of its own on top.
 *
 * Two differences from the mockup, neither able to move a pixel (the
 * satellites.js/constellations.js law):
 *
 *   1. THE ROLL. The mockup rolled its own seed (`Math.random()` once, on
 *      load). This module never calls Math.random(): the caller hands in the
 *      one seed for this load — `data.fixtures ? seedFromWorkspace(primary) :
 *      rollSeed()` on the administration screen — and that is the ONLY place
 *      randomness enters the backdrop.
 *   2. THE GENERATOR. The mockup carried its own inline hash and Lehmer LCG.
 *      Those are gone; every random draw here comes from `streamFactory` in
 *      $lib/sky.js, the one copy the whole app shares.
 *
 * THE CAPTION under the station carries this instance's REAL facts —
 * collection domain, systems aboard and crew — read off the admin screen's
 * own data (`facts`, built from readAdminScreen() in $lib/data/workspace.js)
 * rather than hard-coded. The attitude and the pass are the roll made
 * legible and stay procedural, exactly as the sheet draws them. One fact the
 * sheet's caption used to carry — a join-request count — is gone on both
 * sides: §15-2g moved join requests to household management, so admin
 * surfaces (this caption included) no longer track them.
 *
 * THE HOUSEHOLDS are not a fixed sample: `galaxy` is `galaxyOf(workspace,
 * today)` from $lib/data/chart.js, the same transform home and create draw
 * their own skies from, so the systems out here are always this instance's
 * real households, on their real true bearings. The primary household (the
 * one you administer from) is never drawn, same law as home. The named
 * constellations sharing the sky with them ARE the mockup's own — real star
 * patterns, borrowed by name, unrelated to Orbit's data — and stay a fixed
 * list exactly as the sheet drew them.
 *
 * Imperative DOM by the same law as satellites.js and constellations.js:
 * rewriting a seeded stream as reactive markup is the translation that loses
 * the design. The screen that mounts this owns nothing but the element to
 * draw into, the seed to draw it from, and the real facts to caption it with.
 */
import { streamFactory } from "$lib/sky.js";

const NS = "http://www.w3.org/2000/svg";

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

const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
const VIEW = 1600; /* the viewBox is always 1600 wide, and xMidYMid slice never shows more */

/* ---------- the drift rates are the parallax ------------------------------
   Far stars slowest; the households and constellations ride the far layer
   exactly (they are that far away); the station is the nearest thing in the
   sky, so it moves fastest. Nothing is pinned. */
const FAR_V = 1.9, NEAR_V = 4.0, STATION_V = NEAR_V;

/* ---------- real constellations, quieter than the household marks ---------
   Genuine asterisms, genuine names — never an invented word. These are the
   fixed sky the platform flies against, so they are drawn thinner, fainter
   and unlabelled-but-for-a-whisper: a household is yours, a constellation is
   only where you are. Fixed sky, not data: identical to
   design/v19/administration-iss.html's own FIGURES. */
const FIGURES = [
  { name: "CASSIOPEIA", pts: [[0, 22], [24, 4], [48, 18], [72, 2], [96, 20]], edges: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  { name: "CYGNUS", pts: [[46, 0], [46, 40], [46, 74], [46, 100], [8, 36], [86, 30]], edges: [[0, 1], [1, 2], [2, 3], [4, 1], [1, 5]] },
  { name: "LYRA", pts: [[0, 0], [12, 30], [38, 24], [46, 52], [20, 58]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1]] },
  { name: "PERSEUS", pts: [[0, 8], [20, 26], [38, 20], [54, 42], [74, 48], [62, 72], [42, 62]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [3, 6], [6, 5]] },
  { name: "ANDROMEDA", pts: [[0, 4], [30, 16], [62, 26], [94, 40], [36, 50]], edges: [[0, 1], [1, 2], [2, 3], [1, 4]] },
  { name: "VELA", pts: [[0, 28], [34, 0], [70, 16], [56, 54], [16, 60]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] },
];

/* ---------- the station's static parts ------------------------------------
   Patterns, one truss bay, one wing, the resupply craft's own short wing, a
   radiator, the resupply craft itself, the whole #iss group and its approach
   corridor — copied verbatim from the sheet's <defs> so every id and every
   attribute the drawing script (below) references stays exact. Static
   markup, not a generator: it never reads a seed. */
const DEFS_HTML = `
      <!-- ruled photovoltaic cells: four columns of blanket, fifteen rows -->
      <pattern id="pvcell" width="26" height="19.733" patternUnits="userSpaceOnUse"
               patternTransform="translate(-52,16)">
        <path d="M 0 0 H 26 M 0 0 V 19.733" fill="none"
              stroke="var(--chart-ink)" stroke-width="1.2"/>
      </pattern>
      <!-- the small Russian-segment and resupply wings -->
      <pattern id="pvsmall" width="19" height="14" patternUnits="userSpaceOnUse">
        <path d="M 0 0 H 19 M 0 0 V 14" fill="none"
              stroke="var(--chart-ink)" stroke-width="1.2"/>
      </pattern>
      <!-- heat-rejection radiator: rungs, no cells — a radiator is not a panel -->
      <pattern id="radrung" width="28" height="15" patternUnits="userSpaceOnUse"
               patternTransform="translate(0,20)">
        <path d="M 0 0 H 28" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
      </pattern>

      <!-- one bay of the integrated truss: post and diagonal -->
      <g id="bay"><path d="M 0 -15 V 15 M 0 -15 L 68.5 15" fill="none"
                        stroke="var(--chart-ink)" stroke-width="1.2"/></g>

      <!-- one solar array wing, rooted at its beta gimbal, growing +y -->
      <g id="wing">
        <line x1="0" y1="0" x2="0" y2="318" stroke="var(--chart-ink)" stroke-width="1.7"/>
        <rect x="-52" y="16" width="104" height="296" fill="url(#pvcell)"
              stroke="var(--chart-ink)" stroke-width="1.2"/>
        <line x1="-52" y1="164" x2="52" y2="164" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <circle cx="0" cy="7" r="7" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
      </g>

      <!-- a Zvezda / resupply wing: short, two columns -->
      <g id="smallwing">
        <line x1="0" y1="0" x2="30" y2="0" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="30" y="-21" width="76" height="42" fill="url(#pvsmall)"
              stroke="var(--chart-ink)" stroke-width="1.2"/>
      </g>

      <!-- three-panel heat-rejection radiator, growing +y -->
      <g id="rad">
        <rect x="0"  y="20" width="28" height="150" fill="url(#radrung)" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="32" y="20" width="28" height="150" fill="url(#radrung)" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="64" y="20" width="28" height="150" fill="url(#radrung)" stroke="var(--chart-ink)" stroke-width="1.2"/>
      </g>

      <!-- the resupply craft: body, cone, two wings, docking probe -->
      <g id="craft">
        <line x1="0" y1="0" x2="0" y2="16" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="-19" y="16" width="38" height="54" rx="7" fill="none"
              stroke="var(--chart-ink)" stroke-width="1.45"/>
        <path d="M -13 70 L 0 86 L 13 70" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <line x1="-19" y1="40" x2="19" y2="40" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <g transform="translate(19,42) rotate(-90)"><use href="#smallwing"/></g>
        <g transform="translate(-19,42) rotate(-90) scale(-1,1)"><use href="#smallwing"/></g>
      </g>

      <!-- THE STATION. Truss along local x, pressurised stack along local y:
           forward (-y) Unity · Destiny · Harmony with Columbus, Kibo and the
           cupola off Tranquility; aft (+y) Zarya · Nauka · Zvezda and the port
           the resupply craft flies to. -->
      <g id="iss">
        <!-- integrated truss: two rails, sixteen bays, segment joints -->
        <path d="M -548 -15 H 548 M -548 15 H 548" fill="none"
              stroke="var(--chart-ink)" stroke-width="1.7"/>
        <use href="#bay" x="-548"/><use href="#bay" x="-479.5"/><use href="#bay" x="-411"/>
        <use href="#bay" x="-342.5"/><use href="#bay" x="-274"/><use href="#bay" x="-205.5"/>
        <use href="#bay" x="-137"/><use href="#bay" x="-68.5"/><use href="#bay" x="0"/>
        <use href="#bay" x="68.5"/><use href="#bay" x="137"/><use href="#bay" x="205.5"/>
        <use href="#bay" x="274"/><use href="#bay" x="342.5"/><use href="#bay" x="411"/>
        <use href="#bay" x="479.5"/>
        <path d="M 548 -15 V 15 M -411 -19 V 19 M -274 -19 V 19 M -137 -19 V 19
                 M 137 -19 V 19 M 274 -19 V 19 M 411 -19 V 19" fill="none"
              stroke="var(--chart-ink)" stroke-width="1.2"/>
        <!-- the two rotary joints -->
        <circle cx="-274" cy="0" r="12" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <circle cx="274"  cy="0" r="12" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>

        <!-- eight wings on four masts -->
        <use href="#wing" transform="translate(-455,0)"/>
        <use href="#wing" transform="translate(-455,0) scale(1,-1)"/>
        <use href="#wing" transform="translate(-258,0)"/>
        <use href="#wing" transform="translate(-258,0) scale(1,-1)"/>
        <use href="#wing" transform="translate(258,0)"/>
        <use href="#wing" transform="translate(258,0) scale(1,-1)"/>
        <use href="#wing" transform="translate(455,0)"/>
        <use href="#wing" transform="translate(455,0) scale(1,-1)"/>

        <!-- radiators, aft face -->
        <use href="#rad" transform="translate(96,0)"/>
        <use href="#rad" transform="translate(-188,0)"/>

        <!-- forward stack -->
        <rect x="-27"  y="-84"  width="54" height="66" rx="10" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="-29"  y="-178" width="58" height="94" rx="12" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="-27"  y="-240" width="54" height="62" rx="10" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="-13"  y="-262" width="26" height="22" rx="4"  fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="27"   y="-230" width="70" height="40" rx="10" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="-112" y="-234" width="85" height="48" rx="11" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="-96"  y="-266" width="38" height="32" rx="7"  fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="-160" y="-226" width="48" height="30" rx="2"  fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="-96"  y="-78"  width="69" height="46" rx="10" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <!-- the cupola: seven panes, the window the crew administer from -->
        <path d="M -96 -70 L -116 -62 L -116 -48 L -96 -40 Z" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <path d="M -106 -66 V -44 M -96 -55 H -116" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <!-- module ribs, so the stack reads as pressurised cans -->
        <path d="M -27 -60 H 27 M -29 -122 H 29 M -29 -150 H 29 M -27 -212 H 27"
              fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>

        <!-- aft stack -->
        <rect x="-13" y="18"  width="26" height="18" rx="4"  fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <rect x="-28" y="36"  width="56" height="84" rx="12" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="27"  y="62"  width="56" height="36" rx="9"  fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="-25" y="120" width="50" height="96" rx="12" fill="none" stroke="var(--chart-ink)" stroke-width="1.45"/>
        <rect x="-11" y="216" width="22" height="14" rx="3"  fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <path d="M -28 78 H 28 M -25 162 H 25" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <use href="#smallwing" transform="translate(25,190)"/>
        <use href="#smallwing" transform="translate(-25,190) scale(-1,1)"/>

        <!-- Canadarm2, stowed against the truss -->
        <path d="M 60 -8 L 170 -62 L 142 -158" fill="none" stroke="var(--chart-ink)" stroke-width="1.7"/>
        <circle cx="60"  cy="-8"   r="4" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <circle cx="170" cy="-62"  r="4" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>
        <circle cx="142" cy="-158" r="5" fill="none" stroke="var(--chart-ink)" stroke-width="1.2"/>

        <!-- truss segment identities, the way a chart names what it draws.
             §14 amendment: read a notch clearer — 9/.7 → 11/.88. They are
             drawn inside #iss, so the pass's own scale (0.74–1.04) shrinks
             them again; 9 was landing near 7px and simply vanishing. -->
        <g fill="var(--chart-ink)" font-size="11" letter-spacing=".16em" opacity=".88"
           font-family="ui-monospace,SFMono-Regular,Menlo,monospace" text-anchor="middle">
          <text x="-455" y="-26">P6</text><text x="-258" y="-26">P4</text>
          <text x="-137" y="-26">P1</text><text x="60" y="-26">S0</text>
          <text x="137"  y="-26">S1</text><text x="258"  y="-26">S4</text>
          <text x="455"  y="-26">S6</text>
        </g>
      </g>

      <!-- the approach corridor: the pass the platform is flying, and the line
           the resupply craft comes down. Never drawn across the station body. -->
      <g id="track">
        <path d="M 0 300 V 1120 M 0 -300 V -1060" fill="none" stroke="var(--chart-ink)"
              stroke-width="1.2" stroke-dasharray="2 12" opacity=".68"/>
      </g>`;

const SPAN = 1300, SLOT = VIEW + SPAN;

/** A household's elevation in the sky, from its bearing — sacred (CON-13),
 *  never the roll. @param {{ pos: [number, number] }} hh */
function elevationOf(hh) {
  const r = Math.hypot(hh.pos[0], hh.pos[1]);
  return 500 + (hh.pos[1] / r) * 320;
}

/**
 * Mounts the streaming sky, the households, the constellations and the
 * station into `root`, and returns a teardown that removes everything this
 * call added.
 *
 * @param {HTMLElement} root  the element to draw the backdrop into
 * @param {{
 *   seed: number,
 *   galaxy: Record<string, { name: string, pos: [number, number], planets: Array<[number, number, number, string]>, items?: number }>,
 *   primary: ?string,
 *   facts: { domain: string, systems: number, crew: number },
 * }} args
 * @returns {() => void}
 */
export function mountStation(root, { seed, galaxy, primary, facts }) {
  const streamFor = streamFactory(seed);

  /* your households, in the order the workspace lists them, minus the one
     you administer from — never drawn, same law as home */
  const SYSTEMS = Object.entries(galaxy ?? {})
    .filter(([id]) => id !== primary)
    .map(([id, hh]) => ({ id, name: hh.name, pos: hh.pos, planets: hh.planets, items: hh.items ?? 0 }));

  /* ---- the DOM this mount owns --------------------------------------- */
  const farL = /** @type {SVGGElement} */ (svgEl("g", { id: "farL", fill: "var(--star-far)" }));
  const nearL = /** @type {SVGGElement} */ (svgEl("g", { id: "nearL", fill: "var(--star-near)" }));
  const skySvg = svgEl("svg", { viewBox: "0 0 1600 1000", preserveAspectRatio: "xMidYMid slice" });
  skySvg.append(farL, nearL);
  const skyDiv = document.createElement("div");
  skyDiv.className = "layer sky";
  skyDiv.setAttribute("aria-hidden", "true");
  skyDiv.appendChild(skySvg);

  const conL = /** @type {SVGGElement} */ (svgEl("g", { id: "conL" }));
  const chartSvg = svgEl("svg", { viewBox: "0 0 1600 1000", preserveAspectRatio: "xMidYMid slice" });
  chartSvg.appendChild(conL);
  const chartDiv = document.createElement("div");
  chartDiv.className = "layer chartback";
  chartDiv.setAttribute("aria-hidden", "true");
  chartDiv.appendChild(chartSvg);

  const defs = svgEl("defs");
  defs.innerHTML = DEFS_HTML;
  const stationL = /** @type {SVGGElement} */ (svgEl("g", { id: "stationL" }));
  const stationSvg = svgEl("svg", { viewBox: "0 0 1600 1000", preserveAspectRatio: "xMidYMid slice" });
  stationSvg.append(defs, stationL);
  const stationDiv = document.createElement("div");
  stationDiv.className = "layer station";
  stationDiv.setAttribute("aria-hidden", "true");
  stationDiv.appendChild(stationSvg);

  root.append(skyDiv, chartDiv, stationDiv);

  /* ---- the window onto the stream ------------------------------------- */
  /** @param {SVGGElement} host @param {number} speed @param {number} chunkW
   *  @param {number} margin @param {number} lane
   *  @param {(g: SVGGElement, rng: () => number, i: number, T: number) => void} build */
  function Layer(host, speed, chunkW, margin, lane, build) {
    return {
      host, speed, chunkW, margin, lane, build, live: /** @type {Map<number, SVGGElement>} */ (new Map()),
      update(/** @type {number} */ T) {
        const off = this.speed * T;
        const a = Math.floor((off - this.margin) / this.chunkW);
        const b = Math.floor((off + VIEW + this.margin) / this.chunkW);
        for (const i of [...this.live.keys()])
          if (i < a || i > b) { /** @type {SVGGElement} */ (this.live.get(i)).remove(); this.live.delete(i); }
        for (let i = a; i <= b; i++) if (!this.live.has(i)) {
          const g = /** @type {SVGGElement} */ (svgEl("g", { transform: `translate(${(i * this.chunkW).toFixed(1)},0)` }));
          this.build(g, streamFor(this.lane, i), i, T);
          this.host.appendChild(g); this.live.set(i, g);
        }
        this.host.setAttribute("transform", `translate(${(-off).toFixed(1)},0)`);
      },
    };
  }

  /* ---- stars: two depths, rolled a chunk at a time --------------------- */
  const buildFar = (/** @type {SVGGElement} */ g, /** @type {() => number} */ rng) => {
    for (let i = 0; i < 26; i++) g.appendChild(svgEl("circle", {
      cx: (rng() * 400).toFixed(1), cy: (rng() * 1000).toFixed(1),
      r: (0.4 + rng() * 0.5).toFixed(2), opacity: (0.12 + rng() * 0.23).toFixed(2),
    }));
  };
  const buildNear = (/** @type {SVGGElement} */ g, /** @type {() => number} */ rng) => {
    for (let i = 0; i < 12; i++) g.appendChild(svgEl("circle", {
      cx: (rng() * 400).toFixed(1), cy: (rng() * 1000).toFixed(1),
      r: (0.8 + rng() * 0.7).toFixed(2), opacity: (0.3 + rng() * 0.4).toFixed(2),
    }));
  };

  /* ---- what is out: a household, a constellation, or a stretch of nothing */
  function buildMarks(/** @type {SVGGElement} */ g, /** @type {() => number} */ rng, /** @type {number} */ i) {
    const roll = rng();
    if (roll < 0.30) household(g, rng, i);
    else if (roll < 0.80) figure(g, rng);
  }

  function household(/** @type {SVGGElement} */ g, /** @type {() => number} */ rng, /** @type {number} */ i) {
    if (SYSTEMS.length === 0) return;
    /* WHICH household comes from the chunk itself, not the roll, so that the
       same house is never out twice at once — neighbouring chunks always name
       different ones, and a house is one place. The roll still decides
       whether a house is out here at all, and how far away it is. */
    const n = SYSTEMS.length;
    const hh = SYSTEMS[(((i * 3) % n) + n) % n];
    const x = 60 + rng() * 400;
    const far = rng(); /* how distant, this pass */
    const y = elevationOf(hh) + (rng() - 0.5) * 44; /* a breath, never a move */
    const scale = 0.86 - far * 0.34;
    const dim = (0.52 - far * 0.20).toFixed(2);
    const away = rng() < 0.5, dir = away ? 1 : -1; /* which side the label reads */

    const root2 = /** @type {SVGGElement} */ (svgEl("g", { transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`, opacity: dim }));
    const s = svgEl("g", { transform: `scale(${scale.toFixed(3)})` });
    /* dashed chart ink, not accent: on home an accent ring means "fly here",
       and from administration you may only look */
    s.appendChild(svgEl("circle", { r: "50", fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1.2", "stroke-dasharray": "3 8" }));
    s.appendChild(svgEl("circle", { r: "2.6", fill: "var(--chart-ink)" }));
    for (const [px, py, pr, tok] of hh.planets)
      s.appendChild(svgEl("circle", { cx: String(px), cy: String(py), r: String(pr), fill: `var(${tok})`, opacity: ".85" }));
    root2.appendChild(s);

    const lead = 50 * scale + 16;
    root2.appendChild(svgEl("path", {
      d: `M ${dir * (50 * scale + 4)} -${(34 * scale).toFixed(1)} ` +
        `L ${dir * lead} -${(52 * scale + 12).toFixed(1)} h ${dir * 16}`,
      fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1", opacity: ".75",
    }));
    const t = /** @type {SVGTextElement} */ (svgEl("text", {
      x: String(dir * (lead + 22)), y: String(-(52 * scale + 15)), "font-size": "9.5",
      "letter-spacing": ".16em", fill: "var(--chart-ink)", "font-family": MONO,
      "text-anchor": away ? "start" : "end",
    }));
    t.textContent = hh.name.toUpperCase();
    root2.appendChild(t);
    const c = /** @type {SVGTextElement} */ (svgEl("text", {
      x: String(dir * (lead + 22)), y: String(-(52 * scale + 3)), "font-size": "8",
      "letter-spacing": ".12em", fill: "var(--chart-ink)", "font-family": MONO,
      "text-anchor": away ? "start" : "end", opacity: ".8",
    }));
    c.textContent = hh.items + (hh.items === 1 ? " ITEM" : " ITEMS");
    root2.appendChild(c);
    g.appendChild(root2);
  }

  /* §14 amendment: the real sky was too faint to read at arm's length. The
     figure steps up a notch — dim floor 0.26 → 0.38, line 1/.62 → 1.2/.78 and
     in chart INK rather than chart LINE, name 8/.75 → 9/.82. It stays under
     the household mark on every axis. */
  function figure(/** @type {SVGGElement} */ g, /** @type {() => number} */ rng) {
    const f = FIGURES[Math.floor(rng() * FIGURES.length)];
    const x = 40 + rng() * 400, y = 120 + rng() * 740;
    const scale = 0.85 + rng() * 0.85;
    const dim = (0.38 + rng() * 0.14).toFixed(2); /* quieter than a household */
    const root2 = /** @type {SVGGElement} */ (svgEl("g", {
      transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${scale.toFixed(3)})`,
      opacity: dim,
    }));
    let d = "";
    for (const [a, b] of f.edges) d += `M ${f.pts[a][0]} ${f.pts[a][1]} L ${f.pts[b][0]} ${f.pts[b][1]} `;
    root2.appendChild(svgEl("path", { d, fill: "none", stroke: "var(--chart-ink)", "stroke-width": "1.2", opacity: ".78" }));
    for (const [px, py] of f.pts)
      root2.appendChild(svgEl("circle", { cx: String(px), cy: String(py), r: (1.5 + rng() * 1.1).toFixed(2), fill: "var(--star-far)", opacity: ".9" }));
    const t = /** @type {SVGTextElement} */ (svgEl("text", {
      x: String(f.pts[0][0] - 4), y: String(f.pts[0][1] - 13), "font-size": "9",
      "letter-spacing": ".2em", fill: "var(--chart-ink)", "font-family": MONO, opacity: ".82",
    }));
    t.textContent = f.name;
    root2.appendChild(t);
    g.appendChild(root2);
  }

  /* ---- the station: one pass per slot, always exactly one in the window ---
     The slot is the viewport plus the station's own span, so as one pass
     leaves on the left the next enters on the right — the platform comes
     round again, but never the same way twice: attitude, scale, elevation
     and the state of the resupply craft are rolled fresh for every pass. */
  function buildStation(/** @type {SVGGElement} */ g, /** @type {() => number} */ rng, /** @type {number} */ i, /** @type {number} */ T) {
    const cy = 330 + rng() * 330;
    const sc = 0.74 + rng() * 0.30;
    const rot = (rng() - 0.5) * 30;
    const pass = 1000 + Math.floor(rng() * 8999);
    const inbound = rng() < 0.45;
    const d0 = inbound ? 190 + rng() * 380 : 0;

    const passG = svgEl("g", { transform: `translate(${SLOT / 2},${cy.toFixed(1)})` });
    const att = svgEl("g", { class: "att", "data-rot": rot.toFixed(2), "data-sc": sc.toFixed(3) });
    att.setAttribute("transform", `rotate(${rot.toFixed(2)}) scale(${sc.toFixed(3)})`);
    att.appendChild(svgEl("use", { href: "#track" }));
    att.appendChild(svgEl("use", { href: "#iss" }));

    const craft = svgEl("g", { class: "craft", "data-d0": d0.toFixed(0), "data-t0": T.toFixed(1) });
    craft.setAttribute("transform", `translate(0,${(230 + d0).toFixed(1)})`);
    craft.appendChild(svgEl("use", { href: "#craft" }));
    att.appendChild(craft);

    /* the caption is the roll made legible, and it carries the instance's own
       facts — the same ones the panels above state in words. */
    const cap = svgEl("g", { fill: "var(--chart-ink)", "font-family": MONO, opacity: ".94" });
    const l1 = /** @type {SVGTextElement} */ (svgEl("text", { x: "-250", y: "378", "font-size": "11", "letter-spacing": ".18em" }));
    l1.textContent = `THE PLATFORM · ${facts.domain.toUpperCase()}`;
    const l2 = /** @type {SVGTextElement} */ (svgEl("text", { x: "-250", y: "395", "font-size": "9.5", "letter-spacing": ".14em", opacity: ".88" }));
    l2.textContent = `${facts.systems} SYSTEM${facts.systems === 1 ? "" : "S"} ABOARD · ${facts.crew} CREW`;
    const l3 = /** @type {SVGTextElement} */ (svgEl("text", { x: "-250", y: "412", "font-size": "9.5", "letter-spacing": ".14em", opacity: ".88" }));
    l3.textContent = `PASS ${pass} · ATTITUDE ${rot >= 0 ? "+" : "−"}` +
      `${Math.abs(rot).toFixed(1)}° · RESUPPLY ` +
      (inbound ? "INBOUND ON THE CORRIDOR" : "DOCKED AT THE AFT PORT");
    cap.appendChild(l1); cap.appendChild(l2); cap.appendChild(l3);
    att.appendChild(cap);

    passG.appendChild(att);
    g.appendChild(passG);
  }

  const layers = [
    Layer(farL, FAR_V, 400, 120, 0, buildFar),
    Layer(conL, FAR_V, 520, 460, 1, buildMarks),
    Layer(nearL, NEAR_V, 400, 120, 2, buildNear),
    Layer(stationL, STATION_V, SLOT, 660, 3, buildStation),
  ];

  /* Start the clock so the first frame — the one the owner actually judges —
     is composed. The page column owns the middle 980px, so the station's
     CORE (truss centre, module stack, the arm) is placed out in one of the
     clear margins and its arrays sweep across behind the panels. Which
     margin, and how far out, is part of the roll — a fifth lane, 4, that
     never shares an address with a drawn layer (chunk 7, the sheet's own). */
  let T0 = 0;
  function startClock() {
    const r = streamFor(4, 7);
    const side = r() < 0.5 ? -1 : 1;
    const target = 800 + side * (330 + r() * 250);
    const slot = 40; /* an arbitrary positive pass */
    T0 = (slot * SLOT + SLOT / 2 - target) / STATION_V;
  }
  startClock();

  /* --- one frame: advance every layer to T, then breathe the station's
     attitude and close the last of the resupply craft's approach ----------- */
  function place(/** @type {number} */ t) {
    const T = T0 + t;
    for (const L of layers) L.update(T);
    /* the station breathes on its attitude the way a real one does, and its
       resupply craft closes the last of the corridor while it is out */
    const sway = still() ? 0 : Math.sin(T / 26) * 1.15 + Math.sin(T / 41) * 0.55;
    for (const g of layers[3].live.values()) {
      const att = /** @type {?SVGGElement} */ (g.querySelector(".att"));
      if (!att) continue;
      att.setAttribute("transform",
        `rotate(${(parseFloat(att.dataset.rot ?? "0") + sway).toFixed(2)}) scale(${att.dataset.sc})`);
      const c = /** @type {?SVGGElement} */ (att.querySelector(".craft"));
      if (c) {
        const d = Math.max(0, parseFloat(c.dataset.d0 ?? "0") - (T - parseFloat(c.dataset.t0 ?? "0")) * 0.22);
        c.setAttribute("transform", `translate(0,${(230 + d).toFixed(1)})`);
      }
    }
  }

  /* --- the clock: honours prefers-reduced-motion the way satellites.js and
     constellations.js do — `still()` is read every frame rather than cached,
     so an OS-level change mid-session freezes or resumes the drift without a
     remount. */
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const still = () => motion.matches;
  let clock = 0, lastTs = /** @type {?number} */ (null), lastDrawn = -1;
  let raf = /** @type {?number} */ (null);
  function tick(/** @type {number} */ ts) {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min(0.2, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!still()) clock += dt;
    if (clock !== lastDrawn) { place(clock); lastDrawn = clock; }
    raf = requestAnimationFrame(tick);
  }

  /* Built once the faces are in, as satellites.js and constellations.js are:
     the truss segment identities and the caption both carry the mono face,
     and a face only starts loading once something laid out has asked for it,
     so the layout is forced first; `fonts.ready` then settles once those
     loads land, and at once when nothing is loading. Test DOMs have no
     `document.fonts` and build synchronously. */
  let torn = false;
  const boot = () => {
    if (torn) return;
    place(clock);
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
