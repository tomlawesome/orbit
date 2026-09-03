/**
 * THE SKY WAVE — three packs' own skies, app-side (§15, the v1.3.0 roster).
 *
 * One module, three engines, one controller:
 *
 *   THE GALACTIC PLANE   after dark's default sky, from
 *                        design/v19/afterdark-plane.html.
 *   THE TERMINATOR       what "dawn" means now, from
 *                        design/v19/dawn-terminator.html (post-visibility-fix).
 *   THE CLOUD SEA        clouds' sky, from design/v19/dawn-cloudsea.html.
 *
 * Each is the sheet's own script, carried across with its constants, its
 * comments and its laws intact, and each is imperative DOM for exactly the
 * reason home.behaviour.js is: rewriting a seeded stream as reactive markup is
 * the translation step that lost the design in #408 arriving by another door.
 *
 * FOUR THINGS THIS FILE ADDS THAT A MOCKUP DOES NOT NEED, and no more:
 *
 * 1. A CONTROLLER. A mockup is locked to one pack; the app has five and the
 *    reader switches between them mid-session. So an engine is stood up only
 *    while its pack is the live one and torn down the moment it is not — which
 *    is also why star chart costs nothing at all: nothing is built, no rAF is
 *    scheduled, and the fidelity gate photographs a screen with no stream in
 *    it. The switch is watched on <html data-theme> rather than wired into the
 *    swatch handler, because a pack can also arrive from localStorage before
 *    paint, from another surface's swatch row, or from a future server
 *    preference.
 *
 * 2. FIXTURE PINNING. The sheets say so in their own build notes: "in the app
 *    the seed rolls fresh per load (backdrops are alive, never the same twice);
 *    under ORBIT_FIXTURES it must be pinned to the workspace id and the drift
 *    clock pinned to zero, or the fidelity gate cannot compare two
 *    screenshots." Both halves are honoured here, and the re-roll chips the
 *    sheets carry in their DEMOS bars are NOT: a re-roll is mockup furniture,
 *    the product's sky simply is what this load rolled.
 *
 * 3. HOOKS INSTEAD OF GLOBALS. The sheets reach for window.pointSky and
 *    window.renderGalaxy because an inline script has nowhere else to look. A
 *    module has no globals, so home.behaviour.js hands this file two
 *    subscriptions — the camera moved, the galaxy re-rendered — and the engines
 *    that care subscribe.
 *
 * 4. TEARDOWN. Everything these engines write lives outside home's own subtree
 *    (fixed layers, <html> classes), and home is a route the reader leaves.
 */

import { seededRng, streamFactory } from "$lib/sky.js";

