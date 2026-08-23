/**
 * THE FIXED MAP (#428, owner ruling 2026-08-16).
 *
 * Every household's placement in the sky derives from its absolute
 * coordinate, and this module is the only place that derivation happens. The
 * home screen, the newcomer's labelled sky (#453) and the mockup all speak
 * this one law, so a household sits where the sky said it would whatever
 * brought you there.
 *
 * The law, in order of authority:
 *
 *   1. THE BEARING IS SACRED. A household is drawn on the exact bearing from
 *      the camera to its absolute coordinate. No pass below may change it.
 *      (The single ratified exception is the band-edge slide at the end,
 *      owner-found twice: a constellation trapped behind the create handle.)
 *   2. THE RADIUS IS NEGOTIABLE. Distance is expressed as radius, dimming and
 *      scale, and every pass may adjust the radius freely.
 *   3. THE RESULT IS A PURE FUNCTION of (household set, camera, viewport).
 *      No randomness, no clock, no DOM, no dependence on the order the server
 *      happened to return the households in, and no dependence on which
 *      household is currently under the camera beyond its being the origin.
 *
 * Why (3) needed writing down. The placement used to run per render, inline in
 * the renderer, walking `Object.entries(galaxy)` — that is *insertion* order,
 * which is whatever order the workspace read returned — and relaxing overlaps
 * with a sweep whose outcome depends on the order pairs are visited in and on
 * the transient radii of the pairs visited before them. So the same sky, from
 * the same camera, at the same size, could arrange itself differently because
 * a household had been renamed, joined, or simply come back from the API in
 * another order. That is the "the constellations move when you fly" defect.
 *
 * What replaces it:
 *
 *   - a CANONICAL ORDER: households sorted by id, pairs walked in that order,
 *     and a tie between two equal radii broken by id — never by the order the
 *     data arrived in, and never by which pair happened to be looked at first;
 *   - RADIUS-ONLY relaxation, so no pass can buy room by bending a bearing;
 *   - COMPUTED ONCE per (galaxy, camera, viewport) and memoised, so a
 *     re-render — a resize that lands on the same size, a theme swap, a label
 *     re-measure — cannot produce a different sky than the one already drawn.
 *
 * The map is therefore a map: fly from A to B and back and every household is
 * on the pixel it started on; fly from A to B and the household you left sits
 * on the exact reverse bearing. A flight animates between two truths.
 *
 * Two things the owner should know, because neither is free:
 *
 *   - The arrangement is not RIGID. Screen positions are polar about the
 *     camera, so radii are re-derived when the camera moves — they have to be,
 *     or a flight would push most of the map off the edge of the screen
 *     (measured on the shipped fixture: from Seaside, three of the four
 *     households would sit entirely outside a 1112x1000 sky). The BEARINGS are
 *     what the sky teaches, and the bearings never move.
 *   - On a small desk, a crowded sky and a big chart, three ratified rules can
 *     want the same patch of sky: #427's keep-out, §14/#473's minimum
 *     separation, and #428's sacred bearing. Something must give, and the
 *     order here is: the keep-out is a GUARANTEE (a constellation is never
 *     drawn on the chart), the bearing is a LAW with one owner-ratified
 *     exception (the band edge, below), and the separation is a DESIRE, so
 *     the separation is what gives. The predecessor chose the opposite and
 *     paid for it by drawing constellations across the chart. Measured: with
 *     five households at 860x900 after a flight, the worst pair now sits 16px
 *     apart where it used to sit 191px apart — but nothing is on the chart,
 *     where it used to reach 240px inside it. Raised for ratification.
 */

/*
 * The sky's furniture, in the mockup's own numbers.
 *
 * The top of the sky is busier than the bottom — the north-star create handle
 * and the account row live there — so upward bearings get 60px more clearance
 * (owner-found: a constellation squashed behind the handle, 2026-08-15).
 */
const REACH_PAD_X = 40;
const BAND_TOP = 215;
const BAND_BOTTOM = 155;
const BAND_FLOOR = 80;
/* An outward push may overshoot the visible band by this much and no more —
   the other half of the trapped-behind-the-handle bug. */
