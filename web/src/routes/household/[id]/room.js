/**
 * THE ROOM (#410, §15 H2 — "inside this system").
 *
 * design/v19/household-inside.html is this backdrop's spec: the household's
 * own constellation, at room scale, behind the ratified management cards. Its
 * own report names the one piece it could not answer, and that piece is this
 * module. The mockup HAND-PLACED where you stand — `sun: [690, 340], scale:
 * 4.95` for Lawson Home, `sun: [1034, 448], scale: 4.6` for Seaside Cottage —
 * two authored compositions for two fixture households, with a comment saying
 * what they were chosen for:
 *
 *     "The centre is a composition: chosen so every one of this system's
 *      entries is in the room with you, so the band sweeps both margins, and
 *      so no body's halo lies under the page header — that header is the one
 *      run of small type on this screen with no panel beneath it, so it gets
 *      clear sky."
 *
 * A real instance has arbitrary households: one entry, none, forty, all of
 * them overdue in a knot around the sun. So the composition has to be SOLVED
 * rather than authored, and this is the solution — a pure function of the
 * household's own marks (placed by the dial law in chart.js, never a fork of
 * it) and the viewport, memoised, with the placement.js precedent's discipline:
 * no randomness, no clock, no DOM, no dependence on the order the API returned
 * the items in.
 *
 * ── THE LAW, IN ORDER OF AUTHORITY ────────────────────────────────────────
 *
 *   1. THE ROOM IS A ROOM — A GUARANTEE. The year band (r=150, which the dial
 *      law makes exactly +1 year) must always leave the frame, so the giant
 *      figure sweeping the desk can only ever be an ARC. A ring drawn whole,
 *      inside the frame, is a logo; a household is not a logo. This is bought
 *      with a scale FLOOR, below which no other rule may push: at
 *      SCALE_MIN the band's radius exceeds half the frame's short side, so
 *      wherever the sun stands inside the frame at least one edge is nearer
 *      than the band and the band must cross it. Nothing below can violate
 *      this, because nothing below changes the scale after the floor is
 *      applied.
 *   2. THE UNPROTECTED TYPE IS SACRED — A LAW. The page header (its ring and
 *      its two lines) is the one run of small type on this screen with no
 *      panel beneath it; the back link and the account orb are the others.
 *      No star's halo and no whisper label may be drawn on them. Everything
 *      else — the cards — is glass with a backdrop-filter over it and is
 *      exactly what the figure is meant to compose behind, so the cards are
 *      NOT protected here (labels avoid them for a different reason: see
 *      berthsOf).
 *   3. THE COMPOSITION IS A DESIRE. Fitting every one of the household's
 *      entries into the room, centred behind the two card columns, is what
 *      YIELDS when the first two cannot both be had. A household whose
 *      entries span three years simply cannot have all of them in the room at
 *      a scale that keeps the band an arc — and that is the concept rather
 *      than a shortfall of it: "You cannot see all of your own system at once."
 *
 * ── WHAT THE RULE DOES ────────────────────────────────────────────────────
 *
 *   FIT. The household's marks (their halos included, because a halo is what
 *   is actually seen) have a bounding box in dial units. The scale is the
 *   largest that fits that box into the frame inset by FIT_MARGIN, clamped
 *   between the floor above and a ceiling that keeps the band inside the
 *   frame's own corners. Measured against the two authored compositions this
 *   lands within 4% of Lawson Home's hand-chosen 4.95 and reproduces the thing
 *   the mockup's comment claims — Seaside Cottage's entries are spread over
 *   ten months instead of six, so its room is drawn smaller — without being
 *   told.
 *
 *   CENTRE. The sun is placed so the mark cloud's centre lands at the centre
 *   of the frame. No authored bias: the cards are the middle of the screen, so
 *   centring the cloud IS composing behind the columns, and a bias nobody can
 *   derive is a number the next household would have to argue with.
 *
 *   CLEAR. Then the header. For one mark and one protected rect, the set of
 *   sun positions that would put that mark's halo on that rect is the rect
 *   grown by the halo's radius and moved back along the mark's own offset — an
 *   axis-aligned rectangle, exactly. The forbidden region for the sun is the
 *   union of those rectangles over every mark (and the sun's own soft field,
 *   which is a mark at the origin). So the question "where may the sun stand?"
 *   is answered exactly rather than searched: the candidate positions are the
 *   ideal one and every rectangle's four just-outside edges, crossed; the
 *   nearest candidate to the ideal that is clear of all of them wins. Ties are
 *   broken by distance, then by coordinate, so the answer cannot depend on the
 *   order anything was visited in.
 *
 *   YIELD. If no candidate is clear, the scale steps down (a household can be
 *   crowded enough that every sun position puts something on the header) and
 *   the search runs again. If even at the floor nothing is clear, the rule
 *   keeps the candidate that puts the LEAST on the header and says so
 *   (`crowded: true`) — it never buys clearance by breaking rule 1, and it
 *   never silently drops a star, because the stars ARE the entries (§12).
 */

