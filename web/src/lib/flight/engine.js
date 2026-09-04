/**
 * THE FLIGHT — one canvas engine, run UP or DOWN (#410, §15).
 *
 * Ported from design/v19/first-run.html as committed at 159ec9f, which the
 * owner ratified verbatim on 2026-08-16: "nothing short of amazing... Ship
 * these in that exact form." Every timing, curve, colour and pen in this file
 * is the mockup's own. Nothing here is a re-authoring: the profiles, the
 * bloom, the world and the frame body are the sheet's code, wrapped in a
 * factory so the module holds no globals and the unit tests can drive it.
 *
 * DOWN is not a second animation. `mirror()` maps descent time onto ascent
 * time and the speed curve, the atmosphere curve, the prop schedule and the
 * bloom are all read off the ascent through it — so the sun contracts, the
 * streaks decelerate in reverse, the limb rises back beneath you and the
 * colours return from the dark to the dawn, because that is what the climb
 * looks like run the other way. drawBloom() is ONE function, read forwards by
 * the login and backwards by the logout, exactly as the mockup reads it.
 *
 * The flight colour-matches the DEFAULT pack (star-chart) whatever pack the
 * reader is wearing — the owner's words say default theme, and the sky you are
 * climbing into is not yet yours to have chosen. If it is ever asked to wear
 * the reader's pack, PACK is the only object that changes.
 */
import { seededRng } from "$lib/sky.js";

/**
 * @typedef {object} Atmosphere
 * @property {string} ground
 * @property {string} rim1
 * @property {string} rim2
 * @property {Array<[number, string, number]>} bands
 * @property {Array<[number, string, number]>} wash
 * @property {string | null} glowCore
 * @property {string} glowMid
 * @property {string} glowWide
 * @property {boolean} hasSun
 */

/**
 * A prop schedule entry (PROPS_UP/PROPS_DOWN), extended in `prime()` with the
 * per-run fields (`p`, `rad`, `rot0`, and the shape's own `pts`/`bodies`) and
 * further in `step()` with the fields the pen draws from (`al`, `hair`).
 * @typedef {object} Prop
 * @property {"grat" | "con" | "sys" | "craft" | "comet"} kind
 * @property {number} t0
 * @property {number} dur
 * @property {number} ang
 * @property {number} z
 * @property {number} spin
 * @property {number} [shape]
 * @property {number} [k]
 * @property {number} [p]
 * @property {number} [rad]
 * @property {number} [rot0]
 * @property {number[][]} [pts]
 * @property {Array<[number, number, string, number]>} [bodies]
 * @property {number} [al]
 * @property {number} [hair]
 */

/**
 * The deep-field dust (NEB_SPEC), extended in `prime()`/`step()` with its own
 * running bearing and the drift position it resets to on every run.
 * @typedef {object} Nebula
 * @property {number} ang
 * @property {number} z
 * @property {string} col
 * @property {number} size
 * @property {number} al
 * @property {number} p
 * @property {number} [rad]
 * @property {number} [p0]
 */

/** @typedef {{ r: number, a: number, z: number, c: string }} Star */

/**
 * A prop as the pen functions see it: always called from `step()`'s props
 * loop, strictly after `prime()` has set `rad`/`rot0` (and `pts`/`bodies` for
 * the kinds that carry them) and after that same loop iteration has just set
 * `al`/`hair`.
 * @typedef {Prop & { al: number, hair: number, rad: number, rot0: number }} HydratedProp
 */

/**
 * @typedef {object} Profile
 * @property {number} dur
 * @property {number} vpY
 * @property {number} a0
 * @property {number} a1
 * @property {Atmosphere} pal
 * @property {Atmosphere} [palTo]
 * @property {Prop[]} props
 * @property {number} K
 * @property {boolean} [rev]
 * @property {(t: number) => number} speed
 * @property {(t: number) => number} atm
 * @property {(t: number) => number} [duskMix]
 */

/**
 * The in-progress flight, held in `prime()` for the duration of one run.
 * @typedef {object} FlightState
 * @property {Profile} P
 * @property {boolean} rev
 * @property {number} start
 * @property {number} last
 * @property {Prop[]} props
 * @property {number} dpr
 */

/* star-chart, verbatim from web/src/lib/packs.css */
export const PACK = {
  bg: "#060b1c", star: "#e9edf8", starNear: "#f4f0ff", accent: "#d8b45a",
  up: "#8fb8ff", line: "#243259", lineSoft: "#17203f", ink: "#737e9e",
  sun: "#ffe9c4", sunCore: "#fff6e6",
  /* The same pen, lifted. --chart-line and friends are set to be legible on
     a panel; against open sky they disappear. One step up, no new hues. */
  penHi: "#7e8cb8", pen: "#4a5c93", penLo: "#2f3d6b", hull: "#0b1226",
};

