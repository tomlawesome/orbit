/**
 * Relay satellites — the living backdrop behind "your relay" (#475, §14).
 *
 * Ported from design/v19/relay-satellites.html, ratified by the owner on
 * 2026-09-02: the streaming never-loop sky, the craft roster at varied depth
 * and attitude, the beams re-solved onto the dish every frame, the
 * real-astronomy fillers and the distant households on their true bearings.
 * Two differences from the mockup, neither able to move a pixel:
 *
 *   1. THE ROLL. The mockup rolled its own seed (`Math.random()` once, on
 *      load). This module never calls Math.random(): the caller hands in the
 *      one seed for this load — `data.fixtures ? seedFromWorkspace(id) :
 *      rollSeed()` on the relay screen, mirroring home.behaviour.js — and
 *      that is the ONLY place randomness enters the backdrop.
 *   2. THE GENERATOR. The mockup carried its own inline Park-Miller LCG and
 *      chunk hash. Those are gone; every random draw here comes from
 *      `streamFactory` in $lib/sky.js, the one copy the whole app shares, so
 *      the fidelity gate's stream can never drift out from under it.
 *
 * Imperative DOM by the same law as home.behaviour.js and skies.js: rewriting
 * a seeded stream as reactive markup is the translation that loses the
 * design. The screen that mounts this owns nothing but the element to draw
 * into and the seed to draw it from.
 *
 * Two owner rulings this port must not undo:
 *   - labels drifting past each other and briefly touching is ACCEPTED —
 *     there is no collision avoidance between a craft's name and anything
 *     else, exactly as the mockup left it;
 *   - the chart-alpha damper belongs to the administration backdrop, not
 *     this one — nothing here dims the chart ink by day/night.
 */
import { streamFactory } from "$lib/sky.js";

const NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} name
 * @param {Record<string, string>} [attrs]
 * @returns {SVGElement}
 */
function svgEl(name, attrs) {
  const el = document.createElementNS(NS, name);
  if (attrs) for (const key in attrs) el.setAttribute(key, attrs[key]);
  return el;
}

/* ────────────────────────────────────────────────────────────────────────
   THE CHART PEN — ~1px chart-ink strokes, no fills, no gloss: the same pen
   the rest of the family draws in. Line weight is held at a constant
   CSS-pixel width whatever the craft's distance (the caller pre-divides the
   pen by the craft's own scale) — depth is carried by size and ink strength,
   never by a thicker or thinner line.
   ──────────────────────────────────────────────────────────────────────── */
/** @param {number} x @param {number} y @param {number} p */
const lamp = (x, y, p) =>
  `<circle class="lamp" cx="${x}" cy="${y}" r="${(p * 1.5).toFixed(2)}" fill="var(--accent)"/>`;
/** @param {number} p */
const RULE = (p) => (p * 0.68).toFixed(2);
/** @param {number} p */
const HAIR = (p) => (p * 0.5).toFixed(2);

/** a dish bowl, drawn open toward local +y, with its feed horn in front */
/** @param {number} r @param {number} p */
const bowl = (r, p) => `<g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linecap="round">
      <path d="M ${-r} ${(r * 0.93).toFixed(1)} A ${r} ${r} 0 0 0 ${r} ${(r * 0.93).toFixed(1)}"/>
      <path d="M 0 ${(r * 0.93).toFixed(1)} V ${(r * 1.72).toFixed(1)}"/>
    </g>
    <circle cx="0" cy="${(r * 1.8).toFixed(1)}" r="${(r * 0.2).toFixed(2)}" fill="none"
            stroke="var(--chart-ink)" stroke-width="${(p * 0.8).toFixed(2)}"/>`;
/** the same bowl on a gimbal: mount() re-points it at the relay every frame */
/** @param {number} x @param {number} y @param {number} r @param {number} p */
const gdish = (x, y, r, p) => `<g class="gimbal" data-gx="${x}" data-gy="${y}"
      transform="translate(${x} ${y})">${bowl(r, p)}</g>`;

/* JWST's primary: eighteen segments on a hex grid, one notch out of the
   bottom rank, the way the real mirror is built */
const JWST_MIRROR = (() => {
  let d = "";
  for (let q = -2; q <= 2; q++) {
    for (let r = Math.max(-2, -q - 2); r <= Math.min(2, -q + 2); r++) {
      if (q === 0 && r === 2) continue;
      const cx = 7.97 * (q + r / 2), cy = 6.9 * r - 16, pts = [];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k - 90);
        pts.push(`${(cx + 4.4 * Math.cos(a)).toFixed(1)} ${(cy + 4.4 * Math.sin(a)).toFixed(1)}`);
      }
      d += "M " + pts.join(" L ") + " Z ";
    }
  }
  return d.trim();
})();
/* and its five-layer kite sunshield, each layer a touch smaller and lower */
const JWST_SHIELD = (() => {
  let s = "";
  for (let k = 0; k < 5; k++) {
    const f = 1 - k * 0.055, y = 9 + k * 3.8;
    s += `<path d="M ${(-40 * f).toFixed(1)} ${y.toFixed(1)} L 0 ${(y - 10 * f).toFixed(1)}
             L ${(40 * f).toFixed(1)} ${y.toFixed(1)} L 0 ${(y + 10 * f).toFixed(1)} Z"/>`;
  }
  return s;
})();

/**
 * @typedef {{
 *   key: string, span: number, mode: "gimbal"|"aim"|"free", label: ?string,
 *   start: number, bow: [number, number], talk: number,
 *   draw: (pen: number) => string,
 * }} CraftType
 */