import { dialPlacement } from "$lib/data/chart.js";

/** The sky's own field: every mockup in the family draws in 1600×1000. */
export const FIELD = { width: 1600, height: 1000 };

/*
 * The dial's rings, RECOVERED FROM THE LAW rather than re-declared, so the
 * room cannot drift from the chart it claims to be:
 *
 *   r=62  — "overdue, inside the ring", which is dialPlacement(0).radius;
 *   r=150 — +1 YEAR, which is dialPlacement(364).radius = 150.088, the number
 *           the mockup's comment works out by hand (62 + 0.242·364).
 *
 * The band's hairline rim, its ticks and where the month names sit are the
 * mockup's own offsets from that ring, kept as offsets for the same reason.
 */
export const OVERDUE_RING = dialPlacement(0).radius;
export const YEAR_RING = dialPlacement(364).radius;
const BAND_RIM = YEAR_RING + 18;
const BAND_TICK = YEAR_RING - 7;
const MONTH_TEXT = YEAR_RING + 10;
/** The sun's soft field, in dial units — the mockup's `px(16)`. */
const SUN_FIELD = 16;

/** How much frame is left around the mark cloud when the fit is what binds. */
const FIT_MARGIN = 90;

/**
 * The scale floor (rule 1): the band's radius must exceed half the frame's
 * SHORT side, so no sun position inside the frame can have the whole ring
 * inside it. The +10 is a whisker, not a taste: at exactly half, a sun on the
 * centre line would draw the band tangent to an edge rather than through it.
 */
export function scaleFloorFor(width, height) {
  return (Math.min(width, height) / 2 + 10) / YEAR_RING;
}

/**
 * The scale ceiling: pushed far enough the band retreats into the corners and
 * stops sweeping the desk at all, so the band's radius is held to 90% of the
 * distance from a centred sun to a corner. It is a composition bound, not a
 * safety one — nothing breaks above it, the room just stops reading as a room.
 */
export function scaleCeilingFor(width, height) {
  return (0.9 * Math.hypot(width / 2, height / 2)) / YEAR_RING;
}

/**
 * The ratified room, for a household that cannot say what its own should be —
 * no entries at all, or one, or every entry on the same day, all of which make
 * the fit meaningless. It is the mockup's own authored composition for Lawson
 * Home (sun [690, 340] of 1600×1000, scale 4.95), which is the one room the
 * owner has actually approved.
 */
const DEFAULT_SCALE = 4.95;
const DEFAULT_SUN = [690 / FIELD.width, 340 / FIELD.height];

/* The escape lands a whisker outside the rectangle it escapes, never on its
   edge, so a rounding difference cannot put it back inside. */