const REACH_OVERSHOOT = 40;
/* The band slide keeps this much of the hero's own margin. */
const EDGE_MARGIN = 60;
/*
 * EDGE_INSET does not replace REACH_PAD_X, REACH_OVERSHOOT or EDGE_MARGIN
 * above — those are restored exactly as `dev` had them, because the sky's
 * ratified reach law was correct all along. EDGE_INSET is a fourth rule,
 * layered on top: screen containment (#485, follow-up ruling 2026-08-22).
 * The first attempt at this issue insetted from the HERO's edge, and moved
 * the ratified fidelity gate at 1600px — wrong, because the hero legitimately
 * overflows into the viewport's own gutters and the ratified sky depends on
 * that overflow. The real clip boundary is the SCREEN's edge, which at the
 * gate sits 244px further out than the hero's. So this rule is measured from
 * `screen` — the viewport, not the hero — and is applied only as a Math.min
 * against what the old law above already grants: it can TIGHTEN a placement
 * the old law would have drawn outside a narrow screen, but it can never
 * loosen or move anything the old law drew inside a wide one. That is why
 * the fidelity gate (screen 1600) reproduces byte-for-byte — there the fit
 * bound is wider than everything the old law can grant. In the law's own
 * hierarchy this rule outranks separation (a desire) but yields to the
 * keep-out (a guarantee), and it never touches a bearing. 130 = the 118px a
 * constellation's own SVG extends outward of its ring centre, plus 12px of
 * air.
 */
const EDGE_INSET = 130;
const SEPARATION_ROUNDS = 8;
const BAND_ROUNDS = 6;

/**
 * The minimum separation between two constellations, scaled to the viewport
 * (§14/#473): a wide desk has room to spare, so the sky breathes into it
 * instead of huddling at mockup spacing.
 */
export function minSeparationFor(width) {
  return Math.max(230, Math.min(340, width * 0.18));
}

/**
 * How far the visible sky extends on a given bearing — the ellipse the old
 * code applied as a vector clamp, expressed as a radius so it can BOUND a
 * placement instead of REDIRECTING it.
 */
export function reachOn(angle, width, height) {
  const rx = width / 2 + REACH_PAD_X;
  const ry = Math.max(BAND_FLOOR, height / 2 - (Math.sin(angle) < 0 ? BAND_TOP : BAND_BOTTOM));
  return 1 / Math.hypot(Math.cos(angle) / rx, Math.sin(angle) / ry);
}

/** Distance dims a constellation without ever moving it. */
export function dimFor(distance) {
  return Math.max(0.45, Math.min(0.9, 1.05 - distance / 2600));
}

/**
 * The whole sky, placed.
 *
 * @param {object}  options
 * @param {object}  options.galaxy  id -> { name, pos: [x, y], ... }
 * @param {?string} options.camera  the household you are standing in, or null
 *                                  for the newcomer's sky, which stands at the
 *                                  map origin (§11/#453)
 * @param {number}  options.width   the hero's width in px
 * @param {number}  options.height  the hero's height in px
 * @param {number}  options.keepOut radius the chart claims at the centre
 *                                  (#427); 0 where there is no chart
 * @param {number}  [options.screen] the viewport's width in px — the hero is
 *                                  centred in it, so it is always ≥ width.
 *                                  Defaults to width. The #485 screen
 *                                  containment bound is measured from this,
 *                                  never from the hero.
 * @returns {Array} every household in the galaxy, in stable id order, each
 *                  with `{ id, household, isCamera, dist, angle, radius, ox,
 *                  oy, dim, banded }`. The camera's own entry is included at
 *                  the origin and marked `isCamera`: you never see your own
 *                  constellation (you are inside it), but the caller filters
 *                  it rather than this function pretending it does not exist.
 *                  `banded` marks the one ratified case where the bearing
 *                  yielded — see the band clamp below.
 */
