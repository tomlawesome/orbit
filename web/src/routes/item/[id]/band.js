/**
 * THE BELT'S GEOMETRY AND ORDER (#458) — the pure half of the item screen.
 *
 * Every number, law and comment below is the sealed mockup's own
 * (design/v19/item-belt.html, ratified 2026-08-16). This module is that
 * engine's arithmetic with the drawing taken out: a ring seen at an angle, the
 * date law that seats the manifest along it, the jumble, the berth, the
 * ambient bed's seeded population, and the search. Nothing here touches the
 * DOM, reads a clock or calls Math.random, so the whole of it is unit-tested
 * (tests/unit/v19-belt.test.mjs) rather than discovered in a browser — the
 * placement.js precedent, which is why home's sky can be proved at all.
 *
 * The painter that consumes it is belt.behaviour.js; the screen is
 * +page.svelte. The data it eats comes from $lib/data/belt.js.
 *
 * ==================================================================== *
 * THE GEOMETRY — a ring seen at an angle, not a rainbow.
 *
 * The belt is a circle of radius A lying in its own plane. Two rotations
 * put it on screen:
 *   INC   40°  inclination — how far the ring plane is tipped away from us.
 *              This is what turns the circle into a shallow ellipse
 *              (minor/major = cos 40° = .766) and what makes the arc across
 *              the sky a sweep rather than a bow.
 *   NODE −12°  the node roll — the ring's line of nodes is not level with
 *              the horizon. This is the asymmetry: it drops the left flank
 *              and lifts the right, so the two halves of the visible band
 *              fall by different amounts (~300px left, ~240px right at
 *              1600×1000) and foreshorten differently.
 *
 * The apex — the highest point of the projected ellipse, found analytically,
 * not assumed — is then translated to the horizontal centre of the viewport
 * at 35% of its height. Everything else follows from that one pin.
 *
 * Ring angle phi runs anticlockwise; on screen INCREASING PHI MOVES LEFT.
 * Since the manifest runs sooner-left to later-right, a body's angular
 * offset along the belt DECREASES phi: offset 0 is the first item due.
 * ==================================================================== */
export const RAD = Math.PI / 180;
export const INC = 40 * RAD;
export const NODE = -12 * RAD;
export const COS_I = Math.cos(INC), SIN_I = Math.sin(INC);
const COS_N = Math.cos(NODE), SIN_N = Math.sin(NODE);
export const A_FRAC = 0.74, A_MIN = 1150;   /* ring radius against the viewport */
export const APEX_FRAC = 0.35;              /* where the apex hangs in the sky   */
export const R_ITEM = 25;                   /* an item's radius                  */
export const R_DOC = 17;                    /* a document's — smaller, on purpose */
export const RADIAL = 0.19;                 /* the band's radial half-spread     */
export const HFRAC = 0.066;                 /* its out-of-plane half-thickness   */
export const SWEEP = 74;                    /* the neighbourhood an item clears  */
export const SWEEP_DOC = 52;                /* a document's smaller clearing     */
export const DRIFT = 0.0125;                /* rad/s along the ring, leftward    */
export const GLIDE = 420;                   /* the roll, unchanged from v1/v2    */

/* ---- the spacing law -------------------------------------------------
   Position along the band is the item's DATE. Consecutive items are set
   apart by an angle that grows with the gap between their due dates, from a
   floor (below which two labels would touch) to a ceiling (beyond which a
   five-month wait would push the next item off the world). The growth is
   e-folded at 45 days: a fortnight apart reads noticeably tighter than a
   season apart, but the whole manifest still fits on one ring. */
export const MIN_GAP = 11.5 * RAD;
export const MAX_GAP = 17.5 * RAD;
export const GAP_EFOLD = 45;                /* days, the gap law's scale         */
/* A document's seat is cut out of the space BETWEEN its item and the next
   one along — 6° of ring, well inside the floor — so putting documents in
   the band can never reorder the manifest or change what "next" means. */
export const DOC_OFF = 6.0 * RAD;