const ESCAPE_GAP = 1;
/*
 * The scale steps the clearance pass may spend, and no more: a crowded
 * household gets four attempts at a clear sky, at 100%, 92%, 84% and 76% of
 * its fitted room, and then takes the least-bad. Bounded, like placement.js's
 * relaxation rounds, so the answer arrives in constant time.
 */
const SCALE_STEPS = [1, 0.92, 0.84, 0.76];
/*
 * The candidate grid is exact for the households a person has (the fixtures
 * produce 37×37 and 25×25), and a forty-entry system would produce a quarter
 * of a million pairs, so the grid is capped at the nearest CANDIDATE_CAP
 * offsets per axis. Deterministic: "nearest to the ideal sun" is a total order
 * once ties are broken by coordinate.
 */
const CANDIDATE_CAP = 72;

const ORDER = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * WHERE YOU STAND, and how big the room is.
 *
 * @param {object} options
 * @param {Array}  options.marks   the household's entries as dial-space marks:
 *                                 `{ id, dx, dy, halo, ... }`, offsets from the
 *                                 dial's own centre in dial units (chart.js's
 *                                 law, applied in household.js — this module
 *                                 composes, it does not place)
 * @param {number} options.width   the field's width  (1600)
 * @param {number} options.height  the field's height (1000)
 * @param {Array}  options.keepOut the runs of unprotected small type, in field
 *                                 units: `{ left, top, right, bottom }`. The
 *                                 caller measures them, because only the DOM
 *                                 knows where a header wrapped — the rule
 *                                 itself never touches the DOM.
 * @returns {object} `{ sun, scale, stars, rings, months, clear, crowded,
 *                      fitted, arc }`
 */
export function roomOf({ marks = [], width = FIELD.width, height = FIELD.height, keepOut = [] } = {}) {
  const cached = memoised(marks, width, height, keepOut);
  if (cached) return cached;

  const floor = scaleFloorFor(width, height);
  const ceiling = scaleCeilingFor(width, height);
  const fit = fitScale(marks, width, height);
  /* The fit can be Infinity (one mark, or every mark on one bearing at one
     distance, so the cloud has no extent to fit): then the room is the
     ratified one rather than an arbitrary clamp. */
  const fitted = Number.isFinite(fit);
  const base = fitted ? Math.min(Math.max(fit, floor), ceiling) : DEFAULT_SCALE;

  let best = null;
  for (const step of SCALE_STEPS) {
    const scale = Math.max(floor, base * step);
    const ideal = idealSun(marks, scale, width, height);
    const chosen = clearest(marks, scale, ideal, keepOut, width, height);
    if (!best || chosen.exposure < best.exposure) best = { ...chosen, scale };
    if (chosen.exposure === 0) break;
    /* Already at the floor: a further step would be the same room searched
       twice, and rule 1 forbids going lower. */
    if (scale === floor) break;
  }
  if (!best) {
    /* No marks at all — the empty room. The sun stands where the ratified
       composition put it and the sky is two rings and a year. */
    const scale = Math.max(floor, Math.min(DEFAULT_SCALE, ceiling));
    best = { sun: [DEFAULT_SUN[0] * width, DEFAULT_SUN[1] * height], exposure: 0, scale };
    /* Even an empty room has a sun, and the sun has a field, so it still has
       to clear the header. */
    const clear = clearest([], scale, best.sun, keepOut, width, height);
    best = { ...clear, scale };
  }

  const { sun, scale, exposure } = best;
  const room = {
    sun,
    scale,
    /* Nothing of the sky is drawn on the unprotected type. */
    clear: exposure === 0,
    crowded: exposure > 0,
    fitted,
    /* Rule 1, reported rather than assumed, so a test can hold it. */
    arc: YEAR_RING * scale > nearestEdge(sun, width, height),
    stars: marks.map((mark) => ({
      ...mark,
      cx: round(sun[0] + mark.dx * scale),
      cy: round(sun[1] + mark.dy * scale),
      r: round(mark.halo * scale),
    })),
    rings: {
      sun: round(SUN_FIELD * scale),
      overdue: round(OVERDUE_RING * scale),
      year: round(YEAR_RING * scale),
      rim: round(BAND_RIM * scale),
    },
    months: monthsOf(sun, scale),
  };
  return remember(marks, width, height, keepOut, room);
}