const NS = "http://www.w3.org/2000/svg";
const svgel = (name, attrs) => {
  const el = document.createElementNS(NS, name);
  for (const key in attrs) el.setAttribute(key, attrs[key]);
  return el;
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

/* #475: mkRng and streamFactory moved to $lib/sky.js, so the relay,
   create and administration backdrops inherit them rather than each
   carrying a copy. Same generator, same constants, same warm-up. */
const mkRng = seededRng;

/* ══════════════════════════════════════════════════════════════════════════
   AFTER DARK — THE GALACTIC PLANE

   Laws honoured (§14/§15):
   · drift-with-field — the plane is sky, so it drifts with the sky and rides
     the same camera on a flight. Being the furthest thing there is, it takes
     the slowest of everything: 1600 units per 620s where the far field takes
     400s, and 0.16 of the galaxy delta where the far field takes 0.30.
     Parallax IS the depth (§14's own words).
   · dial-view constellations stay still — nothing here touches them.
   · never-loop — no tile, and the centreline OSCILLATES about the sky's
     mid-line rather than running on a fixed slope, which is what lets an
     endless stream drift for hours without the band wandering out of frame.
   · reduced motion — no rAF, no drift, the opening window held.
   ══════════════════════════════════════════════════════════════════════════ */
function mountPlane({ seed, still, onCamera }) {
  const cam = document.getElementById("pcam");
  const drift = document.getElementById("pdrift");
  const gGlow = document.getElementById("p-glow");
  const gStar = document.getElementById("p-stars");
  const gDust = document.getElementById("p-dust");
  if (!cam || !drift || !gGlow || !gStar || !gDust) return () => {};

  const streamFor = streamFactory(seed);

  /* ---- 1. THE RIVER: where the plane lies ---------------------------------
     A straight diagonal would be the honest picture of a great circle, and it
     is unusable: slide an infinite sloped line sideways for long enough and it
     leaves the sky, taking the pack's signature with it. So the centreline is
     built from NODES that alternate above and below the sky's mid-line — node k
     sits at 500 ∓ AMP·(0.55…1) — joined by straight runs with rounded corners.
     Three things follow, and all three are wanted: every run is a true diagonal
     (21°–36° at these constants); the band crosses the middle of the frame once
     every NODE units, so it is always THERE, at every offset, forever; and the
     picture keeps changing without a single repeat.

     Node y is a pure function of (seed, k), so the line can be evaluated at any
     x without walking the stream from the beginning — which is what makes the
     windowed discipline possible at all. */
  const NODE = 1450, AMP = 520, ROUND = 340, MID = 500;
  const L_LINE = 7;
  const nodeMemo = new Map();
  function nodeY(k) {
    if (nodeMemo.has(k)) return nodeMemo.get(k);
    const r = streamFor(L_LINE, k);
    const y = MID + ((k & 1) ? 1 : -1) * AMP * (0.55 + r() * 0.45);
    nodeMemo.set(k, y);
    return y;
  }
  /* segment j's straight line, evaluated anywhere (extrapolated a little way
     past its own node so the corners have something to blend) */
  const seg = (j, x) => {
    const y0 = nodeY(j), y1 = nodeY(j + 1);
    return y0 + (y1 - y0) * (x - j * NODE) / NODE;
  };
  function centreY(x) {
    const k = Math.floor(x / NODE), d = x - k * NODE;
    if (d < ROUND) {
      const w = smoothstep((d + ROUND) / (2 * ROUND));
      return seg(k - 1, x) * (1 - w) + seg(k, x) * w;
    }
    if (d > NODE - ROUND) {
      const w = smoothstep((d - (NODE - ROUND)) / (2 * ROUND));
      return seg(k, x) * (1 - w) + seg(k + 1, x) * w;
    }
    return seg(k, x);
  }
  /* the local slope, read off the line itself rather than off a constant —
     every lobe and every dust lane is laid along it, which is what makes the
     band bend as one piece instead of shearing at the corners */
  const degAt = (x) => Math.atan((centreY(x + 8) - centreY(x - 8)) / 16) * 180 / Math.PI;

  /* ---- the brightness budget, spelled out where it is spent ---------------
     MEASURED, then set. With the population hidden the brightest 11×11 median
     of the whole backdrop is L = .0115; with the GLOW hidden instead it is
     .00213 — the bare pack ground, exactly. That is the finding the whole
     balance rests on: STARS COST THE GROUND NOTHING, because a point source is
     not the background of a letterform and an 11×11 median ignores it. So every
     bit of presence this band can afford is bought in grain and only the last of
     it in haze — which is also the truer picture of the thing. The full budget,
     re-measured against #490's lifted ink family, is in home.css. */
  const CORE_A = 0.0320, MID_A = 0.0180, HALO_A = 0.0086;

  /* ---- the chunk: one 400-unit slice of river ---------------------------- */
  const CW = 400, AHEAD = 560, BEHIND = 470;
  const live = new Map();
  function build(i) {
    const r = streamFor(0, i), x0 = i * CW;
    const mk = () => svgel("g", { transform: `translate(${x0},0)` });
    const gg = mk(), gs = mk(), gd = mk();

    /* 2. THE DUST GLOW, in three sizes. The first attempt used a handful of very
       large lobes and the honest read of it was: a smooth ramp, which is a
       gradient stripe by another name. The fix is SCALE — the same total light
       spent across three octaves of lobe, so the wash is mottled at every
       distance you look at it from: wings you see from across the room, clumps
       you see at arm's length, knots you only see when you lean in. Rolled
       largest first so the warm core always lands on top of the cool wings. */
    const lobe = (n, opts) => {
      for (let k = 0; k < n; k++) {
        const u = r() * CW, X = x0 + u, cy = centreY(X) + (r() * 2 - 1) * opts.off;
        gg.appendChild(svgel("ellipse", {
          cx: u.toFixed(1), cy: cy.toFixed(1),
          rx: (opts.rx0 + r() * opts.rxd).toFixed(0),
          ry: (opts.ry0 + r() * opts.ryd).toFixed(0),
          transform: `rotate(${(degAt(X) + (r() * opts.tilt * 2 - opts.tilt)).toFixed(1)} ${u.toFixed(1)} ${cy.toFixed(1)})`,
          fill: opts.paint, opacity: (opts.a * (0.5 + r() * 0.9)).toFixed(4),
        }));
      }
    };
    /* the wings: the diffuse light either side of the plane, cool because the
       near dust has reddened out of it */
    lobe(3, { rx0: 210, rxd: 200, ry0: 135, ryd: 100, off: 126, tilt: 5,
              paint: "url(#pl-cool)", a: HALO_A });
    /* the body: the river as you see it at a glance */
    lobe(5, { rx0: 120, rxd: 150, ry0: 42, ryd: 48, off: 72, tilt: 9,
              paint: "url(#pl-warm)", a: MID_A });
    /* the knots: star clouds. Small, warm, uneven, and deliberately more of them
       than the body has — this is what stops the core being one smooth ridge of
       light down the middle, which is the single thing that gives a painted band
       away. */
    lobe(9, { rx0: 48, rxd: 96, ry0: 16, ryd: 26, off: 46, tilt: 16,
              paint: "url(#pl-warm)", a: CORE_A });

    /* 3a. THE GRAIN — the unresolved majority. Sub-pixel, barely there, packed
       tight to the line: individually invisible, together they are the granular
       texture that distinguishes a galaxy from a wash. This tier is why the band
       survives being looked at closely. */
    for (let k = 0; k < 380; k++) {
      const u = r() * CW, X = x0 + u;
      const v = 175 * (r() + r() + r() - 1.5) / 1.5;
      const warm = r() < 0.40;
      const c = svgel("circle", {
        cx: u.toFixed(1), cy: (centreY(X) + v).toFixed(1),
        r: (0.28 + r() * 0.20).toFixed(2),
        opacity: (0.09 + Math.pow(r(), 1.4) * 0.21).toFixed(3),
      });
      if (warm) c.setAttribute("fill", "var(--plane-star-warm)");
      gs.appendChild(c);
    }
    /* 3b. THE FIELD — the ones you can actually pick out, thinning outward into
       a wide sparse halo so the band has no edge you could draw. */
    for (let k = 0; k < 280; k++) {
      const u = r() * CW, X = x0 + u;
      const core = r() < 0.74;
      const v = core ? 210 * (r() + r() + r() - 1.5) / 1.5 : 470 * (r() + r() - 1);
      const out = Math.min(1, Math.abs(v) / 470);
      const warm = core && r() < 0.34;
      const c = svgel("circle", {
        cx: u.toFixed(1), cy: (centreY(X) + v).toFixed(1),
        /* a floor of .38 is not decoration: below about a third of a pixel the
           antialiaser hands back a grey smudge and the grain is lost, which is
           precisely how the first pass ended up looking like a gradient. Tiny,
           yes — invisible, no. */
        r: (0.38 + r() * r() * 0.78).toFixed(2),
        opacity: ((0.18 + Math.pow(r(), 1.25) * 0.56) * (1 - 0.35 * out)).toFixed(3),
      });
      if (warm) c.setAttribute("fill", "var(--plane-star-warm)");
      gs.appendChild(c);
    }
    /* the handful that resolve. Without these the river is a haze; with them it
       has grain, and grain is what says "stars" at a glance. */
    for (let k = 0; k < 14; k++) {
      const u = r() * CW, X = x0 + u;
      gs.appendChild(svgel("circle", {
        cx: u.toFixed(1),
        cy: (centreY(X) + 150 * (r() + r() + r() - 1.5) / 1.5).toFixed(1),
        r: (0.85 + r() * 0.75).toFixed(2), opacity: (0.5 + r() * 0.36).toFixed(2),
      }));
    }

    /* 4. THE DUST LANES. Chains of very flat dark ellipses threading the core at
       a few degrees to it — real lanes are never quite parallel to the plane.
       Painted OVER the population, because dust in front of a star field absorbs
       it; and because they are only a shade under the pack's ground, where they
       stray off the glow they are all but nothing, which is exactly how they
       behave in the sky. */
    for (let n = 0; n < 2; n++) {
      if (r() > 0.72) continue;
      const beads = 2 + Math.floor(r() * 3);
      const v0 = (r() * 2 - 1) * 52, u0 = r() * CW, tilt = r() * 9 - 4.5;
      for (let b = 0; b < beads; b++) {
        const u = u0 + b * (78 + r() * 96), X = x0 + u;
        const cy = centreY(X) + v0 + (r() * 2 - 1) * 15;
        gd.appendChild(svgel("ellipse", {
          cx: u.toFixed(1), cy: cy.toFixed(1),
          rx: (78 + r() * 150).toFixed(0), ry: (8 + r() * 15).toFixed(0),
          transform: `rotate(${(degAt(X) + tilt).toFixed(1)} ${u.toFixed(1)} ${cy.toFixed(1)})`,
          fill: "url(#pl-dust)", opacity: (0.30 + r() * 0.34).toFixed(2),
        }));
      }
    }
    return { gg, gs, gd };
  }

  /* ---- chunks in, chunks gone --------------------------------------------
     Three parent groups rather than one per chunk, so the paint order is all the
     glow, then all the stars, then all the lanes. Lobes are wider than a chunk
     and deliberately overhang it; interleaving them per chunk would draw a seam
     every 400 units. */
  function fill(offset) {
    const first = Math.floor((offset - BEHIND) / CW);
    const last = Math.floor((offset + 1600 + AHEAD) / CW);
    for (let i = first; i <= last; i++) {
      if (live.has(i)) continue;
      const c = build(i);
      live.set(i, c);
      gGlow.appendChild(c.gg); gStar.appendChild(c.gs); gDust.appendChild(c.gd);
    }
    for (const [i, c] of live) {
      if (i < first || i > last) {
        c.gg.remove(); c.gs.remove(); c.gd.remove();
        live.delete(i); /* gone for good */
      }
    }
  }

  /* ---- the camera: the plane is the furthest thing in the sky -------------
     home points the two star layers at 0.30 and 0.65 of the galaxy delta. The
     galaxy behind them takes 0.16 — read off the far layer's own RENDERED
     transform rather than recomputed, so a flight can never leave the plane
     pointing somewhere the sky is not. */
  const PARALLAX = 0.16 / 0.30;
  function planeCam() {
    const t = document.getElementById("cam-far")?.style.transform ?? "";
    const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(t);
    cam.style.transform = m
      ? `translate(${(+m[1] * PARALLAX).toFixed(1)}px, ${(+m[2] * PARALLAX).toFixed(1)}px)`
      : "translate(0px, 0px)";
  }
  const offCamera = onCamera(planeCam);

  /* ---- the drift: slowest thing on the screen ---------------------------- */
  const SPEED = 1600 / 620; /* the far field does 1600 / 400 */
  let t0 = performance.now(), frame = null;
  const offsetAt = (now) => (still() ? 0 : ((now - t0) / 1000) * SPEED);
  function render(off) {
    fill(off);
    drift.setAttribute("transform", `translate(${(-off).toFixed(1)},0)`);
    planeCam();
  }
  /* THE PLANE DOES NOT NEED A FRAME CLOCK. It moves 2.58 units a second — at
     60Hz that is four hundredths of a pixel per frame, and paying a full repaint
     of six thousand circles for four hundredths of a pixel is how a backdrop
     makes a page stutter. Stepping it at ~10Hz moves it a quarter of a pixel at
     a time, well under anything an eye can resolve as a step, and hands five
     frames in six back to the rest of the screen. The base starfield keeps its
     own CSS drift at full rate; this is the far layer being far. */
  const MOVE_MS = 96;
  let lastMove = -1e9;
  function step(now) {
    if (now - lastMove >= MOVE_MS) { lastMove = now; render(offsetAt(now)); }
    frame = requestAnimationFrame(step);
  }

  render(0);
  if (!still()) frame = requestAnimationFrame(step);

  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    offCamera();
    for (const [, c] of live) { c.gg.remove(); c.gs.remove(); c.gd.remove(); }
    live.clear(); nodeMemo.clear();
    cam.style.transform = "";
    drift.removeAttribute("transform");
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   DAWN — THE TERMINATOR

   Laws honoured (§14/§15):
   · drift-with-field — the night stars are sky, so they ride the same two drift
     speeds and the same camera offset as the ratified starfield.
   · never-loop — no tile; chunk n of a layer is a pure function of (seed, layer,
     n), rolled just before it is revealed and thrown away for good.
   · overlays static — the crossing is LIGHT, not an object in the field, so it
     is anchored to the window. It creeps, monotonically, because dawn does; it
     never returns, so it never loops either.
   · reduced motion — everything above stops; the crossing freezes where the
     seed put it and the stream holds its opening window.
   ══════════════════════════════════════════════════════════════════════════ */
function mountTerminator({ seed, still, onCamera, onGalaxy }) {
  const night = document.getElementById("night");
  const sky = document.getElementById("nightsky");
  const limb = document.getElementById("tline");
  if (!night || !sky || !limb) return () => {};

  const streamFor = streamFactory(seed);

  /* ---- the crossing: rolled per load, bounded so it can never hide --------
     THE ANCHORING (owner, §15 — "the crossing must be seen"). The crossing used
     to be seated in SCREEN PIXELS out from the dial's month ring. That protects
     the chart, but it ties the size of the night to the INSTRUMENT instead of to
     the WINDOW: the same 300-odd pixels that leave a proper night on a 27" desk
     leave a corner sliver on a 14" laptop and nothing at all on a phone. It is
     now seated as a DIAGONAL OF THE FRAME. Two numbers describe it, both
     fractions of the viewport, never pixels:
        LE   where the crossing meets the LEFT edge, as a fraction of height
        TE   where it meets the TOP edge, as a fraction of width
     The night is the triangle those two cut off, so its share of the first
     viewport is exactly LE·TE/2 — the same picture at 390×844 as at 2560×1440.
     That identity is the whole fix: the signature is a fraction of the sky, not
     a measurement off the dial.

     What the seed rolls is that SHARE (inside a bounded band) and the TILT —
     WHERE the crossing sits in the band, never WHETHER it is there.

     The chart is still protected, but by a GUARD rather than by the seat: the
     dial's own rendered circle must stay out of the genuinely dark part of the
     wash. Where it does not, the answers are taken in this order, and the last
     one is the only one that costs sky:
        1. the HANDOVER WIDENS (the dial sits inside the crossing — which is what
           the crossing was always for),
        2. the crossing is pushed back, but never past the FLOOR share,
        3. the handover widens the rest of the way, so a viewport too small for
           both still reads as a crossing rather than as a dark chart. */
  const SHARE_LO = 0.20, SHARE_HI = 0.26; /* the rolled band: a fifth to a quarter */
  const TILT_LO = 0.68, TILT_HI = 0.92;   /* LE/TE — where in the band it sits */
  const FLOOR = 0.185;  /* no guard push and no creep may take it below this */
  const KDARK = 0.42;   /* where along the fall the wash reads as real night */
  /* the guarded radius, in the dial's own 380-unit viewBox: the month ring is at
     150 and its labels at 162, so 172 clears everything legible on it */
  const GUARD_VB = 172 / 380;
  let SHARE = 0.245, TILT = 0.75;
  (function rollCrossing() {
    const r = mkRng(seed); r(); r(); r();
    SHARE = SHARE_LO + r() * (SHARE_HI - SHARE_LO);
    TILT = TILT_LO + r() * (TILT_HI - TILT_LO);
  })();
  /* dawn advances: the night retreats, monotonically, about 2.8% of its own
     depth a minute — proportional, like everything else here, so it is the same
     retreat on a phone as on a desk. Capped at the floor: the night may thin, it
     may never leave. Nothing comes back, so nothing loops. */
  const CREEP = 0.028 / 60000;
  let t0 = performance.now();
  const creep = () => (still() ? 0 : (performance.now() - t0) * CREEP);

  /* ---- painting the three layers -----------------------------------------
     The crossing is not a fade from light to dark — the sky is BRIGHTEST at the
     terminator (that is where the light is arriving) and falls away behind it. So
     the ramp reads, along the axis: the pack's own day, a warm limb band, then a
     short steep fall into real night. Compressing the handover like this is what
     keeps a legible screen, because almost nothing ever sits in the muddy
     middle — there is barely any middle. ONE stop table drives the wash, the
     star mask and the constellations' material, so the three can never drift
     apart. Everything is measured along the crossing's own normal, in units of
     the FALL, so one table describes the same picture at every viewport. */
  const NIGHT = [[-0.14, 0], [0.16, 0.18], [0.42, 0.50], [0.78, 0.74], [1.20, 0.87], [3.2, 0.93]];
  const LIMB = [[-1.95, 0], [-1.10, 0.08], [-0.52, 0.22], [-0.16, 0.12], [0.17, 0]];
  const NIGHT_RGB = "7,12,29", LIMB_RGB = "255,206,145";

  /* the dial as it is actually drawn — not as a constant. During the arrival the
     element is mid-scale and during a flight it is gone, so the nominal 640 is
     the floor and any larger drawn size (storm leans the camera in) wins: the
     guard is never smaller than the chart it protects. */
  function guard() {
    const el = document.querySelector(".dial");
    const b = el && el.getBoundingClientRect();
    if (!b || !b.width) return { x: innerWidth / 2, y: innerHeight / 2, r: 640 * GUARD_VB };
    return { x: b.left + b.width / 2, y: b.top + b.height / 2,
             r: Math.max(parseFloat(el.getAttribute("width")) || 640, b.width) * GUARD_VB };
  }
  /* how far the crossing can be pushed back before the night reaches FLOOR: the
     share is ½·LE·TE and a push of p takes a fixed bite out of each leg, so the
     limit is one quadratic, solved rather than searched */
  function pushCap(LE, TE, a, b) {
    const A = a * b, B = LE * b + TE * a, C = LE * TE - 2 * FLOOR;
    if (C <= 0) return 0;
    const disc = B * B - 4 * A * C;
    if (disc <= 0 || A <= 0) return 0;
    return Math.max(0, (B - Math.sqrt(disc)) / (2 * A));
  }
  let FR = null;
  function frame() {
    const W = innerWidth, H = innerHeight;
    const LE = Math.sqrt(2 * SHARE * TILT), TE = Math.sqrt(2 * SHARE / TILT);
    /* the crossing runs from (0, LE·H) to (TE·W, 0); its normal points into the
       night, which is up and to the left, as it always has */
    const ax = LE * H, ay = TE * W, N = Math.hypot(ax, ay) || 1;
    const nx = -ax / N, ny = -ay / N;
    const depth = ax * (ay / N); /* the deepest the night gets: the corner */
    const L = W * -nx + H * -ny; /* the CSS gradient line's own length */
    const CEN = (W / 2) * nx + (H / 2 - ax) * ny;
    const ANG = (Math.atan2(nx, -ny) * 180 / Math.PI + 360) % 360;

    /* the guard, and the three answers to it, in order */
    const g = guard();
    const need = g.r + (g.x * nx + (g.y - ax) * ny);
    let fall = Math.min(Math.max(0.26 * depth, 78), 240);
    if (KDARK * fall < need) fall = Math.min(need / KDARK, 0.70 * depth);
    const cap = pushCap(LE, TE, 1 / (H * -ny), 1 / (W * -nx));
    const push = Math.min(Math.max(0, need - KDARK * fall), cap);
    if (KDARK * fall < need - push) fall = Math.min((need - push) / KDARK, 2.2 * depth);
    /* the creep spends whatever the guard left of the floor, and no more */
    const off = Math.min(push + creep() * depth, cap);

    return (FR = { W, H, LE, TE, nx, ny, ax, depth, L, CEN, ANG, fall, off });
  }

  function paint() {
    const f = frame();
    const at = (t) => (50 + (f.off + t * f.fall - f.CEN) / f.L * 100).toFixed(2) + "%";
    const ramp = (list, rgb) => list.map(([t, a]) => ` rgba(${rgb},${a}) ${at(t)}`).join(",");
    const A = f.ANG.toFixed(2);
    night.style.backgroundImage = `linear-gradient(${A}deg,${ramp(NIGHT, NIGHT_RGB)})`;
    /* the stars come back exactly where the light stops */
    const m = `linear-gradient(${A}deg, transparent ${at(-0.05)},` +
              ` rgba(0,0,0,.5) ${at(0.74)}, #000 ${at(1.7)})`;
    sky.style.webkitMaskImage = m; sky.style.maskImage = m;
    /* the limb: the air the light reaches first. It sits on the DAY side of the
       fall, which is why the chart never has to be legible against mud — where
       the crossing passes over the instrument, it passes over it as LIGHT. This
       is the brightest thing in the sky after the sun. */
    limb.style.backgroundImage = `linear-gradient(${A}deg,${ramp(LIMB, LIMB_RGB)})`;
  }

  /* the wash's own alpha, read off the same table it is painted from, so the
     material a mark is drawn in can never disagree with the ground */
  function readTable(list, d) {
    if (d <= list[0][0]) return list[0][1];
    for (let i = 1; i < list.length; i++) {
      if (d <= list[i][0]) {
        const t = (d - list[i - 1][0]) / (list[i][0] - list[i - 1][0]);
        return list[i - 1][1] + t * (list[i][1] - list[i - 1][1]);
      }
    }
    return list[list.length - 1][1];
  }
  function alphaAt(px, py) {
    const f = FR || frame();
    const d = (px * f.nx + (py - f.ax) * f.ny - f.off) / f.fall;
    /* the limb LIGHTENS the ground it crosses, and it crosses the near edge of
       the night. Netting it off is what stops a mark being redrawn in starlight
       while the sky behind it is still bright. …and once you have dropped below
       the sky there is no night left to be deep in, so the marks come back to ink
       as the crossing lifts away. */
    return Math.max(0, (readTable(NIGHT, d) - 1.15 * readTable(LIMB, d)) * (1 - DESC));
  }

  /* ---- the constellations that lie in the night --------------------------
     They are functional here (flyable, law-positioned) so they do not move —
     §14's one exception, the dial view. What changes is the MATERIAL they are
     drawn in: a mark on the far side of the crossing is not ink on a lit sky, it
     is starlight, so its tokens are mixed toward the starlight set by exactly
     how deep into the night it sits. Legibility goes UP, never down: this is the
     only way a mark in the dark stays readable. */
  const mix = (day, nightc, k) =>
    `color-mix(in srgb, ${nightc} ${(k * 100).toFixed(1)}%, ${day})`;
  function tintGalaxy() {
    for (const m of document.querySelectorAll(".minisys")) {
      const r = m.getBoundingClientRect();
      if (!r.width) continue;
      /* sampled AT THE LABEL, not at the ring: the name sits above the ring
         centre and can be a whole stop deeper into the night than it is. The
         legibility-critical part of the mark is the part that gets to decide
         what the mark is drawn in. */
      const alpha = alphaAt(r.left + r.width / 2, r.top + r.height * 0.12);
      /* the switch to starlight waits until the ground is genuinely dark: going
         pale early is what bleaches a mark out over a half-lit sky */
      const d = clamp01((alpha - 0.40) / 0.28), k = smoothstep(d);
      /* legibility floor: a mark caught IN the handover has neither a light
         ground nor a dark one, so the limb light catches its edges. Peaks in the
         crossover and is gone at both ends — the only place it exists is the only
         place it is needed. */
      const halo = clamp01(1 - Math.abs(alpha - 0.26) / 0.34);
      if (m.dataset.dim === undefined) m.dataset.dim = m.style.opacity || "1";
      m.style.opacity =
        Math.min(1, parseFloat(m.dataset.dim) * (1 + 0.34 * k + 0.28 * halo)).toFixed(3);
      m.style.filter = halo > 0.02
        ? `drop-shadow(0 0 2px rgba(255,246,228,${(halo * 0.78).toFixed(2)}))` +
          ` drop-shadow(0 0 7px rgba(255,236,205,${(halo * 0.62).toFixed(2)}))`
        : "";
      /* BOTH halves of the accent, because #491 split it: the label is drawn in
         --accent-text and the leader in --accent, and a mark half in starlight
         and half in day ink would be the exact disagreement the crossing's own
         law forbids. The day value differs per token; the night value does not,
         because on a dark ground there is nothing left to protect against. */
      m.style.setProperty("--accent", mix("#1f7ac2", "#cfe4ff", k));
      m.style.setProperty("--accent-text", mix("#134a72", "#cfe4ff", k));
      m.style.setProperty("--ink", mix("#18202f", "#f2f6ff", k));
      m.style.setProperty("--chart-line", mix("#a6b2c5", "#9fb2d1", k));
      m.style.setProperty("--chart-ink", mix("#40506e", "#cddaef", k));
      m.style.setProperty("--warm", mix("#c06a12", "#f5bd7c", k));
      m.style.setProperty("--ok", mix("#178a4c", "#7fd8a4", k));
      m.style.setProperty("--upcoming", mix("#1f7ac2", "#a8cbf2", k));
    }
  }
  /* and what the tint has to hand back. The mockup never needed this — leaving
     it destroys the document — but here a pack switch leaves the same nodes on
     screen under a different sky, so every property written above is removed
     rather than left to be inherited into a pack that has no night in it. */
  function untintGalaxy() {
    for (const m of document.querySelectorAll(".minisys")) {
      if (m.dataset.dim !== undefined) { m.style.opacity = m.dataset.dim; delete m.dataset.dim; }
      m.style.filter = "";
      for (const p of ["--accent", "--accent-text", "--ink", "--chart-line", "--chart-ink", "--warm", "--ok", "--upcoming"])
        m.style.removeProperty(p);
    }
  }

  /* ---- the night starfield: chunks in, chunks gone ---------------------- */
  const LAYERS = [
    { key: 0, id: "t-far", w: 800, speed: 1600 / 400, n: 52, r0: 0.45, r1: 1.10, o0: 0.30, o1: 0.70 },
    { key: 1, id: "t-near", w: 800, speed: 1600 / 195, n: 20, r0: 0.85, r1: 2.00, o0: 0.62, o1: 1.00 },
  ];
  const AHEAD = 700, BEHIND = 300;
  for (const L of LAYERS) { L.node = document.getElementById(L.id); L.live = new Map(); }

  function fill(L, offset) {
    const first = Math.floor((offset - BEHIND) / L.w);
    const last = Math.floor((offset + 1600 + AHEAD) / L.w);
    for (let i = first; i <= last; i++) {
      if (L.live.has(i)) continue;
      const r = streamFor(L.key, i);
      const g = svgel("g", { transform: `translate(${i * L.w},0)` });
      for (let k = 0; k < L.n; k++) {
        g.appendChild(svgel("circle", {
          cx: (r() * L.w).toFixed(1), cy: (r() * 1000).toFixed(1),
          r: (L.r0 + r() * (L.r1 - L.r0)).toFixed(2),
          opacity: (L.o0 + r() * (L.o1 - L.o0)).toFixed(2),
        }));
      }
      L.live.set(i, g); L.node.appendChild(g);
    }
    for (const [i, g] of L.live)
      if (i < first || i > last) { g.remove(); L.live.delete(i); } /* gone for good */
  }

  /* ---- the descent: scroll is altitude -----------------------------------
     DESC is read from the same --descent home.behaviour.js publishes, so the
     tint and the CSS lift can never disagree about how far the sky has gone. */
  let DESC = 0;
  const readDesc = () => {
    DESC = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--descent")) || 0;
  };

  /* ---- the frame: drift, camera, creep ---------------------------------- */
  let raf = null, lastSlow = 0;
  function step(now) {
    const t = (now - t0) / 1000;
    for (const L of LAYERS) {
      const off = still() ? 0 : t * L.speed;
      fill(L, off);
      L.node.setAttribute("transform", `translate(${(-off).toFixed(1)},0)`);
    }
    /* the creep is far too slow to need a frame: half a second is plenty */
    if (now - lastSlow > 500) { lastSlow = now; readDesc(); paint(); tintGalaxy(); }
    raf = requestAnimationFrame(step);
  }

  const onResize = () => { readDesc(); paint(); tintGalaxy(); };
  const onScroll = () => { readDesc(); tintGalaxy(); };
  const offCamera = onCamera(() => {
    /* the night field rides the same camera as the ratified one, so a flight
       moves both fields together and the crossing keeps its stars */
    const far = document.getElementById("cam-far"), near = document.getElementById("cam-near");
    const tf = document.getElementById("tcam-far"), tn = document.getElementById("tcam-near");
    if (far && tf) tf.style.transform = far.style.transform;
    if (near && tn) tn.style.transform = near.style.transform;
  });
  /* renderGalaxy is home's; subscribing keeps the night's material correct after
     a flight or a resize without touching the original */
  const offGalaxy = onGalaxy(tintGalaxy);

  for (const L of LAYERS) fill(L, 0);
  readDesc(); paint(); tintGalaxy();
  addEventListener("resize", onResize);
  addEventListener("scroll", onScroll, { passive: true });
  if (!still()) raf = requestAnimationFrame(step);

  return () => {
    if (raf !== null) cancelAnimationFrame(raf);
    removeEventListener("resize", onResize);
    removeEventListener("scroll", onScroll);
    offCamera(); offGalaxy(); untintGalaxy();
    for (const L of LAYERS) { L.node.textContent = ""; L.live.clear(); L.node.removeAttribute("transform"); }
    night.style.backgroundImage = "";
    limb.style.backgroundImage = "";
    sky.style.webkitMaskImage = ""; sky.style.maskImage = "";
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CLOUDS — THE CLOUD SEA

   Laws honoured (§14/§15):
   · drift-with-field — the cloud is sky, so it drifts; the near strata are
     nearer, so they drift faster than the far one (parallax), and all of them
     are slower than the starfield above, which is further away still.
   · never-loop — the profile of the sea is value noise ADDRESSED BY WORLD
     POSITION: the height of the cloud at world x is a pure function of (seed,
     stratum, x). Nothing is tiled and nothing repeats; a stretch of sea is
     rolled just before it is revealed on one side and dropped for good once it
     has left on the other. The peaks ride a chunk cycle for the same reason,
     one to a chunk so two can never crowd.
   · overlays static — chart marks, cards and their furniture do not move with
     any of this; the dial is in FRONT of the weather, not in it.
   · reduced motion — the bank freezes exactly where the seed put it.
   ══════════════════════════════════════════════════════════════════════════ */
function mountCloudSea({ seed, still }) {
  const streamFor = streamFactory(seed);

  /* A stratum is a run of billows over a solid deck. Both are rolled a chunk of
     world at a time, so a stretch of sea can be rolled the moment before it is
     revealed and dropped for good once it has passed. The deck is a plain
     rectangle from the stratum's shoulder to well below the window — the billows
     are only its top edge, and the softness filter merges them into one mass
     rather than a row of bubbles.

     shoulder: where the deck begins. Every stratum sits well below the dial's
     outer arc, so the instrument is never IN the weather. */
  const STRATA = [
    { key: 0, host: "cs-s0", w: 580, speed: 1600 / 760, n: 5,
      shoulder: 726, rx: [96, 190], ry: [26, 54], lift: 20 },
    { key: 1, host: "cs-s1", w: 520, speed: 1600 / 470, n: 6,
      shoulder: 812, rx: [84, 172], ry: [30, 62], lift: 24 },
    { key: 2, host: "cs-s2", w: 470, speed: 1600 / 270, n: 6,
      shoulder: 900, rx: [72, 152], ry: [34, 70], lift: 28 },
  ];
  const AHEAD = 620, BEHIND = 320;
  for (const L of STRATA) { L.node = document.getElementById(L.host); L.live = new Map(); }
  const peakHost = document.getElementById("cs-peaks");
  if (!peakHost || STRATA.some((L) => !L.node)) return () => {};

  function buildStratum(L, g, r) {
    /* the deck: solid, seamless across the chunk join. It runs to 2200 rather
       than to the window's own bottom because a cloud layer has THICKNESS, and
       on the way through it a shorter deck's bottom edge would swing up into the
       window as a ruled line. Below the first screen either way, so nothing at
       rest moves by a pixel. */
    g.appendChild(svgel("rect", { x: -1, y: L.shoulder + 6, width: L.w + 2, height: 2200 - L.shoulder }));
    for (let k = 0; k < L.n; k++) {
      const slot = L.w / L.n;
      g.appendChild(svgel("ellipse", {
        cx: ((k + 0.5) * slot + (r() - 0.5) * slot * 0.95).toFixed(1),
        cy: (L.shoulder + (r() * 2 - 1) * L.lift).toFixed(1),
        rx: (L.rx[0] + r() * (L.rx[1] - L.rx[0])).toFixed(1),
        ry: (L.ry[0] + r() * (L.ry[1] - L.ry[0])).toFixed(1),
      }));
    }
  }
  function fillStratum(L, off) {
    const first = Math.floor((off - BEHIND) / L.w), last = Math.floor((off + 1600 + AHEAD) / L.w);
    for (let i = first; i <= last; i++) {
      if (L.live.has(i)) continue;
      const g = svgel("g", { transform: `translate(${i * L.w},0)` });
      buildStratum(L, g, streamFor(L.key, i));
      L.live.set(i, g); L.node.appendChild(g);
    }
    for (const [i, g] of L.live)
      if (i < first || i > last) { g.remove(); L.live.delete(i); } /* gone for good */
  }

  /* ---- the peaks ---------------------------------------------------------
     Distant, so: small, hazy, cool, and standing only a little way out of the
     cloud. One per chunk at most and the chunk is wide, so you get one or two on
     screen and never a range. The warm edge is the sunward one — it is the only
     warm thing up here that is not cloud. */
  const PEAKS = { key: 9, w: 1900, speed: 1600 / 620, live: new Map() };
  const FOOT = 880; /* buried in the near strata */
  function buildPeak(g, r) {
    if (r() > 0.80) return; /* most of the sea has nothing in it */
    /* tall enough to clear the far bank by a hundred pixels or so, wide enough —
       and hazy enough — to still read as distance rather than as a thing near
       you. Anything shorter simply disappears into the cloud. */
    const x = 120 + r() * 1660;
    const h = 158 + r() * 94;
    const half = Math.min(330, h * (1.05 + r() * 0.75)); /* a mountain, not a shard */
    const apex = FOOT - h;
    const sx = x + half * ((r() * 2 - 1) * 0.26); /* which way the summit tips */
    /* a ridge, not a triangle: four seeded steps a side, on a concave slope
       (t^1.4) — the profile a hill actually has. Both x and y are jittered, so no
       two summits share a silhouette. */
    const flank = (dir) => {
      const out = [];
      for (let i = 1; i <= 4; i++) {
        const t = i / 5;
        out.push([x + dir * half * (1 - t) + (r() - 0.5) * half * 0.12,
                  FOOT - h * Math.pow(t, 1.4) * (0.84 + r() * 0.30)]);
      }
      return out;
    };
    const pt = (p) => p[0].toFixed(1) + " " + p[1].toFixed(1);
    const left = flank(-1), right = flank(1).reverse();
    const body = "M " + pt([x - half, FOOT]) + " L " + left.map(pt).join(" L ") +
                 " L " + pt([sx, apex]) + " L " + right.map(pt).join(" L ") +
                 " L " + pt([x + half, FOOT]) + " Z";
    g.appendChild(svgel("path", { d: body, fill: "url(#cs-rock)",
                                  opacity: (0.42 + r() * 0.16).toFixed(2),
                                  filter: "url(#cs-peak)" }));
    /* the rim: the sunward flank only. The one warm edge up here that is not
       cloud, and the only reason a distant peak reads as rock rather than as a
       hole in the sky. It fades into the same air the rock does. */
    g.appendChild(svgel("path", {
      d: "M " + pt([sx, apex]) + " L " + right.map(pt).join(" L "),
      fill: "none", stroke: "url(#cs-rim)", "stroke-width": 1.8,
      "stroke-linejoin": "round", "stroke-linecap": "round",
      filter: "url(#cs-peak)" }));
  }
  function fillPeaks(off) {
    const P = PEAKS;
    const first = Math.floor((off - 400) / P.w), last = Math.floor((off + 2000) / P.w);
    for (let i = first; i <= last; i++) {
      if (P.live.has(i)) continue;
      const g = svgel("g", { transform: `translate(${i * P.w},0)` });
      buildPeak(g, streamFor(P.key, i));
      P.live.set(i, g); peakHost.appendChild(g);
    }
    for (const [i, g] of P.live)
      if (i < first || i > last) { g.remove(); P.live.delete(i); } /* gone for good */
  }

  /* ---- the drift -------------------------------------------------------- */
  let t0 = performance.now(), raf = null;
  function render(t) {
    for (const L of STRATA) {
      const off = still() ? 0 : t * L.speed;
      fillStratum(L, off);
      L.node.setAttribute("transform", `translate(${(-off).toFixed(1)},0)`);
    }
    const poff = still() ? 0 : t * PEAKS.speed;
    fillPeaks(poff);
    peakHost.setAttribute("transform", `translate(${(-poff).toFixed(1)},0)`);
  }
  function step(now) { render((now - t0) / 1000); raf = requestAnimationFrame(step); }

  render(0);
  if (!still()) raf = requestAnimationFrame(step);

  return () => {
    if (raf !== null) cancelAnimationFrame(raf);
    for (const L of STRATA) { L.node.textContent = ""; L.live.clear(); L.node.removeAttribute("transform"); }
    peakHost.textContent = ""; PEAKS.live.clear(); peakHost.removeAttribute("transform");
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   THE CONTROLLER
   ══════════════════════════════════════════════════════════════════════════ */

const ENGINES = {
  afterdark: mountPlane,
  dawn: mountTerminator,
  clouds: mountCloudSea,
};

/**
 * Stand the right sky up for whatever pack is live, and keep doing so.
 *
 * @param {object}   options
 * @param {?number}  options.seed      pin the sky, or null to roll one per load
 * @param {boolean}  options.pinClock  hold every stream at t=0 (the gate)
 * @param {function} options.onCamera  subscribe to "the camera moved"
 * @param {function} options.onGalaxy  subscribe to "the galaxy re-rendered"
 * @returns {function} teardown
 */
export function mountSkies({ seed: pinnedSeed = null, pinClock = false, onCamera, onGalaxy }) {
  const doc = document.documentElement;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  /*
   * TWO PINS, NOT ONE, because a mockup and a gate want different things and
   * conflating them costs one of them its point:
   *
   *   THE SEED can be pinned on its own — a sheet must draw the same sky every
   *   reload or it cannot be screenshotted, measured or put in front of anybody,
   *   and it should still MOVE, because motion is half of what is being judged.
   *   In the product it rolls fresh: backdrops are alive, never the same twice.
   *
   *   THE CLOCK is pinned only for the fidelity gate, which has to photograph
   *   the same frame twice. `still()` is what every engine asks instead of
   *   reading the media query directly, so a pinned clock beats a machine's
   *   motion preference either way and CI and a laptop take the same picture.
   */
  const still = () => pinClock || motion.matches;
  const seed = pinnedSeed ?? Math.floor(Math.random() * 2147483646) + 1;

  let current = null, teardown = null;

  function sync() {
    const pack = doc.dataset.theme || "starchart";
    if (pack === current) return;
    teardown?.();
    teardown = null;
    current = pack;
    const engine = ENGINES[pack];
    /* star chart and retrograde have no stream: nothing is built, nothing is
       scheduled, and their skies are exactly what they were before this file
       existed. */
    if (engine) teardown = engine({ seed, still, onCamera, onGalaxy });
  }

  /* A pack can arrive from a swatch on this screen, from a swatch on another
     one, from localStorage before paint, or one day from the session — so the
     attribute is watched rather than the handler wrapped. */
  const observer = new MutationObserver(sync);
  observer.observe(doc, { attributes: true, attributeFilter: ["data-theme"] });
  const onMotion = () => { const was = current; current = null; if (was) sync(); };
  motion.addEventListener("change", onMotion);
  sync();

  return () => {
    observer.disconnect();
    motion.removeEventListener("change", onMotion);
    teardown?.();
    teardown = null;
    current = null;
  };
}