/* ---- the card's berth ------------------------------------------------
   The centred body is not a rock, it is a ~400px card, so it has swept a
   wider clearing than its neighbours: angles are pushed away from the apex
   by a smooth ODD function, which stretches the seats flanking the card and
   leaves everything further out merely shifted. warp(0) === 0 exactly, so
   the centred body still lands on the apex pin to the pixel, and because
   warp is smooth and monotonic the roll never jumps and the date order can
   never be disturbed.

   The berth WIDENS when the centred item has papers, because the papers have
   to sit in it: the neighbours stand off from ~295px to ~480px, and the
   documents take the ground they leave, at ~285px — clear of the card's edge
   on one side and of the neighbour's label on the other. It widens across
   the roll itself, so opening an item is a visible act: the belt makes room
   and the papers come out. */
export const BERTH_NARROW = 0.075, BERTH_WIDE = 0.28, BERTH_K = 0.16;
export const warpOf = (berth) => (u) => u + berth * Math.tanh(u / BERTH_K);

/* ---- the jumble ------------------------------------------------------
   "They don't form an orderly, linear line, they're jumbled around a
   little" (owner). Each body carries a seeded throw: off the ring radius,
   out of the ring plane, and a little along the band. The along-band throw
   is a tenth of the minimum gap, which cannot reorder anything and cannot
   close two labels to touching; the other two scatter the bodies through the
   band's thickness. All three ease to zero at the apex. */
export const J_PHI = 0.10;                  /* × the minimum gap                 */
export const J_RHO = 0.100;                 /* × A, off the ring radius          */
export const J_H = 0.038;                   /* × A, out of the ring plane        */
export const J_FADE = 0.62;                 /* × the min gap: the settling zone  */

/* The screen window's own overhang, either side, in radians of ring: a body
   is alive a little past the edge so nothing is seen to pop. */
export const BAND_MARGIN = 0.16;

/** The ambient bed's seed, and the members' two silhouette/jumble seeds. */
export const AMBIENT_SEED = 19170812;
export const ROCK_SEED = 7717, ROCK_STEP = 913;
export const DOC_SEED = 4231, DOC_ITEM_STEP = 617, DOC_STEP = 149;
export const JUMBLE_SEED = 1013, JUMBLE_STEP = 7919;

/* A Lehmer stream. Two of them in the screen: one fixed seed for the members'
   silhouettes and their jumble (so a rock is the same rock, in the same
   place, every load — fixture truth), and one that runs for the ambient band,
   never rewound between respawns, which is exactly why the band can never
   repeat itself. */
export const lehmer = (s) => () => (s = (s * 48271) % 2147483647) / 2147483647;
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ==================================================================== *
 * The projection and the one pin.
 * ==================================================================== */

/** The ring's own projection, given a centre offset. */
function projectAt(cx, cy, phi, rho, hh) {
  const s = Math.sin(phi), c = Math.cos(phi);
  const u = rho * c;                          /* along the node line       */
  const v = rho * s * COS_I + hh * SIN_I;     /* screen-up, foreshortened  */
  const d = -rho * s * SIN_I + hh * COS_I;    /* toward the viewer         */
  return { x: cx + u * COS_N - v * SIN_N, y: cy - (u * SIN_N + v * COS_N), d };
}

/* x(phi) falls monotonically across the visible arc, so a walk-and-refine
   is exact enough and cannot be tripped by the ellipse's turning points. */
function phiAtX(geom, targetX, dir) {
  let phi = geom.PHI_APEX, step = 0.02 * dir, last = geom.project(phi, geom.A, 0).x;
  for (let i = 0; i < 400; i++) {
    const next = phi + step, x = geom.project(next, geom.A, 0).x;
    if ((dir < 0 && x >= targetX) || (dir > 0 && x <= targetX)) {
      const t = (targetX - last) / (x - last);
      return phi + step * Math.max(0, Math.min(1, t));
    }
    if ((dir < 0 && x < last) || (dir > 0 && x > last)) return phi; /* turned */
    phi = next; last = x;
  }
  return phi;
}

/**
 * Everything the sky's size decides: the ring radius, the apex pin, the arc
 * the screen can see, how far the band falls either side of the apex, and the
 * squeeze the date law takes on a narrow viewport.
 */