/**
 * The largest room the household's own spread will sit in.
 *
 * What is FITTED is the cloud with its halos, because a halo is what is seen.
 * What decides whether there is anything to fit at all is the cloud of the
 * CENTRES: one entry, or every entry on one day, is a household with no spread,
 * and a spread of nothing scaled to fill a frame is not a composition — it is a
 * division by nearly zero. Those rooms take the ratified one instead.
 */
function fitScale(marks, width, height) {
  if (!marks.length) return Infinity;
  const seen = cloudOf(marks);
  const centres = cloudOf(marks, false);
  const byWidth = centres.right > centres.left ? (width - 2 * FIT_MARGIN) / (seen.right - seen.left) : Infinity;
  const byHeight = centres.bottom > centres.top ? (height - 2 * FIT_MARGIN) / (seen.bottom - seen.top) : Infinity;
  return Math.min(byWidth, byHeight);
}

/** The mark cloud: what is actually seen (halos included), or where the bodies'
 *  own centres are. */
function cloudOf(marks, seen = true) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const mark of marks) {
    const halo = seen ? mark.halo : 0;
    left = Math.min(left, mark.dx - halo);
    right = Math.max(right, mark.dx + halo);
    top = Math.min(top, mark.dy - halo);
    bottom = Math.max(bottom, mark.dy + halo);
  }
  return { left, right, top, bottom };
}

/** The sun that puts the cloud's centre at the centre of the frame. */
function idealSun(marks, scale, width, height) {
  if (!marks.length) return [DEFAULT_SUN[0] * width, DEFAULT_SUN[1] * height];
  const box = cloudOf(marks);
  return [
    width / 2 - ((box.left + box.right) / 2) * scale,
    height / 2 - ((box.top + box.bottom) / 2) * scale,
  ];
}

/**
 * The sun positions that would put something on the protected type: one exact
 * rectangle per (mark, protected rect) pair, plus the sun's own field. Written
 * in a canonical order — marks by id, rects as measured — so the search below
 * cannot feel the order the items arrived in.
 */
function forbidden(marks, scale, keepOut) {
  const rects = [];
  const ordered = [...marks].sort((a, b) => ORDER(a.id, b.id));
  const add = (guard, radius, dx, dy) => rects.push({
    left: guard.left - radius - dx,
    right: guard.right + radius - dx,
    top: guard.top - radius - dy,
    bottom: guard.bottom + radius - dy,
  });
  for (const guard of keepOut) add(guard, SUN_FIELD * scale, 0, 0);
  for (const mark of ordered) {
    for (const guard of keepOut) {
      add(guard, mark.halo * scale, mark.dx * scale, mark.dy * scale);
    }
  }
  return rects;
}

const inside = (rect, x, y) => x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;

/**
 * What a sun position would cost the protected type.
 *
 * A sun inside one of the forbidden rectangles means that mark's halo lies on
 * that guard, and how BADLY is how far inside it sits: the product of the two
 * escapes it would need. Just grazing a guard costs nearly nothing; sitting
 * dead centre on one costs the most. Summed over every (mark, guard) pair, so
 * a position that spoils one small run of type is preferred to one that
 * spoils three — which is the only judgement left when nothing is clear.
 */
function exposureAt(rects, x, y) {
  let cost = 0;
  for (const rect of rects) {
    if (!inside(rect, x, y)) continue;
    cost += Math.min(x - rect.left, rect.right - x) * Math.min(y - rect.top, rect.bottom - y);
  }
  return cost;
}