export function placeGalaxy({ galaxy, camera = null, width, height, keepOut = 0, screen = width }) {
  const cached = memoised(galaxy, camera, width, height, keepOut, screen);
  if (cached) return cached;

  /* Stable order, always. Not Object.keys(galaxy) — that is the order the
     workspace read happened to produce, and the relaxation below must not be
     able to feel it. */
  const ids = Object.keys(galaxy).sort();
  const origin = camera && galaxy[camera] ? galaxy[camera].pos : [0, 0];
  const minSep = minSeparationFor(width);
  const reach = (angle) => reachOn(angle, width, height);
  /*
   * The #485 screen bound, taken on the SCREEN's own half-width — never the
   * hero's — so it can only tighten what `reach` already grants, never widen
   * or move it. See EDGE_INSET above for why the screen and not the hero.
   */
  const fitX = Math.max(screen / 2 - EDGE_INSET, 0);
  const fit = (angle) => {
    const limit = Math.max(height / 2 - (Math.sin(angle) < 0 ? BAND_TOP : BAND_BOTTOM), 0);
    return Math.hypot(fitX, Math.min(limit, fitX * Math.abs(Math.tan(angle))));
  };

  const points = [];
  const cameraEntry = [];
  for (const id of ids) {
    const household = galaxy[id];
    if (id === camera) {
      cameraEntry.push({
        id, household, isCamera: true, banded: false,
        dist: 0, angle: 0, radius: 0, ox: 0, oy: 0, dim: dimFor(0),
      });
      continue;
    }
    const dx = household.pos[0] - origin[0];
    const dy = household.pos[1] - origin[1];
    const dist = Math.hypot(dx, dy);
    points.push({
      id, household, isCamera: false, banded: false,
      dist,
      /* The bearing. Everything below may read it; nothing may write it. */
      angle: Math.atan2(dy, dx),
      radius: 0,
      ox: 0, oy: 0,
      dim: dimFor(dist),
    });
  }

  /* The sky's usable vertical half-extents: the top is busier, so it ends
     sooner. */
  const safeTop = height / 2 - BAND_TOP;
  const safeBottom = height / 2 - BAND_BOTTOM;

  /*
   * Where a placement is actually drawn: polar about the camera, and then the
   * ONE ratified case where the bearing yields (#428 AC6, owner-found twice —
   * a constellation trapped behind the create handle). On a short hero the
   * keep-out radius exceeds the sky's vertical extent, so a steep bearing has
   * NO position that is both outside the chart and inside the sky. Sitting
   * behind a control is worse than bending: the constellation keeps its
   * RADIUS and slides around its own circle to the band edge on its own side
   * — minimally, deterministically, and marked, so a caller (and a test) can
   * tell a bent bearing from a true one. Because the radius survives the
   * slide, #427's keep-out survives it too.
   */
  const resolve = (point) => {
    let ox = Math.cos(point.angle) * point.radius;
    let oy = Math.sin(point.angle) * point.radius;
    const limit = oy < 0 ? safeTop : safeBottom;
    point.banded = Math.abs(oy) > limit;
    if (point.banded) {
      oy = Math.sign(oy) * Math.max(limit, 0);
      ox = (Math.sign(ox) || 1) * Math.sqrt(Math.max(point.radius * point.radius - oy * oy, 0));
    }
    point.ox = ox;
    point.oy = oy;
  };

  /*
   * Nearer households sit closer in, but never inside the chart. The camera's
   * own constellation is the chart at the centre of the sky, so #427's
   * keep-out IS its separation halo — expressed, like every other separation
   * here, as a radius. Where a bearing cannot clear the chart within the
   * visible band — near-vertical on a short viewport — the keep-out wins and
   * the constellation sits partly outside the band. The bearing never gives.
   */
  for (const point of points) {
    point.radius = Math.max(keepOut, Math.min(point.dist, reach(point.angle), fit(point.angle)));
    resolve(point);
  }

  /*
   * Two bearings can fold onto the same patch of sky. Separate them by
   * drawing one further in and pushing the other further out — RADIUS ONLY,
   * so both keep their true direction. For a banded constellation a bigger
   * radius slides it further along the band, on its own side, which is how
   * the same one pass also answers §14/#473 (owner screenshot: two rings
   * interleaved at a band edge). Its predecessor answered that by shifting
   * `ox` directly, which moved constellations off their true bearing — the
   * very thing #428 forbids, hiding inside #428's own implementation.
   *
   * Where the determinism comes from. Not from the update scheme: settling
   * every pair against one frozen snapshot per round (Jacobi) reads as the
   * purer answer and is measurably worse — two crowded constellations trade
   * the same correction back and forth for ever and end the last round on top
   * of each other, which is not a sky. It comes instead from the ORDER, which
   * is now canonical: households sorted by id, pairs walked in that order,
   * and the tie between two equal radii broken by id rather than by whichever
   * happened to be looked at first. Same set, same camera, same viewport,
   * same answer — whatever order the data arrived in.
   */
  for (let round = 0; round < SEPARATION_ROUNDS; round++) {
    let crowded = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i], z = points[j];
        /* Measured where they are DRAWN, so a band edge cannot hide a
           collision from the pass meant to resolve it. */
        const gap = Math.hypot(z.ox - a.ox, z.oy - a.oy);
        if (gap >= minSep) continue;
        crowded = true;
        const shove = (minSep - gap) / 2;
        const aIsInner = a.radius < z.radius || (a.radius === z.radius && a.id < z.id);
        const inner = aIsInner ? a : z, outer = aIsInner ? z : a;
        const wasInner = inner.radius;
        inner.radius = Math.max(keepOut, inner.radius - shove);
        /*
         * Whatever the inner could not spend against the keep-out, the outer
         * spends instead — otherwise a pair both pinned at the chart's edge
         * simply stays on top of each other, which is what a short desk does
         * to two steep bearings.
         */
        const unspent = shove - (wasInner - inner.radius);
        /*
         * Capped: an uncapped push could shove a constellation past the
         * visible band — the other half of the trapped-behind-the-handle bug.
         * For a constellation already sitting on a band edge the limit is the
         * hero's own side, not the band, because more radius slides it ALONG
         * the edge rather than off the top. On top of that, `fit` (#485)
         * tightens the ceiling further wherever the real screen is narrower
         * than the hero — it only ever narrows this cap, never widens it. And
         * the cap can only ever hold a radius back, never pull one in: a
         * keep-out that already reaches past the band is #428's AC6 case and
         * the pass after it must not quietly undo it.
         */
        const ceiling = Math.max(
          reach(outer.angle) + REACH_OVERSHOOT,
          Math.hypot(width / 2 - EDGE_MARGIN, outer.angle < 0 ? safeTop : safeBottom),
        );
        outer.radius = Math.min(
          outer.radius + shove + unspent,
          Math.max(outer.radius, Math.min(ceiling, fit(outer.angle))),
        );
        resolve(inner);
        resolve(outer);
      }
    }
    if (!crowded) break;
  }

  /*
   * Last resort, for the banded only (§14/#473, owner screenshot: two rings
   * interleaved at a band edge). Two bearings that both yielded to the same
   * band corner can land on the same patch with no radius left to spend — the
   * keep-out floors one and the reach caps the other — and the pass above can
   * do nothing for them.
   *
   * So they slide along the band. ONLY a constellation whose bearing has
   * ALREADY been given leave to yield may move here: a true bearing is never
   * touched to make room for someone else, which is the difference between
   * this and the pass it replaces. The slide stays on its own side of the
   * sky, inside the hero, and outside the chart — the edge bound (tightened
   * by `fit`, #485, wherever the real screen demands it) is applied first,
   * and the keep-out is re-asserted LAST, so #427 holds absolutely rather
   * than up to the last pass: the guarantee always wins, even where the edge
   * bound would otherwise have clipped it.
   */
  const slide = (point, by) => {
    let ox = point.ox + by;
    const side = Math.sign(ox) || Math.sign(point.ox) || 1;
    const clear = Math.sqrt(Math.max(keepOut * keepOut - point.oy * point.oy, 0));
    const bound = Math.min(width / 2 - EDGE_MARGIN, fitX);
    ox = Math.max(-bound, Math.min(bound, ox));
    if (Math.abs(ox) < clear) ox = side * clear;
    point.ox = ox;
  };
  for (let round = 0; round < BAND_ROUNDS; round++) {
    let crowded = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i], z = points[j];
        if (!a.banded && !z.banded) continue;
        const gap = Math.hypot(z.ox - a.ox, z.oy - a.oy);
        if (gap >= minSep) continue;
        crowded = true;
        /* Whoever may move covers the whole distance; a pair both free to
           move splits it. */
        const shove = (minSep - gap) / (a.banded && z.banded ? 2 : 1);
        const aIsLeft = a.ox < z.ox || (a.ox === z.ox && a.id < z.id);
        const left = aIsLeft ? a : z, right = aIsLeft ? z : a;
        if (left.banded) slide(left, -shove);
        if (right.banded) slide(right, shove);
      }
    }
    if (!crowded) break;
  }

  /* Back into stable id order with the camera in its place, so the DOM the
     caller writes is in the same order every time too. */
  const placed = [...points, ...cameraEntry].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return remember(galaxy, camera, width, height, keepOut, screen, placed);
}