export function geometryOf(width, height) {
  const W = width, H = height;
  const A = Math.max(A_MIN, W * A_FRAC);
  const APEX_Y = Math.round(H * APEX_FRAC);
  /* d/dphi of the projected height, solved: the true apex of the tilted
     ellipse, which is NOT the top of the untilted one. */
  let PHI_APEX = Math.atan2(COS_I * COS_N, SIN_N);
  if (PHI_APEX < 0) PHI_APEX += Math.PI * 2;
  const p = projectAt(0, 0, PHI_APEX, A, 0);
  const CX = W / 2 - p.x, CY = APEX_Y - p.y;

  const geom = {
    W, H, A, APEX_Y, CX, CY, PHI_APEX,
    PHI_L: 0, PHI_R: 0, DIP_L: 0, DIP_R: 0, GAP_SCALE: 1,
    project: (phi, rho, hh) => projectAt(CX, CY, phi, rho, hh),
  };
  geom.PHI_R = phiAtX(geom, W + 200, -1);
  geom.PHI_L = phiAtX(geom, -200, +1);
  /* The gaps are real angles of ring, but a narrow sky cannot hold two of
     them either side of the apex once the card's widest berth is added: on
     one, the belt sits its items closer together rather than rolling them
     off the world. The date law survives the squeeze — every gap scales
     together, so clusters stay clusters. */
  const wide = warpOf(BERTH_WIDE);
  for (let k = 0; k < 24; k++) {
    const one = wide(MIN_GAP * geom.GAP_SCALE);
    if (geom.project(PHI_APEX - one, A, 0).x <= W - 86 &&
        geom.project(PHI_APEX + one, A, 0).x >= 86) break;
    geom.GAP_SCALE -= 0.04;
    if (geom.GAP_SCALE < 0.55) { geom.GAP_SCALE = 0.55; break; }
  }
  /* How far the band falls 300px either side of the apex: the card slides
     ALONG the band when it leaves, so it has to know the dip. */
  geom.DIP_L = geom.project(phiAtX(geom, W / 2 - 300, +1), A, 0).y - APEX_Y;
  geom.DIP_R = geom.project(phiAtX(geom, W / 2 + 300, -1), A, 0).y - APEX_Y;
  return geom;
}

/**
 * The card's own width: it is a body in the belt, so it has to fit BETWEEN
 * its neighbours — the berth its own bulk has cleared, less a clear margin
 * for the next body along. Measured at the NARROW berth and the tightest
 * possible gap, so the card is the same card whatever is centred; it must not
 * breathe every time an item happens to carry paper.
 */
export function cardWidthOf(geom) {
  const narrow = warpOf(BERTH_NARROW);
  const gap = Math.abs(
    geom.project(geom.PHI_APEX - narrow(MIN_GAP * geom.GAP_SCALE), geom.A, 0).x - geom.W / 2,
  );
  return Math.max(340, Math.min(480, 2 * (gap - 104), geom.W - 56));
}

/* ==================================================================== *
 * THE ORDER OF THE BELT — the whole point of v4.
 *
 * `bodies` is the flat seat list, sorted by `off` — the angular distance
 * along the band from the first item due. Item offsets are a running sum of
 * gaps, each gap a function of the days between two consecutive due dates:
 *
 *   · the sequence is the manifest's own linear order, exactly;
 *   · a cluster in the calendar is a cluster in the band;
 *   · nothing ever falls below MIN_GAP, so no two labels can touch.
 *
 * Document seats hang off their item at ±DOC_OFF, inside that gap. They
 * exist always but are only SHOWN when their item is the centred one:
 * `bloom` per item, 0 to 1. So the manifest's spacing is never disturbed by a
 * document, and no rebuild ever happens mid-roll — opening an item is an
 * opacity and a widening berth, not a relayout.
 *
 * The belt rolls by `roll`; seat i sits at PHI_APEX − warp(off[i] − roll).
 * ==================================================================== */