/**
 * The nearest sun to the ideal one that puts nothing on the protected type —
 * or, when there is no such position, the one that puts the least there.
 */
function clearest(marks, scale, ideal, keepOut, width, height) {
  const rects = forbidden(marks, scale, keepOut);
  if (!rects.length || !rects.some((rect) => inside(rect, ideal[0], ideal[1]))) {
    return { sun: [round(ideal[0]), round(ideal[1])], exposure: 0 };
  }

  const xs = axisCandidates(ideal[0], rects.map((r) => [r.left - ESCAPE_GAP, r.right + ESCAPE_GAP]), 0, width);
  const ys = axisCandidates(ideal[1], rects.map((r) => [r.top - ESCAPE_GAP, r.bottom + ESCAPE_GAP]), 0, height);

  const candidates = [];
  for (const x of xs) {
    for (const y of ys) {
      candidates.push([x, y, Math.hypot(x - ideal[0], y - ideal[1])]);
    }
  }
  /* Nearest first, and a total order so two runs cannot disagree. */
  candidates.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);

  let best = null;
  for (const [x, y] of candidates) {
    const exposure = exposureAt(rects, x, y);
    if (exposure === 0) return { sun: [round(x), round(y)], exposure: 0 };
    if (!best || exposure < best.exposure) best = { sun: [round(x), round(y)], exposure };
  }
  return best;
}

/** The distinct escapes on one axis, nearest the ideal first, inside the
 *  frame, capped so a crowded household still answers in constant time. */
function axisCandidates(ideal, pairs, low, high) {
  const seen = new Set([ideal]);
  for (const [a, b] of pairs) {
    if (a >= low && a <= high) seen.add(a);
    if (b >= low && b <= high) seen.add(b);
  }
  return [...seen]
    .sort((p, q) => Math.abs(p - ideal) - Math.abs(q - ideal) || p - q)
    .slice(0, CANDIDATE_CAP);
}

const nearestEdge = (sun, width, height) =>
  Math.min(sun[0], width - sun[0], sun[1], height - sun[1]);

const MONTHS = ["AUG", "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL"];

/**
 * The calendar band's twelve ticks and names, exactly as home.html builds them
 * — a tick from the year ring inward and the month's name outside it. Only the
 * two or three you are standing under are ever in the room; the renderer draws
 * them all and the legibility pass keeps the ones that can be read.
 */
function monthsOf(sun, scale) {
  return MONTHS.map((label, index) => {
    const angle = ((index * 30 - 90) * Math.PI) / 180;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    return {
      label,
      x1: round(sun[0] + ca * YEAR_RING * scale),
      y1: round(sun[1] + sa * YEAR_RING * scale),
      x2: round(sun[0] + ca * BAND_TICK * scale),
      y2: round(sun[1] + sa * BAND_TICK * scale),
      tx: round(sun[0] + ca * MONTH_TEXT * scale),
      ty: round(sun[1] + sa * MONTH_TEXT * scale + 11),
    };
  });
}

const round = (n) => Math.round(n * 10) / 10;

/* ── THE WORDS ──────────────────────────────────────────────────────────────
 *
 * The mockup's own composition rule, ported whole, because it is the part of
 * the lettering that was already solved:
 *
 *     "An earlier pass hand-placed all six and it was wrong twice over: a
 *      label half-emerged from behind a card reads as a rendering fault rather
 *      than a backdrop, and a label sunk WHOLLY under a panel cannot be read
 *      at all while still costing that panel's small type its contrast — it
 *      was the single worst ink on the screen, 2.70:1 → 2.43:1, for nothing."
 *
 * So each star asks for a berth: candidates are tried reading AWAY from the
 * centre of the figure first (the ratified rule for constellation labels),
 * then back toward it, stepping further out each time, and the first berth
 * wholly inside the frame, wholly clear of every panel and of every word
 * already placed is taken. A star that can find no berth is not lettered — the
 * sky says it is there, the desk beside you says what it is. Urgent entries
 * choose first, because if only some names fit they should be the ones you
 * needed to see.
 *
 * Note what the guards are here, and why they are not the keep-out list above:
 * the CARDS are guards for words (a word under glass is unreadable ink that
 * costs the panel contrast for nothing) and are not keep-out for halos (a soft
 * field under glass is exactly what the backdrop is for).
 */