/**
 * "Computed once", made literal. The placement is pure, so a repeat call with
 * the same sky, camera and viewport must hand back the same answer — and now
 * it hands back the SAME OBJECTS, which is the cheapest possible proof that a
 * re-render cannot redraw the sky differently.
 *
 * Keyed on the galaxy object (weakly, so a workspace re-read is not retained)
 * and on every scalar that can change the answer, plus the households' own
 * coordinates, so a galaxy mutated in place is never served a stale sky.
 */
const memo = new WeakMap();

function signature(galaxy, camera, width, height, keepOut, screen) {
  const shape = Object.keys(galaxy).sort()
    .map((id) => `${id}:${galaxy[id].pos[0]},${galaxy[id].pos[1]}`)
    .join("|");
  return `${camera ?? ""}@${width}x${height}/${keepOut}/${screen}#${shape}`;
}

function memoised(galaxy, camera, width, height, keepOut, screen) {
  return memo.get(galaxy)?.get(signature(galaxy, camera, width, height, keepOut, screen)) ?? null;
}

function remember(galaxy, camera, width, height, keepOut, screen, placed) {
  let bySignature = memo.get(galaxy);
  if (!bySignature) memo.set(galaxy, (bySignature = new Map()));
  bySignature.set(signature(galaxy, camera, width, height, keepOut, screen), placed);
  return placed;
}