/** The date law: one running sum of gaps, in the manifest's own order. */
export function itemOffsetsOf(manifest, gapScale) {
  const offsets = [];
  let acc = 0;
  manifest.forEach((row, i) => {
    if (i) {
      const gapDays = row.days - manifest[i - 1].days;
      const t = 1 - Math.exp(-Math.max(0, gapDays) / GAP_EFOLD);
      acc += (MIN_GAP + (MAX_GAP - MIN_GAP) * t) * gapScale;
    }
    offsets.push(acc);
  });
  return offsets;
}

/** v2's split: half the papers sit before the item, half after. Never wider
 *  than two-thirds of the tightest item gap, so they stay in the berth. */
export function docSpread(n, gapScale) {
  const cut = Math.ceil(n / 2), out = [];
  for (let j = 0; j < n; j++) {
    const side = j < cut ? -1 : 1;
    const rank = j < cut ? cut - j : j - cut + 1;
    out.push(side * Math.min(rank * DOC_OFF, MIN_GAP * gapScale * 0.66));
  }
  return out;
}

/* A caption in the band is an identifier, not the record: a long filename is
   elided in the middle so its extension survives, because ".pdf" is half of
   what tells you what the thing is. The card carries the whole name. */
export function shortName(s) {
  return s.length <= 21 ? s : s.slice(0, 11) + "…" + s.slice(-8);
}

const BAND_VAR = {
  over: "var(--overdue)", soon: "var(--warm)",
  up: "var(--upcoming)", ok: "var(--ok)",
};

/**
 * The flat seat list: every item in date order, each item's documents seated
 * in the space between it and its neighbour, all of them thrown their seeded
 * jumble. `manifest` is $lib/data/belt.js's shape.
 */
export function bodiesOf(manifest, gapScale) {
  const bodies = [];
  const itemOff = itemOffsetsOf(manifest, gapScale);

  manifest.forEach((row, i) => {
    const docs = row.docs ?? [];
    bodies.push({
      kind: "item", id: row.id, item: row, itemIdx: i, off: itemOff[i],
      label: row.title, sub: `${row.t} · ${row.when}`,
      tone: BAND_VAR[row.urg] ?? BAND_VAR.ok, urg: row.urg, days: row.days,
      r: R_ITEM, sweep: SWEEP, seed: ROCK_SEED + i * ROCK_STEP,
      t: row.t, when: row.when, longWhen: row.longWhen,
      docs,
    });
    docSpread(docs.length, gapScale).forEach((d, j) => {
      bodies.push({
        kind: "doc", id: docs[j].id, doc: docs[j], item: row, itemIdx: i,
        off: itemOff[i] + d,
        label: shortName(docs[j].name), sub: docs[j].size,
        tone: "var(--paper)", r: R_DOC, sweep: SWEEP_DOC,
        seed: DOC_SEED + i * DOC_ITEM_STEP + j * DOC_STEP,
        docs: [],
      });
    });
  });
  bodies.sort((a, b) => a.off - b.off);

  bodies.forEach((b, i) => {
    const j = lehmer(JUMBLE_SEED + i * JUMBLE_STEP);   /* this body's own jumble */
    const soft = b.kind === "doc" ? 0.55 : 1;          /* papers ride tighter in */
    /* The throw, in units: along-band, radial, out-of-plane. Flat, not
       peaked — a peaked throw leaves most of the bodies sitting on the very
       line it was supposed to break them off, which is the whole complaint. */
    b.jp = (j() * 2 - 1) * J_PHI * soft;
    b.jr = (j() * 2 - 1) * J_RHO * soft;
    b.jh = (j() * 2 - 1) * J_H * soft;
  });
  return bodies;
}

/**
 * Where a body actually is at this instant: its seat, plus its jumble, with
 * the jumble eased to nothing as it comes into the apex so the card seats on
 * the pin exactly.
 */
export function seatOf(bodies, i, { roll, berth, geom }) {
  const b = bodies[i];
  const u = b.off - roll;
  const phi0 = geom.PHI_APEX - warpOf(berth)(u);
  const f = clamp01(Math.abs(phi0 - geom.PHI_APEX) / (MIN_GAP * geom.GAP_SCALE * J_FADE));
  const s = f * f * (3 - 2 * f);               /* smoothstep; 0 at the apex */
  return {
    phi: phi0 + b.jp * MIN_GAP * geom.GAP_SCALE * s,
    rho: geom.A * (1 + b.jr * s),
    h: geom.A * b.jh * s,
  };
}