/* dawn (the login's own sky) and dusk (the goodbye's) — the two atmospheres
   the flight passes through. Dawn's values are lifted straight out of
   family/login.html; dusk's out of family/maintenance.html's dusk band. */
/** @type {Atmosphere} */
export const DAWN = {
  ground: "#04060e", rim1: "#ffd989", rim2: "#e2772b",
  bands: [[150, "#7a2c18", 0.10], [84, "#e2772b", 0.16], [34, "#f0b429", 0.28],
          [12, "#ffd989", 0.40], [4, "#fff3d6", 0.65]],
  wash: [[0.62, "#3d2a4d", 0.12], [0.86, "#a2492a", 0.20], [1, "#e2772b", 0.26]],
  glowCore: "#fffdf6", glowMid: "#f8c95e", glowWide: "#e2772b", hasSun: true,
};
/** @type {Atmosphere} */
export const DUSK = {
  ground: "#03050b", rim1: "#f0a35a", rim2: "#7a2c18",
  bands: [[130, "#5e2418", 0.12], [60, "#c2571f", 0.20], [20, "#e08a3c", 0.26],
          [5, "#ffd9a0", 0.30]],
  wash: [[0.40, "#1e1838", 0.30], [0.62, "#3b2450", 0.34], [0.78, "#83354f", 0.26],
         [0.91, "#a2492a", 0.22], [1, "#c2571f", 0.22]],
  glowCore: null, glowMid: "#e08a3c", glowWide: "#a2492a", hasSun: false,
};

/* the deep field: dust you fall through rather than past */
/** @type {Nebula[]} */
const NEB_SPEC = [
  { ang: 74, z: 0.10, col: "#22346e", size: 1.55, al: 0.20, p: 0.10 },
  { ang: 118, z: 0.07, col: "#2c1f4a", size: 1.90, al: 0.17, p: 0.32 },
  { ang: 52, z: 0.13, col: "#3a2a1c", size: 1.20, al: 0.13, p: 0.55 },
  { ang: 96, z: 0.08, col: "#16304a", size: 1.70, al: 0.15, p: 0.78 },
];

/* the sheet's own seed: deterministic noise, so a flight screenshots the same
   every time. The gate's law — no Math.random, no Date.now, in anything the
   camera sees — is kept by construction: the only randomness here is this
   seed, and the only clock is the one the caller injects. */
export const FLIGHT_SEED = 20260816;

/* constellation shapes, drawn once — nodes in a ~340-unit box */
const CONS = [
  [[-150, -58, 3.2], [-52, -96, 2.2], [24, -24, 3.8], [104, -72, 2.4], [168, 26, 2.8]],
  [[-140, 52, 2.6], [-40, 10, 3.4], [46, 58, 2.2], [128, -6, 3.0]],
  [[-120, -40, 2.4], [-20, -84, 3.0], [62, -30, 2.2], [96, 52, 3.4], [-8, 74, 2.4], [-120, -40, 2.2]],
];
const BODY_COLS = ["#f0b429", "#4ade80", "#8fb8ff", "#f87171"];
/**
 * @param {number} k
 * @returns {Array<[number, number, string, number]>}
 */
function systemBodies(k) {
  /** @type {Array<[number, number, string, number]>} */
  const out = [];
  for (let i = 0; i < 3; i++) {
    const a = (k * 2.1 + i * 2.3), r = 52 + (i % 2) * 26;
    out.push([Math.cos(a) * r, Math.sin(a) * r, BODY_COLS[(k + i) % 4], 3 + (i % 2)]);
  }
  return out;
}

/* Prop schedules. `t0` is when it enters, `dur` how long it takes to sweep
   past at full speed (it slows when the ship does), `ang` its bearing off the
   vanishing point, `z` how close it passes. */
/** @type {Prop[]} */
export const PROPS_UP = [
  { kind: "grat", t0: 620, dur: 3000, ang: 96, z: 0.40, spin: -0.10 },
  { kind: "con", t0: 760, dur: 2300, ang: 52, z: 0.62, shape: 0, spin: 0.16 },
  { kind: "sys", t0: 980, dur: 2500, ang: 126, z: 0.58, k: 1, spin: -0.20 },
  { kind: "con", t0: 1180, dur: 2100, ang: 150, z: 0.50, shape: 1, spin: -0.22 },
  { kind: "craft", t0: 1320, dur: 2000, ang: 64, z: 0.86, spin: 0.30 },
  { kind: "grat", t0: 1520, dur: 2300, ang: 112, z: 0.44, spin: 0.12 },
  { kind: "comet", t0: 1700, dur: 1150, ang: 36, z: 0.80, spin: 0.08 },
  { kind: "sys", t0: 1800, dur: 1700, ang: 88, z: 0.42, k: 3, spin: 0.14 },
  { kind: "con", t0: 1900, dur: 1400, ang: 134, z: 0.66, shape: 2, spin: 0.18 },
  { kind: "con", t0: 2020, dur: 1250, ang: 42, z: 0.58, shape: 1, spin: -0.14 },
  { kind: "sys", t0: 2120, dur: 1350, ang: 108, z: 0.62, k: 5, spin: -0.16 },
];

