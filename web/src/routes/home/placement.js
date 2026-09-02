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
/**
 * The radius of a constellation's transparent hit circle (`.mshit`), and so
 * half the closest two constellations may ever be drawn: below twice this,
 * two hit circles overlap and a click lands on a household the person did not
 * aim at, which sends a join request to its owner (#670).
 *
 * Bound to the `r="40"` written into the markup in `home.behaviour.js`. The
 * browser hit-test in the e2e suite is what keeps the two honest; a comment
 * alone would not.
 */
export const HIT_RADIUS = 40;
/* Two hit circles touch at twice the radius, so this is the closest two
   constellations may ever be drawn — the floor the last pass guarantees. */
const FLOOR = HIT_RADIUS * 2;
/*
 * The floor the construction below actually builds to. A spread that aims at
 * exactly `FLOOR` lands a few parts in a quadrillion under it once binary
 * arithmetic has been through a square root, and "a few parts in a
 * quadrillion under" is still under: the guarantee would be false for the
 * sake of rounding. A micron of headroom is invisible on screen and makes the
 * measurement honest.
 */
const FLOOR_FIT = FLOOR + 1e-6;

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
 * One household as the passes below work on it: the bearing and the distance
 * it came from, and where the sky has so far decided to draw it. Named only
 * so the floor pass's helpers can say what they take — the rest of this file
 * predates the type gate and is left as it stands.
 *
 * @typedef {{ id: string, household: any, isCamera: boolean, banded: boolean,
 *             undrawn: boolean, dist: number, angle: number, radius: number,
 *             ox: number, oy: number, dim: number }} Drawn
 */

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
 *                  oy, dim, banded, undrawn }`. The camera's own entry is
 *                  included at the origin and marked `isCamera`: you never
 *                  see your own constellation (you are inside it), but the
 *                  caller filters it rather than this function pretending it
 *                  does not exist. `banded` marks the one ratified case where
 *                  the bearing yielded — see the band clamp below. `undrawn`
 *                  marks a household the floor pass could not fit anywhere
 *                  that meets the floor — the caller must not draw it (see
 *                  the floor pass below for who and why).
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

  /** @type {Drawn[]} */
  const points = [];
  const cameraEntry = [];
  for (const id of ids) {
    const household = galaxy[id];
    if (id === camera) {
      cameraEntry.push({
        id, household, isCamera: true, banded: false, undrawn: false,
        dist: 0, angle: 0, radius: 0, ox: 0, oy: 0, dim: dimFor(0),
      });
      continue;
    }
    const dx = household.pos[0] - origin[0];
    const dy = household.pos[1] - origin[1];
    const dist = Math.hypot(dx, dy);
    points.push({
      id, household, isCamera: false, banded: false, undrawn: false,
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

  /*
   * THE FLOOR (#670, owner ruling 2026-09-01).
   *
   * Everything above expresses separation as a DESIRE, which is the right
   * shape for it right up to the moment the sky runs out of room. Past that
   * point the desire is not merely unmet, it is unmeetable. A bearing that
   * yielded to a band edge has its `oy` pinned and only `ox` left to spend, so
   * once more constellations yield to one edge than that span holds at
   * `minSep`, NO arrangement satisfies the constraint: the relaxation shoves
   * them into the edge bound, the clamp turns every further shove into a
   * no-op, and they come to rest on the same pixel. Adding rounds cannot help
   * — a relaxation is asymptotic, and asymptotic is exactly what a floor may
   * not be.
   *
   * The floor is not a matter of taste. Two hit circles that overlap mean a
   * click aimed at one household lands on another, and that click sends a
   * JOIN REQUEST to the household it landed on — so a crowded sky can post a
   * stranger's front door to someone who never chose it.
   *
   * So separation keeps its desire and gains a floor underneath it: no two
   * drawn centres closer than twice the hit radius, met BY CONSTRUCTION. The
   * relaxation asks "are these two too close, and can I nudge them apart".
   * This pass asks the only question that can guarantee an answer: "how many
   * constellations must this edge carry, and where do they ALL go" — capacity
   * first, then placement.
   *
   * It is deliberately the last word, and deliberately a NO-OP whenever it
   * can be. A sky already clear of the floor is left alone to the pixel:
   * these are ratified screens, and a fix for a crowded sky has no business
   * editing skies that were never crowded.
   */
  /** @type {(a: Drawn, z: Drawn) => number} */
  const floorGap = (a, z) => Math.hypot(z.ox - a.ox, z.oy - a.oy);
  /* Walked in `points` order, which is id order — so which pairs the pass
     sees, and in which order, cannot depend on how the data arrived. An
     undrawn point is not on the sky at all, so it can never be "too close"
     to anything — skipping it here is what keeps the decision permanent
     rather than re-litigated every further round. */
  /** @type {() => Drawn[][]} */
  const tooClose = () => {
    /** @type {Drawn[][]} */
    const pairs = [];
    for (let i = 0; i < points.length; i++) {
      if (points[i].undrawn) continue;
      for (let j = i + 1; j < points.length; j++) {
        if (points[j].undrawn) continue;
        if (floorGap(points[i], points[j]) < FLOOR) pairs.push([points[i], points[j]]);
      }
    }
    return pairs;
  };

  if (tooClose().length) {
    /*
     * Which band edge a yielded constellation belongs to: -1 the sky's top,
     * +1 its bottom. Recorded once, when the pass first sees it, because a
     * member walked inward to a second rank — or a band that collapsed onto
     * the equator on a hero shorter than its own furniture — would otherwise
     * be re-filed onto the other edge halfway through the pass, and an edge
     * that changes membership mid-flight cannot be laid out at all.
     */
    /** @type {Map<Drawn, number>} */
    const bandEdge = new Map();
    /** @type {(point: Drawn) => number} */
    const edgeFor = (point) => Math.sign(point.oy) || Math.sign(Math.sin(point.angle)) || 1;
    for (const point of points) if (point.banded) bandEdge.set(point, edgeFor(point));

    /*
     * #428 AC6's yield, granted for the reason AC6 itself gives. A sub-floor
     * pair of TRUE bearings is pinned between the keep-out it may not enter
     * and the cap it may not pass: neither has any radius left to spend, so
     * the radial pass above has already done everything it can and they are
     * still on top of each other. Sitting on each other is worse than
     * bending, so exactly one bends — the outer, which has the most sky
     * behind it to be re-placed into — and it bends the ratified way: keeping
     * its radius, sliding around its own circle to the band edge on its own
     * side, and marked `banded` so a caller can still tell a bent bearing
     * from a true one.
     */
    /** @type {(point: Drawn) => void} */
    const yieldToBand = (point) => {
      const edge = edgeFor(point);
      const limit = edge < 0 ? safeTop : safeBottom;
      point.banded = true;
      point.oy = edge * Math.max(limit, 0);
      point.ox = (Math.sign(point.ox) || Math.sign(Math.cos(point.angle)) || 1)
        * Math.sqrt(Math.max(point.radius * point.radius - point.oy * point.oy, 0));
      bandEdge.set(point, edge);
    };

    /* The x one side of a rank line may use: the hero's own margin, tightened
       by #485's screen bound, with #427's keep-out carved out of the middle.
       These are the bounds `slide` already applies — the pass divides the
       sky's existing room differently, it does not invent any. */
    /** @type {(oy: number) => number[]} */
    const rankSpan = (oy) => [
      Math.sqrt(Math.max(keepOut * keepOut - oy * oy, 0)),
      Math.min(width / 2 - EDGE_MARGIN, fitX),
    ];

    /*
     * The free x on one side of one rank, as ascending intervals: that side's
     * span, minus every x within the floor of a point this pass may not move.
     * A true bearing is the first such point — #428 forbids moving one to
     * make room for someone else — so the rank routes AROUND it instead.
     */
    /** @type {(side: number, oy: number, obstacles: Drawn[]) => number[][]} */
    const freeOn = (side, oy, obstacles) => {
      const [clear, bound] = rankSpan(oy);
      if (bound <= clear) return [];
      let spans = [side < 0 ? [-bound, -clear] : [clear, bound]];
      for (const other of obstacles) {
        const dy = Math.abs(other.oy - oy);
        if (dy >= FLOOR_FIT) continue;
        /* How far along the rank the floor reaches once the vertical
           distance has already spent part of it. */
        const half = Math.sqrt(FLOOR_FIT * FLOOR_FIT - dy * dy);
        const lo = other.ox - half, hi = other.ox + half;
        /** @type {number[][]} */
        const kept = [];
        for (const [from, to] of spans) {
          if (hi <= from || lo >= to) { kept.push([from, to]); continue; }
          if (from < lo) kept.push([from, lo]);
          if (hi < to) kept.push([hi, to]);
        }
        spans = kept;
      }
      return spans;
    };

    /** @type {(spans: number[][]) => number} */
    const freeLength = (spans) => spans.reduce((sum, [from, to]) => sum + (to - from), 0);
    /* What a free length holds at the floor. The ends are usable, so a bare
       80px of room holds two constellations rather than one. */
    /** @type {(spans: number[][]) => number} */
    const capacityOf = (spans) => (spans.length ? Math.floor(freeLength(spans) / FLOOR_FIT) + 1 : 0);

    /*
     * Arc length along a rank's free x, measured from its OUTER end inward,
     * so the constellation the band slide left furthest out stays furthest
     * out and the pass reads as a tidying rather than a reshuffle.
     *
     * Why arc length and not x. The map from arc length to x skips each
     * forbidden range WHOLE, so it never contracts: two members `FLOOR` apart
     * in arc length are at least `FLOOR` apart in x. That is what lets an
     * even spread be a guarantee rather than an estimate, even on a rank cut
     * into pieces by true bearings.
     */
    /** @type {(spans: number[][], side: number, arc: number) => number} */
    const atArc = (spans, side, arc) => {
      let left = arc;
      const order = side < 0 ? spans : [...spans].reverse();
      for (const [from, to] of order) {
        const len = to - from;
        if (left <= len) return side < 0 ? from + left : to - left;
        left -= len;
      }
      const [from, to] = order[order.length - 1];
      return side < 0 ? to : from;
    };

    /* A lone member has nobody to be spread against, so it keeps the ox the
       passes above chose for it and moves the shortest distance that clears
       the floor. A tie goes OUTWARD, away from the chart. */
    /** @type {(spans: number[][], ox: number) => number} */
    const nearestFree = (spans, ox) => {
      let best = spans[0][0], bestGap = Infinity;
      for (const [from, to] of spans) {
        const candidate = Math.min(to, Math.max(from, ox));
        const gap = Math.abs(candidate - ox);
        if (gap < bestGap || (gap === bestGap && Math.abs(candidate) > Math.abs(best))) {
          best = candidate;
          bestGap = gap;
        }
      }
      return best;
    };

    /*
     * `layOut` is only ever handed the members a rank actually has room for
     * (see `fillRanks` below: `take` is now capacity-capped on every rank,
     * including the last) — so `spans` is never empty here. Anything a rank
     * cannot hold is not laid out sub-floor any more; it spills to the next
     * rank, or, past the last legal one, is marked undrawn (#670, owner
     * ruling 2026-09-02).
     */
    /** @type {(members: Drawn[], spans: number[][], side: number, oy: number) => void} */
    const layOut = (members, spans, side, oy) => {
      if (!members.length) return;
      for (const point of members) point.oy = oy;
      if (members.length === 1) {
        members[0].ox = nearestFree(spans, members[0].ox);
        return;
      }
      /* Endpoints inclusive: the outermost member takes the outer end and the
         innermost takes the inner one, so the spread uses every pixel the
         rank actually has. */
      const step = freeLength(spans) / (members.length - 1);
      members.forEach((point, index) => { point.ox = atArc(spans, side, index * step); });
    };

    /** @type {(edge: number, obstacles: Drawn[]) => void} */
    const relayEdge = (edge, obstacles) => {
      /* A point already marked undrawn is a settled decision (#670, owner
         ruling 2026-09-02) — it does not come back for a second re-lay just
         because another offender on the same edge triggers one. */
      const members = points.filter((point) => point.banded && !point.undrawn && bandEdge.get(point) === edge);
      if (!members.length) return;
      const edgeOy = edge * Math.max(edge < 0 ? safeTop : safeBottom, 0);
      /* Members keep their side of the midline. The band slide has never been
         allowed to carry a constellation across the sky — that would be a
         bearing change wearing a slide's clothes — and the re-lay inherits
         the restraint. */
      let leftward = members.filter((point) => (Math.sign(point.ox) || Math.sign(Math.cos(point.angle)) || 1) < 0);
      let rightward = members.filter((point) => (Math.sign(point.ox) || Math.sign(Math.cos(point.angle)) || 1) >= 0);
      /* Outermost first, ties broken by id: never by whichever the walk above
         happened to reach first. */
      /** @type {(a: Drawn, b: Drawn) => number} */
      const outermostFirst = (a, b) => Math.abs(b.ox) - Math.abs(a.ox) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      leftward.sort(outermostFirst);
      rightward.sort(outermostFirst);
      const roomLeft = capacityOf(freeOn(-1, edgeOy, obstacles));
      const roomRight = capacityOf(freeOn(1, edgeOy, obstacles));
      /*
       * Overflow spills sideways before it spills inward, because the two
       * cost different things. Crossing the midline costs one constellation
       * its side of the sky; wrapping to a second rank costs a whole rank its
       * place in the band, which is the more visible change. The cheaper
       * price is paid first, and it is the INNERMOST members that cross,
       * being the ones already nearest the midline. Only one side can be over
       * capacity while the other has room, so the two cases cannot both fire.
       */
      if (leftward.length > roomLeft && rightward.length < roomRight) {
        const crossing = Math.min(leftward.length - roomLeft, roomRight - rightward.length);
        rightward = rightward.concat(leftward.splice(leftward.length - crossing));
      } else if (rightward.length > roomRight && leftward.length < roomLeft) {
        const crossing = Math.min(rightward.length - roomRight, roomLeft - leftward.length);
        leftward = leftward.concat(rightward.splice(rightward.length - crossing));
      }
      /*
       * A member of this edge stops being movable the moment it lands, and
       * from then on it is exactly the kind of thing later ranks must route
       * around — so it joins the obstacles. That is not bookkeeping: where
       * the keep-out is narrower than the floor the two sides' segments MEET
       * at the midline, and without this the innermost member of each side
       * settles on the same pixel from opposite directions, which is the very
       * defect this pass exists to end.
       */
      const pinned = obstacles.slice();
      /** @type {(side: number, waiting: Drawn[]) => void} */
      const fillRanks = (side, waiting) => {
        let queue = waiting;
        for (let rank = 0; queue.length; rank++) {
          const oy = edgeOy - edge * FLOOR * rank;
          /* Ranks march toward the equator one floor at a time — a whole
             floor, so a member of one rank clears every member of the next by
             the vertical distance alone — and they stop AT the equator: past
             it is the other edge's half of the sky. */
          const last = edge * (oy - edge * FLOOR) < 0;
          const spans = freeOn(side, oy, pinned);
          /*
           * Every rank, including the last, takes only what it has capacity
           * for. Past the last legal rank there is nowhere left that keeps
           * the floor — never crossing the equator, never entering the
           * keep-out — so whatever a household this pass still owes a place
           * to does not fit is marked UNDRAWN rather than forced in sub-floor
           * (#670, owner ruling 2026-09-02, superseding the interim "the last
           * rank has to take what is left anyway"). The pass's own spill
           * order decides who: `queue` is outermost-first throughout, so
           * whatever is left at the last rank is exactly the innermost
           * members, dropped innermost-first with ties already broken by id
           * ascending (`outermostFirst` above). The renderer skips undrawn
           * points; the join list is unaffected, since it is fed the full
           * `visibleHouseholds` upstream rather than this galaxy.
           */
          const take = Math.min(queue.length, capacityOf(spans));
          const here = queue.slice(0, take);
          layOut(here, spans, side, oy);
          pinned.push(...here);
          queue = queue.slice(take);
          if (last) {
            for (const point of queue) point.undrawn = true;
            queue = [];
          }
        }
      };
      fillRanks(-1, leftward);
      fillRanks(1, rightward);
    };

    /*
     * To a fixpoint. Each round either clears the sky or bends one more
     * bearing, and there are only so many bearings to bend, so the round
     * count is a proof of termination rather than a tuning knob — unlike
     * SEPARATION_ROUNDS above, which is a budget for an asymptote.
     */
    for (let round = 0; round <= points.length + 1; round++) {
      const offenders = tooClose();
      if (!offenders.length) break;
      for (const [a, z] of offenders) {
        if (a.banded || z.banded) continue;
        yieldToBand(a.radius > z.radius || (a.radius === z.radius && a.id > z.id) ? a : z);
      }
      /** @type {Set<number|undefined>} */
      const edges = new Set();
      for (const [a, z] of offenders) {
        if (a.banded) edges.add(bandEdge.get(a));
        if (z.banded) edges.add(bandEdge.get(z));
      }
      /* Re-read after the yields above, so a bearing bent this round is an
         edge member rather than an obstacle in its own re-lay. */
      const obstacles = points.filter((point) => !point.banded);
      for (const edge of [-1, 1]) if (edges.has(edge)) relayEdge(edge, obstacles);
    }
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