/** An item's papers are out when that item is centred, or when one of its own
 *  papers is. Nothing else opens them. */
export function bloomTargetsOf(bodies, sel, itemCount) {
  const t = new Array(itemCount).fill(0);
  const s = bodies[sel];
  if (s && (s.item?.docs ?? []).length) t[s.itemIdx] = 1;
  return t;
}
export const berthFor = (bodies, sel, itemCount) =>
  bloomTargetsOf(bodies, sel, itemCount).some((v) => v) ? BERTH_WIDE : BERTH_NARROW;

/* ==================================================================== *
 * The ambient band's population — v2's, unchanged.
 *
 * Bodies are scattered in three dimensions of the ring, not along a line:
 *   phi   where round the belt
 *   rho   A · (1 ± .19), triangular — dense at the ring radius, frayed out
 *   h     ±.066·A out of the ring plane, triangular
 * and each carries its own size, tone and silhouette. Sizes are cubed so
 * the population is overwhelmingly dust with a scattering of real rubble:
 * that ratio, not the count, is what makes a belt look like a belt.
 *
 * Drift: leftward along the ring for ever. Inner bodies run faster than
 * outer ones (Keplerian shear, softened to a ±15% spread so the band shears
 * rather than smears), and near bodies faster than far ones. A body that
 * leaves the left edge does not come back: it is REBUILT from the running
 * stream at the far end with fresh radius, height, size and shape. The
 * band you are shown one minute is not the band you were shown before.
 *
 * WHERE IT IS SOWN. The bed is sown across THE WHOLE ARC THE CAMERA CAN EVER
 * REACH: the screen window, plus the roll span the seats themselves produce
 * (sooner-most seat to later-most seat, measured off the built manifest, not
 * guessed at), so every roll looks out on ground that was already sown.
 *
 * A body is held in BAND COORDINATES — where it sits when the belt is rolled
 * to its sooner end — because that is the one frame the roll cannot move.
 * Its own arc is [PHI_R − M − REACH·rate, PHI_L + M]: a fast body has to
 * start further out to still be in the sky at the later end, and because
 * every rate class is sown uniformly across its own arc, the density the
 * screen sees is the same at every roll.
 *
 * These are inert decor and nothing else. They are also the reason a
 * household with three items still has a belt (owner, confirmed): the real
 * members stand proud of an ambient bed that is always there.
 * ==================================================================== */

/** The roll's reach, off the seats: base is the sooner-most seat, reach the
 *  angle from there to the later-most, documents included, since a paper can
 *  be centred too. */
export function rollRangeOf(bodies) {
  if (!bodies.length) return { base: 0, reach: 0 };
  let lo = bodies[0].off, hi = bodies[0].off;
  for (const b of bodies) { if (b.off < lo) lo = b.off; if (b.off > hi) hi = b.off; }
  return { base: lo, reach: hi - lo };
}

/**
 * u is where along this body's OWN sown arc it lands, 0 at the far end the
 * band feeds from and 1 at the edge it retires over. Respawn passes 0.
 */
export function spawnInto(rk, u, { rng, geom, base, reach, drift }) {
  const r = rng;
  /* A belt has a core and a fray, not an even slab: radius and height come
     off a peaked distribution, and one body in seven is a stray thrown well
     outside it. That is what stops the population reading as a rectangle of
     confetti and lets the sweep of the ring still be seen through it. */
  const stray = r() < 0.14 ? 1.75 : 1;
  rk.rho = geom.A * (1 + ((r() + r() + r() - 1.5) / 1.5) * RADIAL * stray);
  rk.h = geom.A * ((r() + r() + r() - 1.5) / 1.5) * HFRAC * stray;
  const g = r();
  rk.size = 0.42 + g * g * g * 7.6;
  rk.tone = r() < 0.17 ? 1 : 0;               /* 1 = accent-lit, 0 = ink   */
  rk.alpha = (0.2 + r() * 0.55) / (stray > 1 ? 1.5 : 1);
  rk.rate = Math.pow(geom.A / rk.rho, 0.9) * (0.94 + (rk.h / (geom.A * HFRAC)) * 0.12);
  rk.poly = null;
  if (rk.size > 2.3) {                        /* big enough to have a shape */
    const n = 7, pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.5;
      const rr = 0.72 + r() * 0.5;
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.9]);
    }
    rk.poly = pts;
  }
  /* Sown across the arc THIS body can ever be seen on, then stored as the
     ring angle it was BORN at, so the running drift and the belt's roll both
     apply to it at its own rate for the rest of its life. */
  const lo = geom.PHI_R - BAND_MARGIN - reach * rk.rate;
  const hi = geom.PHI_L + BAND_MARGIN;
  rk.phi = lo + u * (hi - lo) - (drift + base) * rk.rate;
  return rk;
}