/* ── the two profiles ─────────────────────────────────────────────────────
   UP · 4800ms.  0–300 ignition (the ship is barely moving; the mark flares
   and the card dissolves) · 300–1350 hard acceleration out of the dawn ·
   1350–2600 cruise through the dark, where all the chart-pen traffic is ·
   2600–3500 deceleration onto the household's own coordinates · 3400–4800
   THE REVEAL: 1.4 slow seconds of the sun blooming.

   DOWN · 4100ms, and NOT ITS OWN CURVE. Negative speed is the whole trick:
   the star engine multiplies each star's radius by (1 + v·dt·K·z), so a
   negative v contracts the field toward the vanishing point and draws each
   streak from outside in. It reads at 0.854× the climb — the reversal earns a
   little pace, and the owner left that to the eye. */
export const UPDUR = 4800;
export const DOWNDUR = 4100;
export const REV = DOWNDUR / UPDUR;
/** @param {number} t */
export const mirror = (t) => UPDUR * (1 - Math.min(1, Math.max(0, t / DOWNDUR)));

/** @type {Profile} */
export const UP = {
  dur: UPDUR, vpY: -0.55, a0: 28, a1: 152, pal: DAWN, props: PROPS_UP, K: 7.4,
  speed(t) {
    if (t < 300) return 0.02 + 0.10 * (t / 300);
    if (t < 1350) { const u = (t - 300) / 1050; return 0.12 + 0.88 * Math.pow(u, 2.2); }
    if (t < 2600) return 1;
    if (t < 3500) { const u = (t - 2600) / 900; return 1 - Math.pow(u, 1.55); }
    return 0;
  },
  /* atmosphere: 0 = sitting on the login's dawn, 1 = clean of it */
  atm(t) { const u = Math.min(1, Math.max(0, (t - 240) / 1450)); return Math.pow(u, 1.9); },
};

/* the props, mirrored rather than re-authored: same traffic, same bearings,
   met in the opposite order, turning the other way, passing at REV pace.
   SWEEP pulls each pass in so the sky is empty by the time the limb returns. */
export const SWEEP = 0.75;
export const PROPS_DOWN = PROPS_UP.map((g) => ({
  kind: g.kind, shape: g.shape, k: g.k, ang: g.ang, z: g.z,
  spin: -(g.spin || 0),
  dur: g.dur * REV * SWEEP,
  t0: Math.max(0, (UPDUR - (g.t0 + g.dur)) * REV),
}));

/** @type {Profile} */
export const DOWN = {
  dur: DOWNDUR, vpY: UP.vpY, a0: UP.a0, a1: UP.a1, K: UP.K, props: PROPS_DOWN, rev: true,
  /* the destination surface still wears DUSK (the family rule the owner kept
     in the same breath), so the returning dawn COOLS into it across the last
     third rather than being swapped for it at the handoff. */
  pal: DAWN, palTo: DUSK,
  speed(t) { return -UP.speed(mirror(t)); },
  atm(t) { return UP.atm(mirror(t)); },
  duskMix(t) { return Math.max(0, Math.min(1, (t / DOWNDUR - 0.64) / 0.36)); },
};

/* ── THE REVEAL (§15 second pass, ruling 2) ───────────────────────────────
   The first pass ran 2760→3360 and read as a flash; this runs 3200→4500 (and
   then holds, so the handoff happens in full light) and is built to be slow on
   purpose: the SKY takes the colour well before the core does (a 0.72 power
   curve against the core's 1.45), the core grows on an eased radius rather
   than a smoothstep pop, and the two shockwaves are halved in weight. */
export const BLOOM_T0 = 3200;
export const BLOOM_DUR = 1300;
/** @param {number} tau */
export function bloomAt(tau) {
  return Math.max(0, Math.min(1, (tau - BLOOM_T0) / BLOOM_DUR));
}

/** @param {string} hex @param {number} a */
export function hexa(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}

/* the exposure the streaks are drawn at (seconds) */
const SHUTTER = 0.042;
/* the fixed step a pinned flight is simulated at: 60fps, so a beat asked for
   by the fixtures is the same beat every time on every machine */
const PINNED_STEP = 1000 / 60;

/**
 * One flight, bound to one canvas. Everything the mockup held at module scope
 * lives in this closure instead, so two of these can never tread on each
 * other and a test can build one without a page.
 */
/**
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   requestFrame?: (fn: FrameRequestCallback) => number,
 *   cancelFrame?: (id: number) => void,
 *   now?: () => number,
 *   devicePixelRatio?: number,
 * }} [options]
 */