/** @type {CraftType[]} */
const ROSTER = [
  /* --- the generic comms birds: unnamed, because they are yours --- */
  { key: "comms", span: 44, mode: "gimbal", label: null, start: 16, bow: [0.07, 0.16], talk: 0.78,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round">
      <rect x="-9" y="-6.5" width="18" height="13" rx="2.5"/>
      <path d="M -9 0 H -15.5 M 9 0 H 15.5"/>
      <rect x="-40" y="-9.5" width="24.5" height="19" rx="1"/>
      <rect x="15.5" y="-9.5" width="24.5" height="19" rx="1"/>
      <path d="M -3.5 -6.5 V -9 M 3.5 -6.5 V -9" stroke-width="${HAIR(p)}"/>
    </g>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M -32 -9.5 V 9.5 M -24 -9.5 V 9.5 M 24 -9.5 V 9.5 M 32 -9.5 V 9.5"/>
      <path d="M -40 0 H -15.5 M 15.5 0 H 40" opacity=".7"/>
      <path d="M -5 -3 H 5 M -5 3 H 5" opacity=".55"/>
    </g>
    ${lamp(-42.6, 0, p)}
    ${gdish(0, 0, 7, p)}` },

  { key: "beacon", span: 50, mode: "gimbal", label: null, start: 20, bow: [0.07, 0.16], talk: 0.78,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round">
      <path d="M -8 -10 L 5 -10 L 12 0 L 5 10 L -8 10 L -15 0 Z"/>
      <path d="M 12 0 H 19 M -15 0 H -26"/>
      <rect x="19" y="-14" width="38" height="28" rx="1"/>
      <circle cx="-30" cy="0" r="4.2"/>
      <path d="M -3 -10 L -6 -19 L 3 -19 L 1 -10"/>
      <path d="M 0 10 V 14.5"/>
    </g>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M 28.5 -14 V 14 M 38 -14 V 14 M 47.5 -14 V 14"/>
      <path d="M 19 0 H 57" opacity=".7"/>
      <path d="M -8 -10 V 10 M 5 -10 V 10" opacity=".55"/>
    </g>
    ${lamp(59, 0, p)}
    ${gdish(0, 14.5, 6.5, p)}` },

  /* --- the famous ones --- */
  /* Hubble: the tube, the aperture door, two ruled wings, a steerable HGA */
  { key: "hubble", span: 42, mode: "gimbal", label: "HUBBLE", start: 24, bow: [0.06, 0.15], talk: 0.8,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round">
      <rect x="-27" y="-9.5" width="54" height="19" rx="3"/>
      <path d="M -27 -9.5 A 3.4 9.5 0 0 0 -27 9.5"/>
      <path d="M 27 -9.5 A 3.4 9.5 0 0 1 27 9.5"/>
      <path d="M -27 -9.5 L -37 -16.5 L -33.5 -12.5"/>
      <path d="M -2 -9.5 V -16 M -2 9.5 V 16"/>
      <rect x="-19" y="-33" width="36" height="17" rx="1"/>
      <rect x="-19" y="16" width="36" height="17" rx="1"/>
      <path d="M 21 9.5 V 15"/>
    </g>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M -10 -9.5 V 9.5 M 6 -9.5 V 9.5"/>
      <path d="M -27 0 H 27" opacity=".5"/>
      <path d="M -10 -33 V -16 M -1 -33 V -16 M 8 -33 V -16"/>
      <path d="M -10 16 V 33 M -1 16 V 33 M 8 16 V 33"/>
      <path d="M -19 -24.5 H 17 M -19 24.5 H 17" opacity=".7"/>
    </g>
    ${lamp(30, 0, p)}
    ${gdish(21, 15, 6, p)}` },

  /* Rosetta: a small bus between two enormous solar wings, HGA on a mast,
     Philae still tucked underneath */
  { key: "rosetta", span: 76, mode: "gimbal", label: "ROSETTA", start: 20, bow: [0.10, 0.22], talk: 0.82,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round">
      <rect x="-9" y="-8" width="18" height="16" rx="2"/>
      <path d="M -9 0 H -16 M 9 0 H 16"/>
      <rect x="-72" y="-8" width="56" height="16" rx="1"/>
      <rect x="16" y="-8" width="56" height="16" rx="1"/>
      <path d="M 0 -8 V -13.5"/>
      <path d="M 0 8 V 12 M -5 12 L 5 12 L 6.5 18 L -6.5 18 Z"/>
    </g>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M -61 -8 V 8 M -50 -8 V 8 M -39 -8 V 8 M -28 -8 V 8"/>
      <path d="M 27 -8 V 8 M 38 -8 V 8 M 49 -8 V 8 M 60 -8 V 8"/>
      <path d="M -72 0 H -16 M 16 0 H 72" opacity=".65"/>
      <path d="M -4 -8 V 8" opacity=".5"/>
    </g>
    ${lamp(-74.5, 0, p)}
    ${gdish(0, -13.5, 6.5, p)}` },

  /* JWST: hex mirror, secondary on its tripod, the five-layer kite below */
  { key: "jwst", span: 48, mode: "free", label: "JWST", start: 30, bow: [0.12, 0.26], talk: 0.74,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round">
      <path d="${JWST_MIRROR}"/>
      <rect x="-8" y="33" width="16" height="6.5" rx="1.5"/>
      <rect x="-14" y="40" width="28" height="8" rx="1"/>
    </g>
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${(p * 0.85).toFixed(2)}" stroke-linejoin="round">
      ${JWST_SHIELD}
    </g>
    <ellipse cx="0" cy="-43.5" rx="5" ry="2.6" fill="none" stroke="var(--chart-ink)" stroke-width="${p}"/>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M -20 -14 L 0 -42 M 20 -14 L 0 -42 M 0 -3 L 0 -42"/>
      <path d="M -40 9 H 40" opacity=".6"/>
      <path d="M -5 40 V 48 M 4 40 V 48"/>
    </g>
    ${lamp(0, 50, p)}` },

  /* Voyager: the great dish, the decagonal bus behind it, three RTGs on one
     boom and the magnetometer on the other */
  { key: "voyager", span: 58, mode: "aim", label: "VOYAGER", start: 18, bow: [0.13, 0.28], talk: 1,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round" stroke-linecap="round">
      <path d="M -21 6 A 21 21 0 0 0 21 6"/>
      <path d="M -14 1 L 0 15 M 14 1 L 0 15"/>
      <circle cx="0" cy="16.6" r="2.2"/>
      <path d="M -8 -24 L -6.5 -30 L -2.5 -33.5 L 2.5 -33.5 L 6.5 -30 L 8 -24
               L 6.5 -18 L 2.5 -14.5 L -2.5 -14.5 L -6.5 -18 Z"/>
      <path d="M -8 -24 H -38 M 8 -24 H 54"/>
      <rect x="-52" y="-28" width="6.5" height="8" rx="2"/>
      <rect x="-45" y="-28" width="6.5" height="8" rx="2"/>
      <rect x="-38" y="-28" width="6.5" height="8" rx="2"/>
      <path d="M -8 -20 L -20 -8"/>
      <rect x="-31" y="-13" width="11" height="8" rx="1"/>
      <circle cx="56" cy="-24" r="2"/>
    </g>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M -21 6 H 21" opacity=".8"/>
      <path d="M -13 2.4 A 13 13 0 0 0 13 2.4"/>
      <path d="M -6.5 4.6 A 6.5 6.5 0 0 0 6.5 4.6" opacity=".7"/>
      <path d="M 22 -27 V -21 M 34 -27 V -21 M 46 -27 V -21"/>
      <path d="M -52 -24 H -31.5" opacity=".7"/>
    </g>
    ${lamp(-55, -24, p)}` },

  /* Cassini: the HGA, the stacked bus, the engine skirt, Huygens on the
     flank and eleven metres of magnetometer boom on the other side */
  { key: "cassini", span: 62, mode: "aim", label: "CASSINI", start: 12, bow: [0.12, 0.26], talk: 1,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round" stroke-linecap="round">
      <path d="M -16 4 A 16 16 0 0 0 16 4"/>
      <path d="M -8 1 L 0 9 M 8 1 L 0 9"/>
      <circle cx="0" cy="10" r="1.8"/>
      <rect x="-9" y="-25" width="18" height="11" rx="1.5"/>
      <rect x="-7.5" y="-38" width="15" height="13" rx="1"/>
      <path d="M -7.5 -38 L -6 -48 L 6 -48 L 7.5 -38"/>
      <path d="M -3.5 -48 L -5 -55 M 3.5 -48 L 5 -55"/>
      <path d="M 9 -26 A 9 11 0 0 1 9 -14"/>
      <path d="M -9 -30 L -22 -34 M 9 -30 L 20 -33"/>
      <rect x="-34" y="-38" width="12" height="7" rx="3.5"/>
      <rect x="20" y="-37" width="11" height="7" rx="3.5"/>
      <path d="M -9 -20 H -58"/>
    </g>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M -16 4 H 16" opacity=".8"/>
      <path d="M -9 1.2 A 9 9 0 0 0 9 1.2"/>
      <path d="M -7.5 -31.5 H 7.5"/>
      <path d="M -26 -23 V -17 M -42 -23 V -17"/>
      <path d="M -34 -34.5 H -22 M 20 -33.5 H 31" opacity=".7"/>
    </g>
    ${lamp(-60, -20, p)}` },

  /* New Horizons: the dish, the wedge bus, one RTG out on a stub */
  { key: "horizons", span: 44, mode: "aim", label: "NEW HORIZONS", start: 10, bow: [0.13, 0.28], talk: 1,
    draw: (p) => `
    <g fill="none" stroke="var(--chart-ink)" stroke-width="${p}" stroke-linejoin="round" stroke-linecap="round">
      <path d="M -14 4 A 14 14 0 0 0 14 4"/>
      <path d="M -6.5 1.5 L 0 8 M 6.5 1.5 L 0 8"/>
      <circle cx="0" cy="8.8" r="1.6"/>
      <path d="M -13 -10 L 13 -10 L 9 -27 L -9 -27 Z"/>
      <path d="M -13 -16 L -21 -14.5"/>
      <rect x="-41" y="-19" width="20" height="9" rx="4.5"/>
      <rect x="13" y="-23" width="7" height="6" rx="1"/>
      <rect x="13" y="-15" width="5.5" height="4.5" rx="1"/>
      <path d="M 0 -27 V -32"/>
      <rect x="-3.5" y="-36.5" width="7" height="4.5" rx="1"/>
    </g>
    <g fill="none" stroke="var(--chart-line)" stroke-width="${RULE(p)}">
      <path d="M -14 4 H 14" opacity=".8"/>
      <path d="M -7 1.6 A 7 7 0 0 0 7 1.6"/>
      <path d="M -11.5 -18.5 H 11.5"/>
      <path d="M -41 -14.5 H -21 M -35 -19 V -10 M -29 -19 V -10" opacity=".8"/>
    </g>
    ${lamp(-43, -14.5, p)}` },
];

/* ────────────────────────────────────────────────────────────────────────
   THE HOUSEHOLDS IN THE FAR DISTANCE

   Real coordinates, lifted from the galaxy map on home.html. A household's
   bearing is derived from its identity and can never move (CON-13), so the
   sky is a PANORAMA: the drift is the camera slewing, a household sits at
   the world position its true bearing gives it, and one full turn brings it
   round again on exactly that bearing. Faint, unlabelled, no pointer —
   display-only, and you never see your own constellation.
   ──────────────────────────────────────────────────────────────────────── */
/**
 * @typedef {{ pos: [number, number], planets: [number, number, number, string][] }} HomeDef
 */
/** @type {Record<string, HomeDef>} */
const GALAXY = {
  seaside: { pos: [-617, -305], planets: [[28, 10, 2.2, "--warm"], [-24, -8, 2, "--ok"], [-6, -26, 2.4, "--ok"]] },
  mumdad: { pos: [452, 522], planets: [[19, 4, 2.2, "--ok"], [-27, -5, 2.4, "--ok"]] },
  narrow: { pos: [-515, 393], planets: [[14, 11, 2.4, "--upcoming"], [-22, -16, 2.5, "--ok"]] },
  grans: { pos: [722, -184], planets: [[9, 27, 2.5, "--warm"], [-15, 16, 2.4, "--ok"]] },
};

/* ────────────────────────────────────────────────────────────────────────
   AND THE REST OF THE SKY

   Real constellations, borrowed by name and drawn as line figures — the sky
   an instance happens to be under, nothing to do with Orbit. Deliberately
   quieter than a household mark: chart-ink hairlines and plain stars, never
   a ring, never an orbit, never a coloured planet.
   ──────────────────────────────────────────────────────────────────────── */
/** @typedef {{ s: [number, number][], l: [number, number][] }} Figure */
/** @type {Record<string, Figure>} */
const FIGURES = {
  LYRA: { s: [[0, -22], [-9, -4], [7, -2], [-4, 12], [10, 14]], l: [[0, 1], [1, 2], [2, 0], [1, 3], [3, 4], [4, 2]] },
  VELA: { s: [[-20, -10], [6, -16], [18, 2], [-2, 14], [-18, 6]], l: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] },
  CASSIOPEIA: { s: [[-24, 4], [-12, -8], [0, 2], [12, -10], [24, 0]], l: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  ANDROMEDA: { s: [[-26, 10], [-12, 4], [2, 0], [14, -8], [24, -16], [6, 10]], l: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]] },
  PERSEUS: { s: [[-16, -14], [-4, -2], [8, -10], [2, 10], [16, 16], [-14, 8]], l: [[0, 1], [1, 2], [1, 3], [3, 4], [3, 5]] },
  CYGNUS: { s: [[0, -20], [0, -4], [0, 10], [0, 20], [-18, 0], [16, -2]], l: [[0, 1], [1, 2], [2, 3], [4, 1], [1, 5]] },
  ORION: { s: [[-15, -20], [14, -17], [-5, -2], [0, 0], [5, 2], [-16, 18], [12, 20]], l: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6]] },
  DRACO: { s: [[-26, 14], [-14, 6], [-2, 10], [8, 2], [16, -8], [9, -18], [20, -23]], l: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]] },
  AQUILA: { s: [[0, -16], [0, 0], [0, 14], [-19, -4], [18, -6], [-10, 11]], l: [[0, 1], [1, 2], [3, 1], [1, 4], [2, 5]] },
  CORVUS: { s: [[-16, -8], [10, -14], [16, 6], [-10, 12]], l: [[0, 1], [1, 2], [2, 3], [3, 0]] },
};
const FIGURE_NAMES = Object.keys(FIGURES);

/* the stream: four lanes, two depths. Stars and constellations move at the
   far rate; stars and craft at the near rate. Nearer is faster — the
   parallax is the only depth cue beyond size and ink strength. */
const V_FAR = 3.4; /* CSS px per second */
const V_NEAR = 7.2;
const CW_STAR = 400, CW_DECOR = 520, CW_FLEET = 300; /* chunk widths, px */
const PAD = 220; /* how far off each edge we keep built */

/** @param {number} a @param {number} n */
const mod = (a, n) => ((a % n) + n) % n;

/**
 * @typedef {{
 *   key: string, mode: "gimbal"|"aim"|"free", span: number, scale: number,
 *   wx: number, y: number, depth: number, att: number, jit: number, start: number,
 *   bowF: number, bowSign: number, ax: number, ay: number, tx: number, ty: number,
 *   px: number, py: number, node: SVGGElement, hull: SVGGElement,
 *   beam: ?SVGPathElement, gimbal: ?SVGGElement, gx: number, gy: number,
 *   label: ?SVGTextElement, labelDy: number,
 * }} Craft
 * @typedef {{ key: string, dist: number, x: number, y: number, r: number, dim: number }} HomeSpot
 * @typedef {{ g: SVGGElement, craft: Craft[] }} FleetChunk
 */

/**
 * Mounts the streaming sky, the fleet and the distant households into `root`,
 * and returns a teardown that removes everything this call added.
 *
 * @param {HTMLElement} root  the element to draw the backdrop into
 * @param {number} seed       this load's one roll — see the module doc
 * @returns {() => void}
 */
export function mountSatellites(root, seed) {
  const streamFor = streamFactory(seed);
  /** one rng per (lane, chunk) address, turned into a range picker */
  /** @param {number} lane @param {number} n */
  const laneRoll = (lane, n) => {
    const r = streamFor(lane, n);
    return (/** @type {number} */ a, /** @type {number} */ b) => a + r() * (b - a);
  };

  /* ---- the DOM this mount owns --------------------------------------- */
  const farLayer = /** @type {SVGGElement} */ (svgEl("g", { fill: "var(--star-far, #e9edf8)" }));
  const nearLayer = /** @type {SVGGElement} */ (svgEl("g", { fill: "var(--star-near, #f4f0ff)" }));
  const skySvg = /** @type {SVGSVGElement} */ (svgEl("svg", { preserveAspectRatio: "none" }));
  skySvg.append(farLayer, nearLayer);
  const skyDiv = document.createElement("div");
  skyDiv.className = "sky";
  skyDiv.setAttribute("aria-hidden", "true");
  skyDiv.appendChild(skySvg);

  const distantGroup = /** @type {SVGGElement} */ (svgEl("g"));
  const fleetGroup = /** @type {SVGGElement} */ (svgEl("g"));
  const trafficSvg = /** @type {SVGSVGElement} */ (svgEl("svg", { preserveAspectRatio: "none" }));
  trafficSvg.append(distantGroup, fleetGroup);
  const trafficDiv = document.createElement("div");
  trafficDiv.className = "traffic";
  trafficDiv.setAttribute("aria-hidden", "true");
  trafficDiv.appendChild(trafficSvg);

  root.append(skyDiv, trafficDiv);

  /* ---- the roll's per-mount state -------------------------------------- */
  const state = {
    W: 0, H: 0,
    target: { x: 0, y: 0 },
    card: { left: 0, right: 0, top: 0, bottom: 0 },
    fleetTarget: 3,
    /** @type {?HomeSpot[]} */
    homeSpots: null,
    boost: 1, slack: 1,
    C: 3000,
    wxNear0: 0,
    /** @type {Map<number, SVGGElement>} */
    far: new Map(),
    /** @type {Map<number, SVGGElement>} */
    near: new Map(),
    /** @type {Map<number, { g: SVGGElement, name: string }>} */
    decor: new Map(),
    /** @type {Map<string, SVGGElement>} */
    homes: new Map(),
    /** @type {Map<number, FleetChunk>} */
    fleetChunks: new Map(),
    /** @type {Craft[]} */
    craft: [],
  };

  /* ---- the two star lanes ------------------------------------------- */
  /**
   * @param {number} lane @param {number} n @param {number} cw @param {SVGGElement} host
   * @param {number} count @param {number} rmin @param {number} rspan
   * @param {number} omin @param {number} ospan @param {number} glints
   */
  function starChunk(lane, n, cw, host, count, rmin, rspan, omin, ospan, glints) {
    const r = laneRoll(lane, n), g = /** @type {SVGGElement} */ (svgEl("g"));
    const x0 = n * cw;
    for (let i = 0; i < count; i++) {
      const c = svgEl("circle");
      const o = omin + r(0, ospan);
      c.setAttribute("cx", (x0 + r(0, cw)).toFixed(1));
      c.setAttribute("cy", r(0, state.H).toFixed(1));
      c.setAttribute("r", (rmin + r(0, rspan)).toFixed(2));
      c.setAttribute("opacity", o.toFixed(2));
      if (r(0, 1) < 0.17) { /* a slow breath on a subset */
        c.setAttribute("class", "tw");
        c.style.setProperty("--o0", (o * 0.62).toFixed(2));
        c.style.setProperty("--o1", Math.min(1, o * 1.5).toFixed(2));
        c.style.setProperty("--twd", r(3.6, 11).toFixed(1) + "s");
      }
      g.appendChild(c);
    }
    /* the few that carry a glint — a chart-pen cross, not a lens flare */
    for (let i = 0; i < glints; i++) {
      const x = x0 + r(0, cw), y = r(0, state.H), L = r(3.4, 6.4), o = r(0.5, 0.85);
      const q = svgEl("g", { class: "tw", opacity: o.toFixed(2) });
      q.style.setProperty("--o0", (o * 0.72).toFixed(2));
      q.style.setProperty("--o1", o.toFixed(2));
      q.style.setProperty("--twd", r(5, 13).toFixed(1) + "s");
      q.innerHTML = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r(1.1, 1.8).toFixed(2)}"/>
        <path d="M ${(x - L).toFixed(1)} ${y.toFixed(1)} H ${(x + L).toFixed(1)}
                 M ${x.toFixed(1)} ${(y - L).toFixed(1)} V ${(y + L).toFixed(1)}"
              fill="none" stroke="var(--star-near)" stroke-width=".6" opacity=".5"/>`;
      g.appendChild(q);
    }
    host.appendChild(g);
    return g;
  }

  /* Where your households sit in the panorama: azimuth along the drift
     axis, elevation from the vertical part of the same bearing, both
     derived from the identity coordinates and therefore never moving
     (CON-13). Positions repeat once per full turn of the sky. */
  function homeWorld() {
    if (state.homeSpots) return state.homeSpots;
    state.homeSpots = Object.entries(GALAXY).map(([key, hh]) => {
      const [ox, oy] = hh.pos, dist = Math.hypot(ox, oy);
      return {
        key, dist,
        x: (mod(Math.atan2(oy, ox) * 180 / Math.PI, 360) / 360) * state.C,
        y: state.H / 2 + (oy / dist) * state.H * 0.30,
        r: 32 + (dist % 13),
        /* your households stay the brightest thing in the backdrop: they
           are the only marks out there that mean anything */
        dim: Math.max(0.35, Math.min(0.68, 0.74 - dist / 8000)),
      };
    });
    return state.homeSpots;
  }
  /** @param {number} a @param {number} b */
  const turnGap = (a, b) => Math.min(mod(a - b, state.C), mod(b - a, state.C));

  /* --- the borrowed constellations ---------------------------------------- */
  /** @param {number} n @param {SVGGElement} host */
  function decorChunk(n, host) {
    const r = laneRoll(3, n), g = /** @type {SVGGElement} */ (svgEl("g")), x0 = n * CW_DECOR;
    const want = 0.9, k = Math.floor(want) + (r(0, 1) < want % 1 ? 1 : 0);
    /* no figure may be on screen twice: a new chunk simply draws again
       until it finds one that is not already out */
    const out = new Set([...state.decor.values()].map((e) => e.name));
    let name = "";
    for (let i = 0; i < k; i++) {
      name = FIGURE_NAMES[Math.floor(r(0, FIGURE_NAMES.length)) % FIGURE_NAMES.length];
      for (let t = 0; t < 14 && out.has(name); t++)
        name = FIGURE_NAMES[Math.floor(r(0, FIGURE_NAMES.length)) % FIGURE_NAMES.length];
      out.add(name);
      const fig = FIGURES[name];
      /* a borrowed constellation and a household both ride the far layer,
         so an overlap between them would be locked together forever */
      let x = 0, y = 0;
      for (let a = 0; a < 8; a++) {
        x = x0 + r(30, CW_DECOR - 30);
        y = r(64, Math.max(90, state.H - 96));
        if (!homeWorld().some((h) => Math.hypot(turnGap(h.x, x), h.y - y) < h.r + 68)) break;
      }
      /* legible, but never competing: roughly two thirds of a household
         mark, and no colour at all */
      const sc = r(0.7, 1.5), rot = r(-24, 24), op = r(0.26, 0.44);
      const links = fig.l.map(([a, b]) => `M ${fig.s[a][0]} ${fig.s[a][1]} L ${fig.s[b][0]} ${fig.s[b][1]}`).join(" ");
      const dots = fig.s
        .map(([sx, sy], idx) => `<circle cx="${sx}" cy="${sy}" r="${(idx === 0 ? 1.9 : 1.35).toFixed(2)}" fill="var(--chart-ink)"/>`)
        .join("");
      const mark = svgEl("g", { opacity: op.toFixed(2), transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` });
      mark.innerHTML = `<g transform="rotate(${rot.toFixed(1)}) scale(${sc.toFixed(2)})">
           <path d="${links}" fill="none" stroke="var(--chart-ink)"
                 stroke-width="${(0.95 / sc).toFixed(2)}" opacity=".82"/>${dots}
         </g>
         <text y="${(26 * sc + 13).toFixed(1)}" text-anchor="middle" fill="var(--chart-ink)"
               opacity=".95">${name}</text>`;
      const tag = /** @type {SVGTextElement} */ (mark.querySelector("text"));
      tag.style.fontFamily = "var(--mono)";
      tag.style.fontSize = (7.2 + 1.4 * sc).toFixed(1) + "px";
      tag.style.letterSpacing = ".26em";
      g.appendChild(mark);
    }
    host.appendChild(g);
    return { g, name };
  }

  /* --- your households, on their true bearings ----------------------------- */
  /** @param {string} key @param {number} turn @param {SVGGElement} host */
  function householdMark(key, turn, host) {
    const hh = GALAXY[key];
    const spot = /** @type {HomeSpot} */ (homeWorld().find((h) => h.key === key));
    const x = spot.x + turn * state.C, y = spot.y, dim = spot.dim, R = spot.r;
    const g = /** @type {SVGGElement} */ (svgEl("g", { opacity: dim.toFixed(2), transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }));
    g.innerHTML =
      `<circle r="${R.toFixed(1)}" fill="none" stroke="var(--chart-line)" stroke-width="1"/>
       <circle r="${(R * 0.62).toFixed(1)}" fill="none" stroke="var(--chart-line-soft)"
               stroke-width=".85" stroke-dasharray="2 5"/>
       <path d="M 0 ${(-R - 6).toFixed(1)} V ${(-R - 1.5).toFixed(1)}
                M 0 ${(R + 1.5).toFixed(1)} V ${(R + 6).toFixed(1)}
                M ${(-R - 6).toFixed(1)} 0 H ${(-R - 1.5).toFixed(1)}
                M ${(R + 1.5).toFixed(1)} 0 H ${(R + 6).toFixed(1)}"
             fill="none" stroke="var(--chart-line)" stroke-width=".85"/>` +
      hh.planets
        .map(([px, py]) => `<circle r="${(Math.hypot(px, py) * 0.85).toFixed(1)}" fill="none"
                 stroke="var(--chart-line-soft)" stroke-width=".7" opacity=".8"/>`)
        .join("") +
      `<circle r="2.9" fill="var(--ink)"/>
       <path d="M -9 0 H 9 M 0 -9 V 9" fill="none" stroke="var(--ink)" stroke-width=".6" opacity=".45"/>` +
      hh.planets
        .map(([px, py, pr, tok]) => `<circle cx="${(px * 0.85).toFixed(1)}" cy="${(py * 0.85).toFixed(1)}" r="${pr}" fill="var(${tok})"/>`)
        .join("");
    host.appendChild(g);
    return g;
  }

  /* --- the fleet ----------------------------------------------------------- */
  /** @param {number} n @param {SVGGElement} host */
  function fleetChunk(n, host) {
    const r = laneRoll(4, n), x0 = n * CW_FLEET;
    const g = /** @type {SVGGElement} */ (svgEl("g"));
    /** @type {Craft[]} */
    const made = [];
    /* a little under the target, because the roll is nudged up afterwards
       if the opening screenful came out thin — and scaled back on a narrow
       sky, where the card already owns most of it */
    const density = (state.fleetTarget * 0.9 * state.boost * Math.min(1, state.W / 900)) / state.W;
    const want = CW_FLEET * density;
    const k = Math.min(2, Math.floor(want) + (r(0, 1) < want % 1 ? 1 : 0));
    const sizeF = Math.max(0.72, Math.min(1, state.W / 1200));

    for (let i = 0; i < k; i++) {
      /* type: never the same craft twice in one skyful */
      let type = ROSTER[0];
      for (let t = 0; t < 10; t++) {
        const cand = ROSTER[Math.floor(r(0, ROSTER.length)) % ROSTER.length];
        if (!state.craft.some((c) => c.key === cand.key)) { type = cand; break; }
        type = cand;
      }
      /* depth: the deep-space probes sit far out, the comms birds close
         in — and once in a while the roll turns that on its head */
      const deep = type.mode === "aim" || type.mode === "free";
      let depth = deep ? r(0.38, 1) : r(0, 0.72);
      if (r(0, 1) < 0.18) depth = 1 - depth;

      const norm = Math.pow(46 / type.span, 0.55);
      const scale = (1.46 - 0.98 * depth) * norm * sizeF;
      const halfSpan = type.span * scale + 12;
      /* the pen holds a readable weight all the way out: a far craft is
         small and quiet, never a smudge (owner, §14 — "a bit too faded") */
      const pen = (1.45 - 0.40 * depth) / scale;

      /* where: a free y anywhere in the sky, an x anywhere in this chunk,
         but never on top of another craft — and, for the chunks making up
         the first screenful, never on top of the card either. Later
         chunks are born off the right-hand edge, where the card is not, so
         the keep-out simply stops applying and the drift is free to carry
         a craft behind the glass, which swallows it. */
      let wx = /** @type {?number} */ (null), y = 0;
      const yPad = Math.min(halfSpan * 0.6, state.H * 0.2);
      const k1 = state.card, sl = state.slack, clr = halfSpan * sl;
      for (let a = 0; a < 14; a++) {
        const cx = x0 + r(0, CW_FLEET);
        const cy = r(yPad, state.H - yPad);
        const sx = cx - state.wxNear0;
        if (sl > 0 && sx > k1.left - clr - 26 * sl && sx < k1.right + clr + 26 * sl &&
            cy > k1.top - clr - 20 * sl && cy < k1.bottom + clr + 20 * sl) continue;
        /* and not straight on top of a household */
        if (sl > 0 && homeWorld().some((h) => {
          const gap = mod(h.x - (state.wxNear0 * V_FAR) / V_NEAR - sx + state.C / 2, state.C) - state.C / 2;
          return Math.hypot(gap, h.y - cy) < h.r + halfSpan * 0.55;
        })) continue;
        if (state.craft.concat(made).some((c) => Math.hypot(c.wx - cx, c.y - cy) < 118 + halfSpan * 0.75 + c.span * c.scale * 0.75)) continue;
        wx = cx; y = cy; break;
      }
      if (wx === null) continue;

      const node = /** @type {SVGGElement} */ (svgEl("g", { class: "craft" }));

      /** @type {Craft} */
      const c = {
        key: type.key, mode: type.mode, span: type.span, scale, wx, y, depth,
        att: r(0, 360), jit: r(-11, 11), start: type.start,
        bowF: r(type.bow[0], type.bow[1]), bowSign: r(0, 1) < 0.5 ? -1 : 1,
        ax: r(6, 17), ay: r(4, 11), tx: r(24, 46), ty: r(19, 38),
        px: r(0, 6.28), py: r(0, 6.28), node,
        hull: /** @type {SVGGElement} */ (svgEl("g")), beam: null, gimbal: null, gx: 0, gy: 0,
        label: null, labelDy: 0,
      };

      /* the conveyed message: dotted, travelling craft → relay, curving
         as a real pass would, re-solved every frame as the craft drifts.
         It ends on the dish itself and is swallowed by the glass. */
      if (r(0, 1) < type.talk) {
        const b = /** @type {SVGPathElement} */ (svgEl("path", {
          class: "beam", fill: "none", stroke: "var(--accent)",
          "stroke-width": (1.25 - 0.4 * depth).toFixed(2),
          "stroke-linecap": "round",
          opacity: (0.52 - 0.26 * depth).toFixed(2),
        }));
        const gap = 9 + 6 * depth;
        b.style.setProperty("--dash", `1.7 ${gap.toFixed(1)}`);
        b.style.setProperty("--doff", (1.7 + gap).toFixed(1));
        b.style.setProperty("--bmdur", r(3.4, 6.2).toFixed(1) + "s");
        node.appendChild(b);
        c.beam = b;
      }

      const hull = /** @type {SVGGElement} */ (svgEl("g", { class: "hull", opacity: (1 - 0.36 * depth).toFixed(2) }));
      hull.style.setProperty("--bldur", r(4.5, 9).toFixed(1) + "s");
      hull.innerHTML = `<g class="sway" style="--sw:${r(0.7, 1.7).toFixed(2)}deg;--swdur:${r(26, 46).toFixed(0)}s">
          ${type.draw(+pen.toFixed(2))}</g>`;
      node.appendChild(hull);
      c.hull = hull;
      const gim = /** @type {?SVGGElement} */ (hull.querySelector(".gimbal"));
      if (gim) { c.gimbal = gim; c.gx = Number(gim.dataset.gx); c.gy = Number(gim.dataset.gy); }

      /* a name, if it is one of the famous ones and it is near enough to
         carry one without shouting */
      if (type.label && depth < 0.86) {
        const fs = (10.6 - 3.2 * depth) * sizeF;
        const t = /** @type {SVGTextElement} */ (svgEl("text", {
          "text-anchor": "middle", fill: "var(--chart-ink)",
          opacity: (0.68 - 0.3 * depth).toFixed(2),
        }));
        t.style.fontFamily = "var(--mono)";
        t.style.fontSize = fs.toFixed(1) + "px";
        t.style.letterSpacing = ".22em";
        t.textContent = type.label;
        node.appendChild(t);
        c.label = t;
        c.labelDy = type.span * scale * 0.66 + fs * 1.5;
      }

      g.appendChild(node);
      made.push(c);
    }
    host.appendChild(g);
    return { g, craft: made };
  }

  /* --- keeping the window stocked ------------------------------------------ */
  /** @param {number} wx @param {number} cw */
  function chunkRange(wx, cw) {
    return { first: Math.floor((wx - PAD) / cw), last: Math.floor((wx + state.W + PAD) / cw) };
  }

  function ensure(/** @type {number} */ t) {
    const wxFar = t * V_FAR, wxNear = t * V_NEAR;

    /* densities are per square pixel of sky, so the field reads the same
       on a phone and on a desk */
    {
      const { first, last } = chunkRange(wxFar, CW_STAR);
      for (let n = first; n <= last; n++) if (!state.far.has(n))
        state.far.set(n, starChunk(1, n, CW_STAR, farLayer, Math.round(CW_STAR * state.H * 1.95e-4), 0.45, 0.62, 0.19, 0.34, 0));
      for (const [n, node] of state.far) if (n < first || n > last) { node.remove(); state.far.delete(n); }
    }
    {
      const { first, last } = chunkRange(wxNear, CW_STAR);
      for (let n = first; n <= last; n++) if (!state.near.has(n))
        state.near.set(n, starChunk(2, n, CW_STAR, nearLayer,
          Math.round(CW_STAR * state.H * 9.2e-5), 0.95, 0.85, 0.40, 0.50,
          Math.round(CW_STAR * state.H * 1.15e-5)));
      for (const [n, node] of state.near) if (n < first || n > last) { node.remove(); state.near.delete(n); }
    }
    {
      const { first, last } = chunkRange(wxFar, CW_DECOR);
      for (let n = first; n <= last; n++) if (!state.decor.has(n)) state.decor.set(n, decorChunk(n, distantGroup));
      for (const [n, entry] of state.decor) if (n < first || n > last) { entry.g.remove(); state.decor.delete(n); }
    }

    /* households: not chunks but bearings — one instance per turn of the
       sky, and a turn where a household is not out is a turn you simply do
       not see it (§14, "not necessarily all of them every time") */
    const want = new Set();
    for (const spot of homeWorld()) {
      const key = spot.key, base = spot.x;
      const k0 = Math.ceil((wxFar - PAD - base) / state.C), k1 = Math.floor((wxFar + state.W + PAD - base) / state.C);
      for (let k = k0; k <= k1; k++) {
        const roll = laneRoll(5 + key.length, k * 31 + key.charCodeAt(0));
        if (roll(0, 1) > 0.78) continue; /* out tonight? */
        want.add(key + "#" + k);
      }
    }
    for (const id of want) if (!state.homes.has(id)) {
      const [key, k] = id.split("#");
      state.homes.set(id, householdMark(key, +k, distantGroup));
    }
    for (const [id, node] of state.homes) if (!want.has(id)) { node.remove(); state.homes.delete(id); }

    /* the fleet: chunk entries carry their craft, so dropping a chunk
       retires the craft that were in it */
    const a = Math.floor((wxNear - PAD) / CW_FLEET), b = Math.floor((wxNear + state.W + PAD) / CW_FLEET);
    let changed = false;
    for (const [n, entry] of state.fleetChunks) if (n < a || n > b) { entry.g.remove(); state.fleetChunks.delete(n); changed = true; }
    if (changed) state.craft = [...state.fleetChunks.values()].flatMap((e) => e.craft);
    for (let n = a; n <= b; n++) if (!state.fleetChunks.has(n)) {
      state.fleetChunks.set(n, fleetChunk(n, fleetGroup));
      state.craft = [...state.fleetChunks.values()].flatMap((e) => e.craft);
    }
  }

  /* --- one frame ------------------------------------------------------------ */
  function place(/** @type {number} */ t) {
    const wxFar = t * V_FAR, wxNear = t * V_NEAR;
    farLayer.setAttribute("transform", `translate(${(-wxFar).toFixed(1)} 0)`);
    nearLayer.setAttribute("transform", `translate(${(-wxNear).toFixed(1)} 0)`);
    distantGroup.setAttribute("transform", `translate(${(-wxFar).toFixed(1)} 0)`);

    const target = state.target;
    for (const c of state.craft) {
      const x = c.wx - wxNear + c.ax * Math.sin(t / c.tx + c.px);
      const y = c.y + c.ay * Math.sin(t / c.ty + c.py);
      const dx = target.x - x, dy = target.y - y, len = Math.hypot(dx, dy) || 1;
      const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
      /* "aim" turns the whole bus home; anything else lies where it lies */
      const att = c.mode === "aim" ? bearing - 90 + c.jit : c.att;
      c.hull.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${att.toFixed(1)}) scale(${c.scale.toFixed(3)})`);
      /* the gimbal: page-frame bearing brought into the craft's own
         frame, then a quarter turn because every dish is drawn facing
         local +y */
      if (c.gimbal) c.gimbal.setAttribute("transform", `translate(${c.gx} ${c.gy}) rotate(${(bearing - att - 90).toFixed(1)})`);
      if (c.beam) {
        const sx = x + (dx / len) * c.start * c.scale, sy = y + (dy / len) * c.start * c.scale;
        const bow = c.bowSign * len * c.bowF;
        const mx = (sx + target.x) / 2 - (dy / len) * bow, my = (sy + target.y) / 2 + (dx / len) * bow;
        c.beam.setAttribute("d", `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${target.x.toFixed(1)} ${target.y.toFixed(1)}`);
      }
      if (c.label) c.label.setAttribute("transform", `translate(${x.toFixed(1)} ${(y + c.labelDy).toFixed(1)})`);
    }
  }

  /* --- build / rebuild ------------------------------------------------------ */
  function build() {
    const W = window.innerWidth, H = window.innerHeight;
    state.W = W; state.H = H;
    skySvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    trafficSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    for (const layer of [farLayer, nearLayer, distantGroup, fleetGroup]) layer.textContent = "";
    state.far.clear(); state.near.clear(); state.decor.clear(); state.homes.clear();
    state.fleetChunks = new Map(); state.craft = [];

    /* everything is aimed at the dish on the card, wherever the card is */
    const cardEl = document.querySelector(".relay-card");
    const dishEl = document.getElementById("relaydish");
    const cardBox = cardEl ? cardEl.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
    state.card = { left: cardBox.left, right: cardBox.right, top: cardBox.top, bottom: cardBox.bottom };
    const d = dishEl ? dishEl.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    state.target = { x: d.left + d.width / 2, y: d.top + d.height / 2 };

    /* per-roll parameters: how busy this particular sky is, and how far
       round the panorama the households are spread */
    const roll = laneRoll(0, 0);
    state.fleetTarget = 2 + Math.floor(roll(0, 3));
    state.C = Math.max(2.1 * W, 1900); /* one full turn of the panorama */
    state.homeSpots = null; /* bearings re-solved against it */
    state.wxNear0 = clock * V_NEAR; /* the card keep-out applies to the first screenful */

    /* A sky with nothing in it is not a sky. Between the card keep-out and
       the spacing rule a thin roll can come up empty on the opening
       screenful — and on a phone that is the normal case rather than the
       unlucky one. If stillness has been asked for, that opening
       screenful is the only one there will ever be, so the roll steps up:
       busier, then closer to the card, and in the last resort a craft may
       slip behind the glass, which swallows it. Steps, never a craft sat
       squarely on the card at full strength. */
    const STEPS = [{ d: 1, s: 1 }, { d: 1.35, s: 0.55 }, { d: 1.7, s: 0.2 }, { d: 2, s: 0 }];
    for (const step of STEPS) {
      state.boost = step.d; state.slack = step.s;
      for (const e of state.fleetChunks.values()) e.g.remove();
      state.fleetChunks.clear(); state.craft = [];
      ensure(clock);
      const outNow = state.craft.filter((c) => c.wx - state.wxNear0 > -40 && c.wx - state.wxNear0 < state.W + 40).length;
      if (outNow >= 2) break;
    }
    place(clock);
  }

  /* --- the clock: honours prefers-reduced-motion the way skies.js does ----
     `still()` is read every frame rather than cached, so an OS-level change
     mid-session freezes or resumes the drift without a remount. */
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const still = () => motion.matches;
  let clock = 0, lastTs = /** @type {?number} */ (null), lastDrawn = -1;
  let raf = /** @type {?number} */ (null);
  function tick(/** @type {number} */ ts) {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min(0.2, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!still()) clock += dt;
    if (clock !== lastDrawn) { ensure(clock); place(clock); lastDrawn = clock; }
    raf = requestAnimationFrame(tick);
  }

  /* Built once the faces are in, as the sheet is: the card keep-out and the
     dish the beams aim at are measured from the card, and a card set in a
     fallback face is 30px the wrong height — the craft would be placed round
     a card that is not the one on screen. A face only starts loading once
     something laid out has asked for it, so the layout is forced first;
     `fonts.ready` then settles once those loads land, and at once when
     nothing is loading. Bundled faces make this a tick, not a wait; a
     teardown before then leaves nothing to build. Test DOMs have no
     `document.fonts` and build synchronously. */
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

  let resizeTimer = /** @type {?ReturnType<typeof setTimeout>} */ (null);
  const onResize = () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(build, 140);
  };
  addEventListener("resize", onResize);

  return () => {
    torn = true;
    if (raf !== null) cancelAnimationFrame(raf);
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    removeEventListener("resize", onResize);
    root.textContent = "";
  };
}