/**
 * The whole bed. Density per arc-length is the constant, not the count: the
 * sky's own window keeps exactly the population it had, and the ground the
 * roll adds is sown at the same rate.
 */
export function bedOf({ rng, geom, bodies, base, reach, drift = 0 }) {
  const win = geom.PHI_L - geom.PHI_R + BAND_MARGIN * 2;
  const n = Math.round(((bodies.length ? 2100 : 880) / win) * (win + reach));
  const bed = [];
  for (let i = 0; i < n; i++) bed.push(spawnInto({}, rng(), { rng, geom, base, reach, drift }));
  return bed;
}

/* ==================================================================== *
 * THE SEARCH BOX.
 *
 * It matches title, section, kind, provider and document name, because all
 * five are things a person types when they are looking for one thing in a
 * household. A document's name lights ITS ITEM, because the item is how you
 * get to the paper — and lights the paper too, if it is already out.
 *
 * What it does NOT do is remove anything: the band keeps its shape and its
 * order, matches stay lit and everything else falls back to a quarter of its
 * weight, so you can see where in time your hit lives before you go to it.
 * ==================================================================== */
export function haystackOf(b) {
  return (b.kind === "doc"
    ? [b.doc.name, b.item.title, "document"]
    : [b.label, b.item.section, b.item.kind, b.item.provider ?? "",
       ...b.docs.map((d) => d.name)]).join(" ").toLowerCase();
}

export function matchesOf(bodies, query) {
  const q = query.trim().toLowerCase();
  const found = new Set();
  if (q) bodies.forEach((b, i) => { if (haystackOf(b).includes(q)) found.add(i); });
  return found;
}

/* A paper still folded inside its item is not somewhere you can be sent —
   its item is. */
export const reachableAt = (bodies, i, bloom) => {
  const b = bodies[i];
  return b.kind !== "doc" || (bloom[b.itemIdx] ?? 0) > 0.5;
};

/** The nearest hit is the nearest ALONG THE BELT, not the first in the list:
 *  you are standing somewhere in time and the belt should turn the shortest
 *  way it can to the thing you asked for. */
export function nearestMatchOf(bodies, matches, selected, bloom) {
  let best = -1, bestD = Infinity;
  for (const i of matches) {
    if (i === selected || !reachableAt(bodies, i, bloom)) continue;
    const d = Math.abs(bodies[i].off - bodies[selected].off);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** ← and → step through the belt in date order, which is its whole grammar —
 *  over the papers too, when they are out. */
export function stepFrom(bodies, selected, bloom, d) {
  const order = bodies.map((_, i) => i).filter((i) => reachableAt(bodies, i, bloom));
  const at = order.indexOf(selected);
  return order[at + d] ?? -1;
}

/* The roll's easing, solved rather than approximated: v2's curve exactly. */
export const bez = (p1x, p1y, p2x, p2y) => (t) => {
  let lo = 0, hi = 1, u = t;
  const bx = (v) => 3 * (1 - v) * (1 - v) * v * p1x + 3 * (1 - v) * v * v * p2x + v * v * v;
  for (let i = 0; i < 22; i++) { const x = bx(u); if (x < t) lo = u; else hi = u; u = (lo + hi) / 2; }
  return 3 * (1 - u) * (1 - u) * u * p1y + 3 * (1 - u) * u * u * p2y + u * u * u;
};
export const ease = bez(0.32, 0.72, 0.26, 1);