export function createFlight(canvas, options = {}) {
  /* Always a 2D canvas freshly created for this flight; the null case in the
     DOM type is for an already-spent contextType mismatch, which cannot
     happen here. */
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const raf = options.requestFrame ?? ((fn) => requestAnimationFrame(fn));
  const cancel = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  const clock = options.now ?? (() => performance.now());

  let W = 0, H = 0, DIAG = 0;
  let VPX = 0, VPY = 0, A0 = 0, A1 = 0, RMAX = 0;
  let rnd = seededRng(FLIGHT_SEED);
  /** @type {Star[]} */
  const STARS = [];
  const NEB = NEB_SPEC.map((n) => ({ ...n }));
  /** @type {FlightState | null} */
  let flight = null;
  let flightRaf = 0;

  function sizeCanvas() {
    const dpr = Math.min(2, options.devicePixelRatio ?? window.devicePixelRatio ?? 1);
    W = window.innerWidth; H = window.innerHeight; DIAG = Math.hypot(W, H);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return dpr;
  }

  /** @param {Profile} profile */
  function setCamera(profile) {
    VPX = W / 2; VPY = profile.vpY * H;
    A0 = profile.a0 * Math.PI / 180; A1 = profile.a1 * Math.PI / 180;
    RMAX = DIAG * 1.55;
  }
  function starColour() {
    const u = rnd();
    if (u > 0.93) return PACK.accent;
    if (u > 0.82) return PACK.up;
    return u > 0.45 ? PACK.star : PACK.starNear;
  }
  function seedStars() {
    STARS.length = 0;
    const n = Math.round(Math.min(1100, Math.max(520, (W * H) / 1180)));
    for (let i = 0; i < n; i++) {
      STARS.push({
        r: Math.sqrt(rnd()) * RMAX, a: A0 + rnd() * (A1 - A0),
        z: 0.28 + rnd() * 0.72, c: starColour(),
      });
    }
  }
  /* Running the flight backwards, stars shrink toward the vanishing point
     instead of streaming away from it — so a spent star has to be reborn at
     the OUTER edge, or the field empties out on the way down. */
  /** @param {Star} s @param {boolean} rev */
  function respawn(s, rev) {
    s.r = rev ? RMAX * (0.80 + rnd() * 0.20) : 40 + rnd() * 200;
    s.a = A0 + rnd() * (A1 - A0);
    s.z = 0.28 + rnd() * 0.72; s.c = starColour();
  }

  /* ── the props: hairline things in the chart pen that you pass on the way.
       Nothing is opaque; nothing is a texture; it is all drawn with the same
       pen the gravity well is drawn with. ─────────────────────────────────── */
  /** @param {number} r */
  function propScale(r) { return (r / (H * 1.05)); }

  /** @param {HydratedProp} g @param {number} [t] */
  function penConstellation(g, t) {
    const pts = /** @type {number[][]} */ (g.pts);
    ctx.lineWidth = g.hair; ctx.strokeStyle = PACK.pen; ctx.globalAlpha = g.al * 0.95;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    /* the dashed accent leg — POL-5's constellation, drawn in gold */
    ctx.setLineDash([1.5 * g.hair, 6 * g.hair]);
    ctx.strokeStyle = PACK.accent; ctx.globalAlpha = g.al * 0.55;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = g.al;
    for (const p of pts) {
      ctx.fillStyle = PACK.starNear;
      ctx.beginPath(); ctx.arc(p[0], p[1], p[2], 0, 6.284); ctx.fill();
    }
  }
  /** @param {HydratedProp} g @param {number} [t] */
  function penSystem(g, t) {
    /* another household's gravity well, seen in passing — home's minisys */
    ctx.lineWidth = g.hair; ctx.globalAlpha = g.al;
    ctx.strokeStyle = PACK.pen;
    ctx.beginPath(); ctx.arc(0, 0, 78, 0, 6.284); ctx.stroke();
    ctx.strokeStyle = PACK.penLo;
    ctx.beginPath(); ctx.arc(0, 0, 52, 0, 6.284); ctx.stroke();
    ctx.setLineDash([3 * g.hair, 5 * g.hair]);
    ctx.strokeStyle = "#f87171"; ctx.globalAlpha = g.al * 0.45;
    ctx.beginPath(); ctx.arc(0, 0, 30, 0, 6.284); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = g.al;
    ctx.fillStyle = PACK.sun;
    ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, 6.284); ctx.fill();
    for (const b of /** @type {Array<[number, number, string, number]>} */ (g.bodies)) {
      ctx.fillStyle = b[2];
      ctx.beginPath(); ctx.arc(b[0], b[1], b[3], 0, 6.284); ctx.fill();
    }
    ctx.strokeStyle = PACK.penLo; ctx.globalAlpha = g.al * 0.8;
    ctx.beginPath(); ctx.moveTo(78, 0); ctx.lineTo(112, 0); ctx.stroke();
    ctx.fillStyle = PACK.pen; ctx.globalAlpha = g.al * 0.7;
    ctx.fillRect(116, -1.5, 34, 3);
  }
  /** @param {HydratedProp} g @param {number} [t] */
  function penGraticule(g, t) {
    /* the fine graticule linework of the identity, seen edge-on */
    ctx.lineWidth = g.hair; ctx.strokeStyle = PACK.penLo; ctx.globalAlpha = g.al * 0.95;
    for (const r of [230, 300, 372]) {
      ctx.beginPath(); ctx.arc(0, 0, r, -0.95, 0.95); ctx.stroke();
    }
    for (let k = -3; k <= 3; k++) {
      const a = k * 0.28;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 224, Math.sin(a) * 224);
      ctx.lineTo(Math.cos(a) * 380, Math.sin(a) * 380);
      ctx.stroke();
    }
  }
  /** @param {HydratedProp} g @param {number} t */
  function penCraft(g, t) {
    /* a small craft in the chart pen: hull, dish, panel booms, one nav light
       and a thruster that says which way it is going. */
    const hair = g.hair;
    ctx.globalAlpha = g.al;
    ctx.lineJoin = "round";
    ctx.strokeStyle = PACK.penLo; ctx.lineWidth = hair;
    for (const d of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(-4, 13 * d); ctx.lineTo(-4, 44 * d); ctx.stroke();
      const top = d < 0 ? -78 : 44;
      ctx.fillStyle = PACK.hull; ctx.fillRect(-40, top, 74, 34);
      ctx.strokeStyle = PACK.pen; ctx.strokeRect(-40, top, 74, 34);
      ctx.strokeStyle = PACK.penLo;
      for (let i = 1; i < 5; i++) {
        const x = -40 + i * 14.8;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + 34); ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(-40, top + 17); ctx.lineTo(34, top + 17); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-52, -13); ctx.lineTo(30, -13); ctx.lineTo(48, 0);
    ctx.lineTo(30, 13); ctx.lineTo(-52, 13); ctx.closePath();
    ctx.fillStyle = PACK.hull; ctx.fill();
    ctx.strokeStyle = PACK.penHi; ctx.lineWidth = hair * 1.35; ctx.stroke();
    ctx.strokeStyle = PACK.penLo; ctx.lineWidth = hair;
    ctx.beginPath(); ctx.moveTo(-30, -13); ctx.lineTo(-30, 13); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-8, -13); ctx.lineTo(-8, 13); ctx.stroke();
    ctx.strokeStyle = PACK.penHi; ctx.lineWidth = hair * 1.2;
    ctx.beginPath(); ctx.arc(58, 0, 30, -1.2, 1.2); ctx.stroke();
    ctx.lineWidth = hair;
    ctx.beginPath(); ctx.moveTo(48, 0); ctx.lineTo(74, 0); ctx.stroke();
    ctx.beginPath(); ctx.arc(74, 0, 3, 0, 6.284); ctx.stroke();
    const pg = ctx.createLinearGradient(-52, 0, -108, 0);
    pg.addColorStop(0, "rgba(216,180,90,.55)");
    pg.addColorStop(1, "rgba(216,180,90,0)");
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.moveTo(-52, -7); ctx.lineTo(-108, 0); ctx.lineTo(-52, 7); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = g.al * (0.45 + 0.55 * Math.abs(Math.sin(t / 320)));
    ctx.fillStyle = PACK.accent;
    ctx.beginPath(); ctx.arc(20, 0, 3.6, 0, 6.284); ctx.fill();
    ctx.globalAlpha = g.al;
  }
  /** @param {HydratedProp} g @param {number} [t] */
  function penComet(g, t) {
    const grd = ctx.createLinearGradient(0, 0, -260, 0);
    grd.addColorStop(0, "rgba(216,180,90,.85)");
    grd.addColorStop(1, "rgba(216,180,90,0)");
    ctx.globalAlpha = g.al;
    ctx.strokeStyle = grd; ctx.lineWidth = 7 * g.hair; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-300, 0); ctx.stroke();
    ctx.strokeStyle = "rgba(143,184,255,.4)"; ctx.lineWidth = 2.4 * g.hair;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-220, -30); ctx.stroke();
    const hg = ctx.createRadialGradient(0, 0, 0, 0, 0, 26);
    hg.addColorStop(0, "rgba(255,246,230,.95)"); hg.addColorStop(0.35, "rgba(255,233,196,.4)");
    hg.addColorStop(1, "rgba(255,233,196,0)");
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(0, 0, 26, 0, 6.284); ctx.fill();
    ctx.fillStyle = "#fff6e6";
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, 6.284); ctx.fill();
  }
  const PEN = {
    con: penConstellation, sys: penSystem, grat: penGraticule,
    craft: penCraft, comet: penComet,
  };

  /** @param {number} b */
  function drawBloom(b) {
    if (b <= 0) return;
    const by = H * 0.5;
    /* the whole sky takes the colour first, and takes its time about it */
    const halo = ctx.createRadialGradient(W / 2, by, 0, W / 2, by, H * 1.35);
    const hp = Math.pow(b, 0.72);
    halo.addColorStop(0, hexa(PACK.accent, hp * 0.28));
    halo.addColorStop(0.5, hexa(PACK.accent, hp * 0.11));
    halo.addColorStop(1, hexa(PACK.accent, 0));
    ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
    /* then the core: a star lighting, gently */
    const e = Math.pow(b, 1.45), peak = Math.pow(b, 1.18);
    const rad = H * 0.035 + e * H * 0.62;
    const g = ctx.createRadialGradient(W / 2, by, 0, W / 2, by, rad);
    g.addColorStop(0, hexa(PACK.sunCore, Math.min(1, peak * 1.12)));
    g.addColorStop(0.11, hexa(PACK.sunCore, Math.min(1, peak * 1.02)));
    g.addColorStop(0.24, hexa(PACK.sun, peak * 0.88));
    g.addColorStop(0.44, hexa(PACK.accent, peak * 0.46));
    g.addColorStop(0.70, hexa(PACK.accent, peak * 0.15));
    g.addColorStop(1, hexa(PACK.accent, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    /* two hairline shockwaves, and no more than two */
    ctx.lineWidth = 1.3;
    for (const [off, mul] of [[0, 0.48], [0.26, 0.22]]) {
      const q = Math.max(0, b - off);
      ctx.strokeStyle = hexa(PACK.sun, Math.pow(1 - q, 1.4) * mul);
      ctx.beginPath(); ctx.arc(W / 2, by, q * H * 0.95, 0, 6.284); ctx.stroke();
    }
  }

  /* ── the world you are leaving / returning to ────────────────────────────
     Geometry matched to family/login.html exactly at atm = 0: the limb's top
     lands on y = 920 of a 1600×1000 slice, radius 3000, sunrise point at
     (800, 920). So the crossfade from the real login DOM into the canvas has
     nothing to give it away. */
  /** @param {number} c @param {Atmosphere} pal @param {number} [alpha] */
  function drawWorld(c, pal, alpha) {
    if (c >= 0.999) return;
    if (alpha === undefined) alpha = 1;
    if (alpha <= 0.002) return;
    const s = Math.max(W / 1600, H / 1000);
    /** @param {number} y */
    const my = (y) => H / 2 + (y - 500) * s;
    const R0 = 3000 * s, top0 = my(920);
    /* the camera holds the world in frame for a beat (it rises), then lets go */
    const topY = top0 - Math.sin(Math.min(c, 1) * Math.PI) * 0.17 * H
                      + Math.pow(c, 2.4) * 1.55 * H;
    if (topY > H + 40 && c > 0.1) return;
    const R = R0 / (1 + Math.pow(c, 1.3) * 6);
    const cx = W / 2, cy = topY + R;
    const fade = Math.max(0, 1 - c / 0.92) * alpha;

    /* The sky warming toward the horizon. It has to keep going PAST the limb —
       the disc curves away, and the sky either side of it is still air. */
    const gEnd = Math.min(H, Math.max(120, topY) + H * 0.26);
    const k = Math.max(0.05, Math.min(1, topY / gEnd));
    const wash = ctx.createLinearGradient(0, 0, 0, gEnd);
    wash.addColorStop(0, "rgba(0,0,0,0)");
    for (const [stop, col, al] of pal.wash) wash.addColorStop(stop * k, hexa(col, al * fade));
    wash.addColorStop(1, hexa(pal.wash[pal.wash.length - 1][1], 0));
    ctx.fillStyle = wash; ctx.fillRect(0, 0, W, gEnd);

    /* the point of first light — dawn only; at dusk the sun is already under */
    if (pal.hasSun) {
      /** @param {number} rad @param {string} col @param {number} al */
      const gr = (rad, col, al) => {
        const g = ctx.createRadialGradient(cx, topY, 0, cx, topY, rad);
        g.addColorStop(0, hexa(col, al * fade)); g.addColorStop(1, hexa(col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, topY, rad, 0, 6.284); ctx.fill();
      };
      gr(520 * s * (1 - c * 0.5), pal.glowWide, 0.30);
      gr(240 * s * (1 - c * 0.5), pal.glowMid, 0.55);
      /* `hasSun` is exactly the atmospheres whose `glowCore` is set (DAWN
         only) -- the two fields are kept apart because only one of them
         changes per pack, but they always agree. */
      gr(90 * s * (1 - c * 0.6), /** @type {string} */ (pal.glowCore), 0.80);
    } else {
      const g = ctx.createRadialGradient(cx, topY + 30 * s, 0, cx, topY + 30 * s, 620 * s * (1 - c * 0.5));
      g.addColorStop(0, hexa(pal.glowMid, 0.34 * fade));
      g.addColorStop(0.55, hexa(pal.glowWide, 0.12 * fade));
      g.addColorStop(1, hexa(pal.glowWide, 0));
      ctx.fillStyle = g; ctx.beginPath();
      ctx.arc(cx, topY + 30 * s, 620 * s * (1 - c * 0.5), 0, 6.284); ctx.fill();
    }

    /* atmospheric scattering hugging the limb, outside in */
    ctx.save();
    ctx.lineCap = "butt";
    for (const [w, col, al] of pal.bands) {
      ctx.strokeStyle = hexa(col, al * fade);
      ctx.lineWidth = w * s * (0.35 + 0.65 * R / R0) + 2;
      ctx.filter = "blur(" + (w > 40 ? 16 : w > 15 ? 8 : 3) + "px)";
      ctx.beginPath(); ctx.arc(cx, cy, R + ctx.lineWidth * 0.35, 0, 6.284); ctx.stroke();
    }
    ctx.filter = "none";
    ctx.restore();

    /* the planet itself: everything below the limb is night */
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = pal.ground;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.284); ctx.fill();
    const rimg = ctx.createLinearGradient(0, topY - 10, 0, topY + 80);
    rimg.addColorStop(0, hexa(pal.rim1, 0.9)); rimg.addColorStop(1, hexa(pal.rim2, 0.5));
    ctx.strokeStyle = rimg; ctx.lineWidth = Math.max(1.4, 2.6 * s);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.284); ctx.stroke();
    ctx.filter = "blur(7px)"; ctx.globalAlpha = 0.55 * alpha;
    ctx.lineWidth = Math.max(3, 6 * s);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.284); ctx.stroke();
    ctx.restore();
  }

  /* ── one frame, at flight time `t` with step `dt` seconds ──────────────── */
  /**
   * @param {number} t
   * @param {number} dt
   */
  function step(t, dt) {
    /* Only ever invoked from frame() (guarded by `if (!flight) return`) or
       from start()'s pinned loop, which runs right after prime() has set it. */
    const active = /** @type {FlightState} */ (flight);
    const P = active.P;
    const tc = Math.min(t, P.dur);
    const v = P.speed(tc);        /* negative on the way down: the flight reversed */
    const av = Math.abs(v);
    const c = P.atm(tc);

    ctx.setTransform(active.dpr, 0, 0, active.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PACK.bg;
    ctx.fillRect(0, 0, W, H);

    for (const n of NEB) {
      n.p += v * dt * 0.085;
      if (n.p > 1.25) n.p -= 1.45;
      else if (n.p < -0.20) n.p += 1.45;   /* dust falls the other way, reversed */
      const r = H * (-0.15 + n.p * 2.5);
      /* prime() has already set every nebula's `rad` before step() ever runs. */
      const nrad = /** @type {number} */ (n.rad);
      const x = VPX + Math.cos(nrad) * r, y = VPY + Math.sin(nrad) * r;
      const rad = H * n.size * (0.35 + n.p * 0.95);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const a = n.al * Math.min(1, n.p / 0.18) * Math.min(1, (1.25 - n.p) / 0.3);
      g.addColorStop(0, hexa(n.col, Math.max(0, a)));
      g.addColorStop(0.55, hexa(n.col, Math.max(0, a * 0.34)));
      g.addColorStop(1, hexa(n.col, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    /* the way ahead: a faint bloom on the vanishing point, brighter the faster
       you go — the only thing on this canvas that says "forward" by itself */
    if (av > 0.05) {
      const g = ctx.createRadialGradient(VPX, VPY, 0, VPX, VPY, DIAG * 1.05);
      g.addColorStop(0, hexa("#7f93c8", 0.16 * av));
      g.addColorStop(0.34, hexa("#3d4f86", 0.07 * av));
      g.addColorStop(1, hexa("#3d4f86", 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    /* stars — additive, so the dense lanes bloom where they cross */
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "lighter";
    for (const st of STARS) {
      st.r *= (1 + v * dt * P.K * st.z);
      if (st.r > RMAX || st.r < 1) { respawn(st, active.rev); continue; }
      const x1 = VPX + Math.cos(st.a) * st.r, y1 = VPY + Math.sin(st.a) * st.r;
      if (x1 < -420 || x1 > W + 420 || y1 < -520 || y1 > H + 520) continue;
      const near = Math.min(1, st.r / RMAX);
      const al = Math.min(1, (0.10 + 0.95 * near) * (0.35 + 0.65 * st.z));
      const r0 = st.r / (1 + v * SHUTTER * P.K * st.z);
      const x0 = VPX + Math.cos(st.a) * r0, y0 = VPY + Math.sin(st.a) * r0;
      const len = Math.hypot(x1 - x0, y1 - y0);
      ctx.globalAlpha = al;
      if (len < 1.6) {
        ctx.fillStyle = st.c;
        ctx.beginPath(); ctx.arc(x1, y1, 0.55 + 1.15 * near * st.z, 0, 6.284); ctx.fill();
      } else {
        ctx.strokeStyle = st.c;
        ctx.lineWidth = 0.55 + 1.9 * near * st.z;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    /* props: relative motion does not stop when the engine does — a prop that
       is still on screen when you brake keeps sailing out of frame. Reversed,
       the same traffic arrives from the frame edge and recedes to the
       vanishing point: p runs 1 → 0 instead of 0 → 1. */
    for (const g of active.props) {
      if (t < g.t0) continue;
      const advance = Math.max(av, 0.50) * (dt * 1000) / g.dur;
      /* prime() has already set every prop's `p` before step() ever runs. */
      g.p = /** @type {number} */ (g.p) + (active.rev ? -advance : advance);
      if (active.rev ? g.p <= 0 : g.p >= 1) continue;
      const r = H * 0.34 + Math.pow(g.p, 1.12) * H * 1.95;
      const x = VPX + Math.cos(/** @type {number} */ (g.rad)) * r, y = VPY + Math.sin(/** @type {number} */ (g.rad)) * r;
      const sc = propScale(r) * g.z * 2.1;
      if (sc <= 0.001) continue;
      g.al = Math.min(1, g.p / 0.14) * Math.min(1, (1 - g.p) / 0.22) * 0.85;
      g.hair = 1.15 / sc;                       /* a true hairline at any size */
      if (x < -600 * sc || x > W + 600 * sc || y < -700 * sc || y > H + 700 * sc) continue;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(/** @type {number} */ (g.rot0) + g.p * g.spin); ctx.scale(sc, sc);
      PEN[g.kind](/** @type {HydratedProp} */ (g), t);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    /* the atmosphere you are leaving, or coming back up into. On the way down
       the dawn you are returning to cools into the dusk you land on. */
    const mix = P.duskMix ? P.duskMix(tc) : 0;
    if (mix < 0.998) drawWorld(c, P.pal, 1 - mix);
    /* `duskMix` and `palTo` are DOWN's own pair -- whenever `mix` clears the
       threshold, `duskMix` exists, and so did the `palTo` it was read off. */
    if (mix > 0.002) drawWorld(c, /** @type {Atmosphere} */ (P.palTo), mix);

    /* THE REVEAL, read forwards on the climb and backwards on the descent —
       so the arrival's slow bloom is also the departure's slow contraction. */
    drawBloom(bloomAt(active.rev ? mirror(tc) : tc));
  }

  /** @param {number} now */
  function frame(now) {
    if (!flight) return;
    const active = flight;
    const t = now - active.start;
    const dt = Math.min(48, now - active.last) / 1000;
    active.last = now;
    step(t, dt);
    if (t < active.P.dur + 400) flightRaf = raf(frame);
    else { flightRaf = 0; flight = null; }
  }

  /** @param {Profile} P */
  function prime(P) {
    rnd = seededRng(FLIGHT_SEED);
    const dpr = sizeCanvas();
    setCamera(P); seedStars();
    for (const g of P.props) {
      g.p = P.rev ? 1 : 0;             /* reversed, the traffic starts at the edge */
      g.rad = g.ang * Math.PI / 180;
      g.rot0 = (g.spin || 0) * -0.5;
      if (g.kind === "con") g.pts = CONS[/** @type {number} */ (g.shape)];
      if (g.kind === "sys") g.bodies = systemBodies(/** @type {number} */ (g.k));
    }
    for (const n of NEB) {
      n.rad = n.ang * Math.PI / 180;
      if (n.p0 === undefined) n.p0 = n.p;
      n.p = n.p0;                      /* every run starts from the same dust */
    }
    flight = { P, rev: !!P.rev, start: clock(), last: clock(), props: P.props, dpr };
  }

  return {
    /**
     * Fly. `at` pins the flight to one beat instead of running it: the
     * simulation is stepped at a fixed 60fps up to that millisecond and the
     * last frame is left on the canvas, which is what makes a fixture
     * screenshot of a moving thing reproducible.
     * @param {Profile} P
     * @param {{ at?: number }} [options]
     */
    start(P, { at } = {}) {
      this.stop();
      prime(P);
      if (typeof at === "number") {
        for (let t = 0; t <= at; t += PINNED_STEP) step(t, PINNED_STEP / 1000);
        flight = null;
        return;
      }
      flightRaf = raf(frame);
    },
    stop() {
      if (flightRaf) cancel(flightRaf);
      flightRaf = 0; flight = null;
    },
    clear() {
      this.stop();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    /* a resize mid-flight re-seeds the field, as the mockup does */
    resize() {
      if (!flight) return;
      const active = flight;
      active.dpr = sizeCanvas();
      setCamera(active.P);
      seedStars();
    },
    get running() { return flight !== null; },
  };
}