const LADDER = [-11, 21, -34, 44, -57, 67, -80, 90, -103, 113];
const BERTH_REACH = 38;
const WORD_HEIGHT = 15;
const WORD_TOP = 11;
/* 11.5px mono at 2.1 letter-spacing: one advance is 0.6em plus the tracking. */
const ADVANCE = 11.5 * 0.6 + 2.1;
const FRAME_MARGIN = 16;
/* Guards are padded, so a berth is never accepted on a boundary: a measured
   rectangle can differ by a fraction between two renderers, and a berth that
   flips on a fraction is a composition that flickers. */
const GUARD_PAD = 6;
const WORD_PAD = 8;

/** What a whisper label says: the entry's name, and how far off it is in the
 *  strings every other screen prints (T+ is behind you, T− is ahead). The tag
 *  travels ON the mark, computed against the household's own today by the
 *  shared vocabulary — this module never guesses a date. */
export function wordOf(mark) {
  return { text: (mark.title ?? "").toUpperCase(), tag: `  ·  ${mark.tag ?? ""}` };
}

function wordBox(star, dx, dy, anchor) {
  const { text, tag } = wordOf(star);
  const width = (text.length + tag.length) * ADVANCE;
  const x = star.cx + dx;
  const left = anchor === "start" ? x : x - width;
  return { left, right: left + width, top: star.cy + dy - WORD_TOP, bottom: star.cy + dy - WORD_TOP + WORD_HEIGHT };
}

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const pad = (r, n) => ({ left: r.left - n, right: r.right + n, top: r.top - n, bottom: r.bottom + n });

/**
 * Every star that can be lettered, lettered.
 *
 * @param {object} options
 * @param {Array}  options.stars  the placed stars from roomOf
 * @param {Array}  options.sun    where you stand, so "away" has a meaning
 * @param {Array}  options.guards panels and unprotected type alike, in field
 *                                units — a word may sit on neither
 * @returns {Array} `{ id, x, y, anchor, text, tag, leader }`, in the order the
 *                  berths were taken (most urgent first), which is also the
 *                  order they are drawn in
 */
export function berthsOf({ stars = [], sun = [0, 0], guards = [], width = FIELD.width, height = FIELD.height } = {}) {
  const taken = [];
  const words = [];
  /* Urgency decides who chooses first; a tie is broken by id so the answer
     cannot depend on the order the items arrived in. */
  const order = [...stars].sort((a, b) => a.days - b.days || ORDER(a.id, b.id));
  for (const star of order) {
    const away = star.cx >= sun[0] ? 1 : -1;
    let berth = null;
    for (const dy of LADDER) {
      for (const dir of [away, -away]) {
        const anchor = dir > 0 ? "start" : "end";
        const box = wordBox(star, dir * BERTH_REACH, dy, anchor);
        if (box.left < FRAME_MARGIN || box.top < FRAME_MARGIN) continue;
        if (box.right > width - FRAME_MARGIN || box.bottom > height - FRAME_MARGIN) continue;
        if (guards.some((guard) => overlaps(box, pad(guard, GUARD_PAD)))) continue;
        if (taken.some((word) => overlaps(box, pad(word, WORD_PAD)))) continue;
        berth = { dx: dir * BERTH_REACH, dy, anchor };
        break;
      }
      if (berth) break;
    }
    if (!berth) continue;
    taken.push(wordBox(star, berth.dx, berth.dy, berth.anchor));

    const length = Math.hypot(berth.dx, berth.dy) || 1;
    const { text, tag } = wordOf(star);
    words.push({
      id: star.id,
      x: round(star.cx + berth.dx),
      y: round(star.cy + berth.dy),
      anchor: berth.anchor,
      text,
      tag,
      leader: {
        x1: round(star.cx + (berth.dx / length) * (star.r + 5)),
        y1: round(star.cy + (berth.dy / length) * (star.r + 5)),
        x2: round(star.cx + berth.dx * 0.9),
        y2: round(star.cy + berth.dy * 0.9),
      },
    });
  }
  return words;
}

/* ── THE DESCENT (§15, universal) ───────────────────────────────────────────
 *
 * You are already inside; scrolling takes you DEEPER. The whole figure travels
 * up and out as one rigid drawing — not dissolved, not faded, not re-arranged,
 * because a system does not stop existing when you stop looking at it.
 *
 * --lift is a pure function of scrollTop, which is what makes scroll 0 → 0.5 →
 * 0 return the same frame to the pixel, and it is why reduced motion keeps
 * every bit of it: this is a POSITION, not an animation.
 */
export function liftOf(scrollTop, innerHeight, scrollHeight) {
  const max = Math.max(1, scrollHeight - innerHeight);
  const travelled = Math.min(max, Math.max(0, scrollTop));
  /* The system is overhead within one viewport of scrolling, or 72% of a short
     page, whichever comes first — the mockup's own reach. */
  return Math.min(1, travelled / Math.min(innerHeight, max * 0.72));
}

/* ── "COMPUTED ONCE", MADE LITERAL ──────────────────────────────────────────
 *
 * placement.js's memo, for the same reason: the composition is pure, so a
 * repeat call with the same household and the same viewport must hand back the
 * same answer — and it hands back the SAME OBJECT, which is the cheapest
 * possible proof that a re-render (a resize that lands on the same size, a
 * pack swap, a font re-measure) cannot redraw the room differently.
 */
const memo = new WeakMap();

function signature(marks, width, height, keepOut) {
  const shape = [...marks]
    .sort((a, b) => ORDER(a.id, b.id))
    .map((mark) => `${mark.id}:${mark.dx.toFixed(3)},${mark.dy.toFixed(3)},${mark.halo}`)
    .join("|");
  const guards = keepOut
    .map((g) => `${Math.round(g.left)},${Math.round(g.top)},${Math.round(g.right)},${Math.round(g.bottom)}`)
    .join(";");
  return `${width}x${height}/${guards}#${shape}`;
}

function memoised(marks, width, height, keepOut) {
  return memo.get(marks)?.get(signature(marks, width, height, keepOut)) ?? null;
}

function remember(marks, width, height, keepOut, room) {
  let bySignature = memo.get(marks);
  if (!bySignature) memo.set(marks, (bySignature = new Map()));
  bySignature.set(signature(marks, width, height, keepOut), room);
  return room;
}

/**
 * The mapping between the sky's own 1600×1000 field and the CSS pixels the
 * desk is laid out in. `preserveAspectRatio="xMidYMid slice"` is a uniform
 * scale about the centre — the same mapping the dust already uses — so this is
 * one multiply rather than a guess, and it is what lets a rule that works in
 * field units be handed rectangles measured in the browser.
 */
export function skyMap(innerWidth, innerHeight, field = FIELD) {
  const k = Math.max(innerWidth / field.width, innerHeight / field.height);
  return {
    k,
    ox: (innerWidth - field.width * k) / 2,
    oy: (innerHeight - field.height * k) / 2,
  };
}

/** A browser rectangle, in the field's units. */
export function toField(rect, map) {
  return {
    left: (rect.left - map.ox) / map.k,
    right: (rect.right - map.ox) / map.k,
    top: (rect.top - map.oy) / map.k,
    bottom: (rect.bottom - map.oy) / map.k,
  };
}
