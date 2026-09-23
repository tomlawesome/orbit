/**
 * THE BELT, PAINTED (#458) — the imperative half of the item screen.
 *
 * The arithmetic is band.js and is unit-tested; this is the part that has to
 * touch a canvas, an SVG and a wall clock, kept apart from it for exactly that
 * reason (home.behaviour.js's precedent). Every routine below is the sealed
 * mockup's own (design/v19/item-belt.html), transcribed rather than
 * reinterpreted, with three differences and no others — each marked DEVIATION
 * where it happens:
 *
 *   1. the card is rendered by Svelte rather than by innerHTML, because its
 *      actions are real commands (#455) and not inert pills; the mockup's
 *      choreography drives the WRAPPER exactly as it always did, and asks the
 *      screen to swap the content at the 190ms mark.
 *   2. the ambient stream is re-seeded at every BUILD (never at a respawn),
 *      so a rebuild — a resize, a command's re-read, a client-side navigation
 *      back onto this route — draws the same bed rather than a new one. The
 *      "sky never loops" law is about respawn and is untouched: a body that
 *      leaves the arc is still rebuilt from the running stream and never
 *      returns to where it was.
 *   3. the members are built from the real manifest, so the count is whatever
 *      the household holds.
 *
 * No Math.random and no Date.now: every number the gate can see is a pure
 * function of the fixture's seeds, dates and viewport.
 */
import {
  AMBIENT_SEED, BAND_MARGIN, BERTH_NARROW, COS_I, DRIFT, GLIDE, HFRAC, RAD, RADIAL,
  SIN_I, SWEEP, bedOf, berthFor, bloomTargetsOf, bodiesOf, cardWidthOf, clamp01, ease,
  geometryOf, lehmer, phiAtX, rollRangeOf, seatOf, spawnInto, stepFrom,
} from "./band.js";

/**
 * band.js's vocabulary, said once here so the painter speaks the same
 * language as the arithmetic it draws (#624).
 *
 * @typedef {import("./band.js").BeltRow}   BeltRow
 * @typedef {import("./band.js").Body}      Body
 * @typedef {import("./band.js").Geometry}  Geometry
 * @typedef {import("./band.js").Projected} Projected
 * @typedef {import("./band.js").Rubble}    Rubble
 */

/**
 * What the band can be asked to do, once it is mounted.
 *
 * @typedef  {object} BeltControls
 * @property {(i: number) => void}  centre      roll the belt to this seat
 * @property {(id: string) => void} centreById  ...or to this body
 * @property {(id: string) => void} arriveAt    seat it there with no roll at all
 * @property {(next: string, found: Set<number>) => void} setQuery
 * @property {(i: number) => void} openDoc  open a paper's reading card, at this seat
 * @property {() => void} closeDoc    close the open preview, if one is open
 * @property {() => void} remeasure  take the card's footprint again
 * @property {() => void} destroy
 */

/**
 * What the band knows about itself, and hands to every callback.
 *
 * @typedef  {object}   BeltReading
 * @property {Body[]}   bodies    the seat list, band-owned
 * @property {number}   selected  which seat is at the apex
 * @property {number[]} bloom     how far out each item's papers are
 * @property {Geometry} geom
 */

/**
 * The callback's view. The controls are OPTIONAL here and only here, because
 * the first layout runs inside mountBelt — before they have been attached —
 * so a callback firing during it genuinely does not have them yet.
 *
 * @typedef {BeltReading & Partial<BeltControls>} BeltApi
 */

/** What mountBelt hands back: the reading and the controls, both real. */
/** @typedef {BeltReading & BeltControls} BeltController */

/**
 * @typedef  {object}    BeltOptions
 * @property {BeltRow[]} manifest      the belt, in date order
 * @property {?string}   [selectedId]  the body to seat at the apex on arrival
 * @property {(i: number, band: BeltApi) => void} [onSelect]  the apex changed
 * @property {(i: number, band: BeltApi) => void} [onSwap]    swap the card now
 * @property {(i: number, band: BeltApi) => void} [onSettle]  the roll is over
 * @property {(d: number) => void} [onStep]  one step along the belt: -1 sooner,
 *   +1 later. The end-caps call it, and the screen hands in the same function
 *   its ← and → keys call, so there is one step and not two (#1062).
 * @property {(doc: import("./band.js").BeltDoc, side: "left" | "right", band: BeltApi) => void} [onOpenPreview]
 *   a paper was pressed: #1088's reading card opens on the paper's own side.
 *   A document is never the centred body (owner-decisions.md §18), so this is
 *   never routed through onSwap/onSelect — the item at the apex is untouched.
 * @property {(band: BeltApi) => void} [onClosePreview]  the reading card closes
 */

const NS = "http://www.w3.org/2000/svg";
/**
 * The smallest a pointer target on this product is allowed to be, in CSS
 * pixels. Not a number invented here: it is the pocket sheet's own — "grab
 * bar, 44 px buttons", design/v19/tour/round-2/README.md, drawn as
 * `min-height:44px` in that round's sheet — and docs/feature-register.md asks
 * every control to meet a touch target without naming one.
 */
const MIN_TARGET = 44;
/** Breathing room around an end-cap's ink before the target is squared up. */
const END_PAD = 6;
/**
 * @param   {string} name
 * @param   {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  /* setAttribute stringifies anyway; saying so keeps the numbers honest. */
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ==================================================================== *
 * The members' pen. Everything in a belt is stone: an item is v2's faceted
 * rock at 25px wearing its urgency tone on the rim and one pip, and a
 * document is the same rock at 17px inside the paper ring and its glow.
 * There are no planet spheres here — on the dial a body is a planet because
 * the dial is a system; in a belt everything is rock.
 * ==================================================================== */
/**
 * @param {SVGElement} g     the seat to draw into
 * @param {number}     seed  this rock's own silhouette
 * @param {number}     r     its radius
 * @param {string}     tone  the rim's colour
 * @param {boolean}    pip   whether it wears the urgency dot
 */
function drawRock(g, seed, r, tone, pip) {
  const rng = lehmer(seed);
  const facets = 11, pts = [];
  for (let i = 0; i < facets; i++) {
    const a = (i / facets) * Math.PI * 2 + rng() * 0.14;
    const rr = r * (0.80 + rng() * 0.26);
    pts.push(`${(Math.cos(a) * rr).toFixed(2)},${(Math.sin(a) * rr * 0.92).toFixed(2)}`);
  }
  const points = pts.join(" ");
  g.appendChild(el("polygon", { points,
    fill: "color-mix(in srgb, var(--accent) 34%, var(--bg))",
    stroke: tone, "stroke-opacity": ".85", "stroke-width": "1.35",
    "stroke-linejoin": "round" }));
  for (let i = 0; i < 3; i++) {
    const a = rng() * Math.PI * 2, d = rng() * 0.5 * r;
    g.appendChild(el("circle", { cx: (Math.cos(a) * d).toFixed(2),
      cy: (Math.sin(a) * d * 0.9).toFixed(2), r: (1.6 + rng() * 2.4).toFixed(2),
      fill: "#000", opacity: ".2" }));
  }
  g.appendChild(el("polygon", { points, fill: "url(#rockshade)" }));
  /* the urgency pip — one dot, the same four colours the corridor uses */
  if (pip) {
    g.appendChild(el("circle", { cx: (0.44 * r).toFixed(2), cy: (-0.46 * r).toFixed(2),
      r: "4.6", fill: "var(--bg)", opacity: ".85" }));
    g.appendChild(el("circle", { cx: (0.44 * r).toFixed(2), cy: (-0.46 * r).toFixed(2),
      r: "3.1", fill: tone }));
  }
}

/* The mark the owner asked for: a perimeter line in a colour nothing else in
   this sky wears, a glow under it, and a faint disc so both survive being
   seen against a thick part of the band. Worn by a centred item's documents
   — and mirrored onto the ITEM when one of its documents is centred, so the
   way back is as loud as the way in. */
/**
 * @param   {SVGElement} g
 * @param   {number}     r
 * @returns {SVGElement} the mark, for the painter to fade
 */
function drawMark(g, r) {
  const mark = el("g", { class: "mark", opacity: "0" });
  mark.appendChild(el("circle", { class: "halo", r: (r + 19).toFixed(1) }));
  mark.appendChild(el("circle", { class: "ringsoft", r: (r + 9).toFixed(1) }));
  mark.appendChild(el("circle", { class: "ring", r: (r + 9).toFixed(1) }));
  g.appendChild(mark);
  return mark;
}

/**
 * @param   {string} col  a colour in any of the three notations the packs use
 * @param   {number} a    the alpha to give it
 * @returns {string}
 */
function tint(col, a) {
  if (col.startsWith("rgba")) return col.replace(/[\d.]+\)$/, a + ")");
  if (col.startsWith("rgb")) return col.replace("rgb(", "rgba(").replace(")", `,${a})`);
  const h = col.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const v = parseInt(n, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/* ---- THE EDGE FADE ---------------------------------------------------
   The fade lives OUTSIDE the stroke, applied once to the finished wash as a
   destination-out mask: inside the stroke it drew a discoloured box, because
   eighteen passes at globalAlpha 0.0135 quantise to nothing and then to
   exactly 1/255 across one dead-straight vertical line. The mask scales an
   alpha of ~50 instead of one of ~1, so it has fifty steps to spend on the
   ramp and reads as a fade. All four sides, and solid a little INSIDE every
   bound, so the glow is already nothing before there is any edge to stop at.
   The rubble is NOT masked: the bodies drift out past the glow on their own
   longer fade, which is what makes the belt leave the sky instead of ending. */
const EDGE_IN = 0.012;      /* the wash is already nothing this far in    */
const EDGE_X = 0.17;        /* ...and at full weight by here. v2's figure */
const EDGE_Y = 0.10;        /* the sky is shorter than it is wide         */
const EDGE_STOPS = 24;      /* enough to read as a curve, not a polyline  */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W
 * @param {number} H
 */
function fadeEdges(ctx, W, H) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  for (const [across, fade] of
       /** @type {[boolean, number][]} */ ([[true, EDGE_X], [false, EDGE_Y]])) {
    const g = across ? ctx.createLinearGradient(0, 0, W, 0)
                     : ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,1)");
    for (let i = 0; i <= EDGE_STOPS; i++) {
      const u = i / EDGE_STOPS;
      const o = EDGE_IN + (fade - EDGE_IN) * u;
      const e = (1 - u * u * (3 - 2 * u)).toFixed(4);   /* 1 - smoothstep */
      g.addColorStop(o, `rgba(0,0,0,${e})`);
      g.addColorStop(1 - o, `rgba(0,0,0,${e})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

/**
 * Mounts the belt into an already-rendered shell and hands back the controls
 * the screen drives it with. `root` is the page element; the shell's parts are
 * found by the mockup's own ids.
 *
 * Those seven lookups are asserted rather than tested, and deliberately: the
 * shell is this module's own partner markup (+page.svelte) and every part is
 * in it unconditionally, so a missing one is a broken build, not a state the
 * belt should carry a branch for.
 *
 * @param   {HTMLElement} root
 * @param   {BeltOptions} options
 * @returns {BeltController}
 */
export function mountBelt(root, options) {
  const {
    manifest,
    selectedId,
    onSelect = () => {},
    onSwap = () => {},
    onSettle = () => {},
    onStep,
    onOpenPreview = () => {},
    onClosePreview = () => {},
  } = options;

  const bandC = /** @type {HTMLCanvasElement} */ (root.querySelector("#band"));
  const foreC = /** @type {HTMLCanvasElement} */ (root.querySelector("#fore"));
  const membersSvg = /** @type {SVGSVGElement} */ (root.querySelector("#members"));
  const seatsG = /** @type {SVGGElement} */ (root.querySelector("#seats"));
  const capsG = /** @type {SVGGElement} */ (root.querySelector("#caps"));
  const endsG = /** @type {SVGGElement} */ (root.querySelector("#ends"));
  const wrap = /** @type {HTMLElement} */ (root.querySelector("#cardwrap"));
  /* #1088: the grid the reading card grows beside — create-v3's lanes,
     ported (design/v19/create-v3.html's own mechanism, carried into
     document-card/round-6's belt). Its --cardw is read from the belt's own
     layout below, exactly as the mockup's own does. */
  const lanesEl = /** @type {HTMLElement} */ (root.querySelector("#lanes"));
  /* A canvas in a browser always has a 2d context; the null is for hosts
     that have no canvas at all, which is not one the belt can run in. */
  const bctx = /** @type {CanvasRenderingContext2D} */ (bandC.getContext("2d"));
  const fctx = /** @type {CanvasRenderingContext2D} */ (foreC.getContext("2d"));
  const hazeCanvas = document.createElement("canvas");
  const hctx = /** @type {CanvasRenderingContext2D} */ (hazeCanvas.getContext("2d"));

  let geom = geometryOf(window.innerWidth, window.innerHeight);
  /** @type {Body[]} */
  let bodies = [];
  /** @type {Rubble[]} */
  let rubble = [];
  /** @type {Projected[]} */
  let hazePts = [];
  /** @type {?{ l: number, r: number, t: number, b: number }} */
  let cardRect = null;
  let selected = 0, prevSel = 0;
  let roll = 0, rollFrom = 0, rollTo = 0, rollT0 = -1, drift = 0;
  /* Undefined rather than null: nothing ever reads this but clearTimeout,
     which is what "no roll is pending" means to the only reader there is. */
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let swapTimer;
  let berthNow = BERTH_NARROW, berthFrom = BERTH_NARROW, berthTo = BERTH_NARROW;
  /** @type {number[]} */
  let bloom = [];
  /** @type {number[]} */
  let bloomFrom = [];
  /** @type {number[]} */
  let bloomTo = [];
  let query = "";
  /** @type {Set<number>} */
  let matches = new Set();
  /* #1088: which paper's reading card is out, or -1. A document is never the
     centred body, so this rides beside `selected` rather than inside it —
     opening one never touches roll, bloom or the card. */
  let previewIdx = -1;
  let base = 0, reach = 0;
  let TONE = ["#737e9e", "#d8b45a", "#243259"], GAIN = 1;
  let raf = 0, last = 0, lastPaint = 0, alive = true;

  /* Built before anything is laid out, and handed to every callback as its
     second argument: the screen's callbacks run DURING the first layout, when
     the caller's own `const controller = mountBelt(...)` has not been assigned
     yet. */
  /** @type {BeltApi} */
  const api = {
    get bodies() { return bodies; },
    get selected() { return selected; },
    get bloom() { return bloom; },
    get geom() { return geom; },
  };

  /* ---- the seats ---------------------------------------------------- */

  function buildBodies() {
    bodies = bodiesOf(manifest, geom.GAP_SCALE);
    const at = bodies.findIndex((b) => b.id === selectedId);
    selected = prevSel = Math.max(0, at);
    roll = rollFrom = rollTo = bodies[selected]?.off ?? 0;
    bloomTo = bloomTargetsOf(bodies, selected, manifest.length);
    bloom = bloomFrom = bloomTo.slice();
    berthNow = berthFrom = berthTo = berthFor(bodies, selected, manifest.length);
    ({ base, reach } = rollRangeOf(bodies));
  }

  function buildSeats() {
    seatsG.textContent = ""; capsG.textContent = "";
    bodies.forEach((b, i) => {
      const seat = el("g", { class: "seat" });
      const hit = el("g", { class: "hit", role: "button", tabindex: "0" });
      hit.setAttribute("aria-label", b.kind === "item"
        ? `${b.label} — ${b.item.section ?? "no section"}, due ${b.longWhen}, ${b.t}` +
          (b.docs.length ? `, ${b.docs.length} documents attached` : "")
        : `${b.doc.name}, ${b.sub}, a document attached to ${b.item.title}`);
      hit.appendChild(el("circle", { r: b.r * 1.8, fill: "transparent" }));
      hit.appendChild(el("circle", { class: "fring", r: b.r + 13, fill: "none",
        stroke: "var(--accent)", "stroke-width": "1.4", "stroke-dasharray": "3 3" }));
      b.mark = drawMark(hit, b.r);
      /* CON-1's belt ellipse: this item has documents attached. On this screen
         it is also a promise — centre it and they come out into the band. */
      if (b.kind === "item" && b.docs.length)
        hit.appendChild(el("ellipse", { rx: (b.r * 1.93).toFixed(1),
          ry: (b.r * 0.66).toFixed(1), transform: "rotate(-24)", fill: "none",
          stroke: "var(--paper)", "stroke-width": "1.3", opacity: ".75" }));
      drawRock(hit, b.seed, b.r, b.tone, b.kind === "item");
      hit.appendChild(el("circle", { class: "rim", r: b.r + 10, fill: "none",
        stroke: "var(--accent)", "stroke-width": "1", opacity: "0" }));
      /* #1088: a rock rolls to the apex; a paper opens the reading card in
         place. A document is never the centred body (owner-decisions.md
         §18), so its press never reaches `centre`. */
      const press = () => { (bodies[i].kind === "doc" ? openDoc : centre)(i); };
      hit.addEventListener("click", press);
      hit.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); press(); }
      });
      seat.appendChild(hit); seatsG.appendChild(seat);

      /* The label rides upright beneath the body — the band's tangent turns the
         rock, never the words. */
      const cap = el("g", { class: "capseat" });
      const name = el("text", { class: "cap-name", y: (b.r + 21).toFixed(0) });
      if (b.kind === "doc") name.setAttribute("class", "cap-name doclabel");
      name.textContent = b.label;
      const sub = el("text", { class: "cap-t", y: (b.r + 36.5).toFixed(0), fill: b.tone });
      sub.textContent = b.sub;
      cap.append(name, sub); capsG.appendChild(cap);
    });
  }

  /* The two end-caps: which way time runs. Quiet, riding the band where it
     leaves the frame, so the words label the line they describe (#1010, owner
     2026-09-16 — the far corners they used to sit in belong to the shared
     chrome now). Above the band's upper edge, clear of the tallest rock and
     its ring, because a body can sit anywhere along the band, including at
     the frame's edge: below or on the band, one would eventually cover them.
     Labels hang beneath their rocks, so above is the one safe side.

     On a phone that safe side is a sliver (#1035): the ring radius floors at
     A_MIN, so a 390px sky sees a hugely magnified band whose crest is up in
     the chrome's own strip. Two answers below — the label starts past its
     side's chrome, and it is held inside the frame — and where the band has
     taken the strip outright, no end-cap is drawn.

     #1062: and each one is a CONTROL, in the position it already had. Not a
     caption saying which way time runs but the thing that moves you that
     way, because stepping was keyboard-only and a phone has no arrow keys.
     Built as `<g role="button">` rather than an HTML `<button>` in a
     `<foreignObject>`: the label is placed in the band's own coordinates,
     against a line this module solves for, and lifting it out into HTML
     would mean keeping a second copy of that arithmetic in sync. The seats
     beside it are already `<g role="button" tabindex="0">` (buildSeats), so
     it borrows their shape: a transparent target, and Enter and Space. Not
     their focus ring — belt.css says why the ring here is an `outline` on the
     control itself rather than a shape drawn inside it.
     The press itself is handed straight to the screen's own ← / → handler. */
  function buildEnds() {
    endsG.textContent = "";
    if (!bodies.length) return;
    const half = (geom.A * RADIAL * COS_I * 2 + geom.A * HFRAC * SIN_I * 2) / 2;
    const clear = half + 25 + 6 + 14;   /* rock r ≤ 25, its ring, breathing room */
    /* #1035: on a narrow sky the shared chrome shares this strip, and the
       end-caps were drawn under the way back and the account orb. belt.css
       says how much room each side's chrome needs — nothing on a desk, where
       the corners are empty — and the end-cap starts past it. Read from CSS
       rather than repeated here so the breakpoint has one home; a host that
       resolves neither reads 0 and nothing moves. */
    const strip = getComputedStyle(root);
    const insetStart = Number.parseFloat(strip.getPropertyValue("--endcap-inset-start")) || 0;
    const insetEnd = Number.parseFloat(strip.getPropertyValue("--endcap-inset-end")) || 0;
    /* #1035: and the search field is fixed in this strip as well. On a desk
       it is a centred 360px column with the end-caps far out at the edges;
       on a narrow sky it spans nearly the whole width and takes a row of its
       own, which the band's crest can reach down into. Its live box says
       where it is, so there is no second copy of belt.css's breakpoint here. */
    const field = /** @type {HTMLElement | null} */ (root.querySelector(".find"));
    const fieldBox = field?.getBoundingClientRect() ?? null;
    /* Two things that look like one and are not. `dir` is which branch of the
       band's curve this x sits on; `step` is which way a press moves you, the
       arrow key's own -1 / +1. At each end they are OPPOSITE, so a press
       wired from `dir` walks the belt backwards — which is why the direction
       is spelt out rather than borrowed.

       And the accessible name says what pressing it DOES. "Sooner" and
       "later" alone are the drawing's two words read back, which tells a
       reader who cannot see the band nothing about where they would land. */
    for (const [x, dir, step, anchor, text, name] of
         /** @type {[number, number, number, string, string, string][]} */
         ([[28 + insetStart, +1, -1, "start", "← sooner",
            "Move one item sooner along the belt, towards what is due first"],
           [geom.W - 28 - insetEnd, -1, +1, "end", "later →",
            "Move one item later along the belt, towards what is due last"]])) {
      const line = geom.project(phiAtX(geom, x, dir), geom.A, 0).y;
      /* #1035: `clear` above the band's line is where the label wants to be,
         and on a short sky that is off the top of the frame — a phone was
         drawing "← sooner" half cut off. So it is floored at 20, but never
         lower than eight above the topmost ink a body at this x can reach,
         which is the clearance this whole placement exists to keep. */
      const bodyTop = line - half - 25 - 6;
      let y = Math.min(bodyTop - 8, Math.max(20, line - clear));
      /* Drawn before it is placed, because only the laid-out text knows how
         wide it is, and how wide it is decides whether it shares a column
         with the search field. */
      const cap = el("g", { class: "endcap-hit", role: "button", tabindex: "0",
        "aria-label": name, "data-step": step });
      /* No focus-ring shape in here: belt.css puts the ring on the control
         itself as an `outline`, because the keyboard audit reads the computed
         style of the focused element and a child cannot answer for it. */
      const target = el("rect", { class: "endtarget", fill: "transparent" });
      const t = /** @type {SVGTextContentElement} */ (
        el("text", { class: "endcap", x, y: y.toFixed(0), "text-anchor": anchor }));
      t.textContent = text;
      cap.append(target, t);
      endsG.appendChild(cap);
      const w = t.getComputedTextLength();
      const left = anchor === "end" ? x - w : x;
      if (fieldBox && left < fieldBox.right + 6 && left + w > fieldBox.left - 6) {
        /* Above the field, never through it. Raising it is always safe: it
           only ever moves the label further from the band. */
        y = Math.min(y, fieldBox.top - 10);
      }
      /* And where even that has left the frame, the band has taken the whole
         strip and the label is not drawn at all: the search field's own note
         (which says the order) still carries which way time runs. */
      if (y < 12) { cap.remove(); continue; }
      t.setAttribute("y", y.toFixed(0));
      /* #1062: the ink stays 9.5px; the TARGET does not. MIN_TARGET square
         at the least, squared up around the words and centred on them, so
         nothing painted moves a pixel. Held inside the frame, because at the
         top of a phone's sky the label is already at y=20 and half the box
         would otherwise hang off the sky where no thumb can reach it. The
         seats are drawn after #ends, so a rock crossing the box still takes
         the tap ahead of it. */
      const boxW = Math.max(w + END_PAD * 2, MIN_TARGET);
      const boxX = left + w / 2 - boxW / 2;
      /* 9.5px capitals stand about 7px off the baseline, so the ink's middle
         is three and a half above it. */
      const boxY = Math.max(0, Math.min(geom.H - MIN_TARGET, y - 3.5 - MIN_TARGET / 2));
      target.setAttribute("x", boxX.toFixed(1));
      target.setAttribute("y", boxY.toFixed(1));
      target.setAttribute("width", boxW.toFixed(1));
      target.setAttribute("height", String(MIN_TARGET));
      cap.addEventListener("click", () => pressEnd(cap, step));
      cap.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pressEnd(cap, step); }
      });
    }
    markEnds();
  }

  /**
   * An end-cap pressed. One press, one step, through the screen's own ← / →
   * handler — so the animation and the landing are the arrow key's, because
   * they ARE the arrow key's.
   *
   * @param {Element} cap
   * @param {number}  d  -1 sooner, +1 later
   */
  function pressEnd(cap, d) {
    if (cap.getAttribute("aria-disabled") === "true") return;
    onStep?.(d);
  }

  /**
   * Which way the belt can still go. At an exhausted end the control that
   * cannot move says so — `aria-disabled`, read out as unavailable — rather
   * than taking the press and doing nothing (#1062). It stays in the Tab
   * order so a reader can still find it and hear that it is spent.
   *
   * Read against `bloomTo`, where the papers are heading rather than where
   * they are mid-roll: that is the state the screen's own handler will be
   * read against by the time a press lands.
   */
  function markEnds() {
    for (const cap of endsG.children) {
      const off = stepFrom(bodies, selected, bloomTo, Number(cap.getAttribute("data-step"))) < 0;
      cap.setAttribute("aria-disabled", String(off));
      cap.classList.toggle("off", off);
    }
  }

  /* How solid a body is at this instant of the roll. The body at the apex is
     NOT drawn: it is the card. Its rock fades back in as it leaves, and the
     arriving one fades out as the card blooms — which is the whole trick of
     "the card rides in the belt". */
  /**
   * @param   {number} i  the seat
   * @param   {number} p  how far through the roll we are
   * @returns {number}
   */
  function bodyOpacity(i, p) {
    if (i === selected) return 1 - clamp01((p - 0.32) / 0.34);
    if (i === prevSel) return clamp01((p - 0.1) / 0.42);
    return 1;
  }

  /** @param {number} p how far through the roll we are */
  function paintMembers(p) {
    const seats = /** @type {HTMLCollectionOf<SVGGElement>} */ (seatsG.children);
    const caps = capsG.children;
    /* the papers coming out, and the old ones folding away: out fast, in late,
       so the two never cross in the middle of the apex */
    bloom = bloomFrom.map((f, k) => {
      const tg = bloomTo[k];
      const q = tg > f ? clamp01((p - 0.42) / 0.58) : clamp01(p / 0.4);
      return f + (tg - f) * q;
    });
    const selBody = bodies[selected];

    bodies.forEach((b, i) => {
      const open = b.kind === "doc" ? bloom[b.itemIdx] : 1;
      const s = seatOf(bodies, i, { roll, berth: berthNow, geom });
      const a = geom.project(s.phi, s.rho, s.h);
      const q = geom.project(s.phi + 0.03, s.rho, s.h);
      const ang = Math.atan2(a.y - q.y, a.x - q.x) / RAD;
      /* Rolled round the back of the ring: not on this sky at all. */
      const away = s.phi > geom.PHI_L + 0.2 || s.phi < geom.PHI_R - 0.2;
      /* The search dims, it does not hide: the belt keeps its shape so you can
         see WHERE IN TIME the thing you asked for sits. */
      const lit = !query || matches.has(i);
      let o = bodyOpacity(i, p) * (lit ? 1 : 0.26) * open;
      if (away) o = 0;
      /* a paper folds out of its item: it grows into place as it appears */
      const sc = b.kind === "doc" ? (0.45 + 0.55 * open) : 1;
      seats[i].setAttribute("transform",
        `translate(${a.x.toFixed(1)},${a.y.toFixed(1)}) rotate(${ang.toFixed(2)}) scale(${sc.toFixed(3)})`);
      seats[i].setAttribute("opacity", o.toFixed(3));
      /* The body at the apex is the card: it is neither clickable nor
         tabbable while it is being the card, or the keyboard would land on
         something nobody can see. Nor is a body that has rolled off the sky,
         nor a paper that is still folded inside its item. */
      const gone = o < 0.5;
      seats[i].style.pointerEvents = gone ? "none" : "";
      const hit = /** @type {SVGGElement} */ (seats[i].firstChild);
      hit.setAttribute("tabindex", gone ? "-1" : "0");
      hit.setAttribute("aria-hidden", gone ? "true" : "false");
      /* A lit hit wears its rim while the search is open, so matches read as
         matches even before you reach for them. */
      const rim = /** @type {SVGElement} */ (hit.querySelector(".rim"));
      rim.setAttribute("opacity", query && lit ? ".85" : "0");
      /* THE MARK. On every paper that is out; and mirrored onto the item when
         one of its own papers is the thing at the apex. */
      const marked = b.kind === "doc"
        ? open
        : (selBody && selBody.kind === "doc" && selBody.itemIdx === b.itemIdx ? bloom[b.itemIdx] : 0);
      /* the glow is a real SVG filter, so a mark nobody can see is taken out
         of the tree rather than left to be rasterised at zero opacity */
      /* buildSeats gave every seat its mark before anything was ever
         painted, which is why this is a fact and not a branch. */
      const mark = /** @type {SVGElement} */ (b.mark);
      mark.setAttribute("opacity", marked.toFixed(3));
      mark.style.display = marked < 0.004 ? "none" : "";
      caps[i].setAttribute("transform", `translate(${a.x.toFixed(1)},${a.y.toFixed(1)})`);
      caps[i].setAttribute("opacity", o.toFixed(3));
    });
  }

  /* ---- the band ------------------------------------------------------ */

  function readTones() {
    const cs = getComputedStyle(document.documentElement);
    TONE = [cs.getPropertyValue("--rubble").trim() || cs.getPropertyValue("--chart-ink").trim(),
            cs.getPropertyValue("--accent").trim(),
            cs.getPropertyValue("--chart-line").trim()];
    /* Dark ink on a printed sky needs more weight than lit stone on a night
       sky to carry the same amount of belt: the packs say how much. */
    GAIN = parseFloat(cs.getPropertyValue("--rubble-gain")) || 1;
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [c, ctx] of
         /** @type {[HTMLCanvasElement, CanvasRenderingContext2D][]} */
         ([[bandC, bctx], [foreC, fctx]])) {
      c.width = Math.round(geom.W * dpr); c.height = Math.round(geom.H * dpr);
      c.style.width = geom.W + "px"; c.style.height = geom.H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  /* The band's body: a broad, soft glow along the ring, fading out at the
     edges of the sky rather than stopping. No hairline track — v1's wire is
     exactly what the owner said a belt is not, and a hard-edged glow is only
     a fatter wire, so the glow is laid down as eighteen near-transparent
     passes of falling width. The profile that builds up has no edge at all;
     the band simply stops being there. */
  /** @param {CanvasRenderingContext2D} ctx */
  function paintHaze(ctx) {
    /* Still a gradient, and deliberately: the fade has come out of it but the
       paint path must not change. Skia carries a gradient's premultiplied
       source at more precision than a flat colour, and eighteen passes at
       globalAlpha 0.0135 are exactly where that shows — handing the same
       colour over as a plain string thins the whole band from 54/255 to
       37/255. So the stops stay; only their alphas go to one. */
    const grad = ctx.createLinearGradient(0, 0, geom.W, 0);
    for (const o of [0, 0.17, 0.83, 1]) grad.addColorStop(o, tint(TONE[2], 1));
    ctx.strokeStyle = grad;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const thick = geom.A * RADIAL * COS_I * 2 + geom.A * HFRAC * SIN_I * 2;
    const passes = 18;
    for (let k = 0; k < passes; k++) {
      const t = k / (passes - 1);
      ctx.globalAlpha = 0.0135;
      ctx.lineWidth = thick * (0.78 - 0.7 * t * t);
      ctx.beginPath();
      hazePts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    fadeEdges(ctx, geom.W, geom.H);
  }

  function buildHaze() {
    hazePts = [];
    for (let k = 0; k <= 80; k++)
      hazePts.push(geom.project(geom.PHI_R + ((geom.PHI_L - geom.PHI_R) * k) / 80, geom.A, 0));
    /* The glow never changes between resizes, and it is by far the most
       expensive thing on the plate, so it is rasterised once and blitted. */
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    hazeCanvas.width = Math.round(geom.W * dpr); hazeCanvas.height = Math.round(geom.H * dpr);
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hctx.clearRect(0, 0, geom.W, geom.H);
    paintHaze(hctx);
  }

  /* DEVIATION 2: the stream is seeded HERE, at the build, so the same sky and
     the same manifest always sow the same bed — a rebuild is a rebuild, not a
     new universe. `bandRng` then runs on unrewound for every respawn below,
     which is the law it was written for: the sky never loops. */
  let bandRng = lehmer(AMBIENT_SEED);

  function buildBand() {
    bandRng = lehmer(AMBIENT_SEED);
    rubble = bedOf({ rng: bandRng, geom, bodies, base, reach, drift });
  }

  function paintBand() {
    bctx.clearRect(0, 0, geom.W, geom.H); fctx.clearRect(0, 0, geom.W, geom.H);
    bctx.drawImage(hazeCanvas, 0, 0, geom.W, geom.H);

    /* Every member's swept neighbourhood — a chain of clearings down the band
       — plus the card's own footprint, because the card is a body in the band
       too and nothing sits on top of it. A paper still folded inside its item
       has swept nothing. */
    /** @type {[Projected, number][]} */
    const clears = [];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const open = b.kind === "doc" ? (bloom[b.itemIdx] ?? 0) : 1;
      if (open < 0.5) continue;
      const s = seatOf(bodies, i, { roll, berth: berthNow, geom });
      const c = geom.project(s.phi, s.rho, s.h);
      if (c.x > -SWEEP && c.x < geom.W + SWEEP) clears.push([c, b.sweep]);
    }
    const hMax = geom.A * HFRAC;
    const foreCut = hMax * 0.58;      /* above this, a body passes in FRONT */
    const fadeIn = 0.14 * geom.W;     /* the belt leaves the sky, it does not stop */

    for (const rk of rubble) {
      /* Retirement is judged in BAND coordinates — at the sooner end of the
         roll, the one frame the belt cannot move — so a body is only ever
         rebuilt when it has left the arc for good, not merely when the current
         roll has carried it off this particular screen. It re-enters at the
         far end of the widened arc, freshly made: never a loop. */
      const band = rk.phi + (drift + base) * rk.rate;
      if (band > geom.PHI_L + BAND_MARGIN) {
        spawnInto(rk, 0, { rng: bandRng, geom, base, reach, drift });
        continue;
      }
      const phi = band + (roll - base) * rk.rate;
      /* Sown far wider than one sky, so most of the bed is over the horizon at
         any one roll: cost it out before projecting it. */
      if (phi < geom.PHI_R - BAND_MARGIN || phi > geom.PHI_L + BAND_MARGIN) continue;
      const p = geom.project(phi, rk.rho, rk.h);
      if (p.x < -40 || p.x > geom.W + 40 || p.y < -40 || p.y > geom.H + 40) continue;

      /* depth: the arc's ends lean toward you, and height above the plane
         brings a body forward. Near bodies are bigger, brighter, quicker. */
      const dn = clamp01(0.5 + (p.d / (geom.A * 0.62)) * 0.9);
      let a = rk.alpha * (0.55 + dn * 0.75) * GAIN;
      const s = rk.size * (0.78 + dn * 0.5);

      a *= Math.min(1, p.x / fadeIn) * Math.min(1, (geom.W - p.x) / fadeIn);
      for (const [c, sw] of clears) {
        if (Math.abs(p.x - c.x) > sw || Math.abs(p.y - c.y) > sw) continue;
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < sw) a *= clamp01((d - sw * 0.45) / (sw * 0.55));
      }
      if (a <= 0.012) continue;

      /* Bodies riding high above the ring plane pass in FRONT of the card:
         the card is IN the belt, so some of the belt is between it and you.
         Dimmed, and dimmed again over the card, so it never fights the text. */
      const front = rk.h > foreCut && rk.size < 5.6;
      const ctx = front ? fctx : bctx;
      if (front) {
        a *= 0.8;
        if (cardRect && p.x > cardRect.l && p.x < cardRect.r && p.y > cardRect.t && p.y < cardRect.b)
          a *= 0.85;
      }
      ctx.globalAlpha = Math.min(a, 0.95);
      ctx.fillStyle = TONE[rk.tone];
      if (rk.poly) {
        ctx.beginPath();
        rk.poly.forEach(([px, py], i) =>
          i ? ctx.lineTo(p.x + px * s, p.y + py * s) : ctx.moveTo(p.x + px * s, p.y + py * s));
        ctx.closePath(); ctx.fill();
        if (s > 4) {           /* a lit edge on the biggest rubble only */
          ctx.globalAlpha = Math.min(a * 0.5, 0.4);
          ctx.strokeStyle = TONE[1]; ctx.lineWidth = 0.7; ctx.stroke();
        }
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, s, 0, 6.2832); ctx.fill();
      }
    }
    bctx.globalAlpha = 1; fctx.globalAlpha = 1;
  }

  function measureCard() {
    const r = wrap.getBoundingClientRect();
    cardRect = { l: r.left, r: r.right, t: r.top, b: r.bottom };
    levelReadcard();
  }

  /* ==================================================================== *
   * #1088: THE READING CARD'S SIDE AND LEVEL. Everything else about the
   * card's content is the screen's (Svelte, same law as the item card) —
   * this module only answers "which side" and "how high", because both are
   * questions about where bodies sit in the belt's own geometry.
   * ==================================================================== */

  /**
   * Which half of the sky a seat is on right now — the reading card grows on
   * the SAME side, so opening a paper never has the card jump across the
   * apex to reach it.
   *
   * @param   {number} i
   * @returns {"left" | "right"}
   */
  function sideOf(i) {
    const seat = seatsG.children[i];
    const r = seat.getBoundingClientRect();
    return r.left + r.width / 2 < geom.W / 2 ? "left" : "right";
  }

  /* create-v3's levelWithCard, verbatim in its arithmetic: whatever the
     reading card's height turns out to be, it sits level with the item
     card's own middle, held inside the screen's margins. Run every time the
     card's footprint is taken again — a resize, a settle, or the screen
     telling us the page it drew has changed the reading card's height. */
  function levelReadcard() {
    const rc = /** @type {?HTMLElement} */ (root.querySelector("#readcard"));
    if (!rc || !cardRect || previewIdx < 0) return;
    const mid = (cardRect.t + cardRect.b) / 2;
    const cs = getComputedStyle(lanesEl);
    const top = parseFloat(cs.getPropertyValue("--rc-top")) || 84;
    const bottom = parseFloat(cs.getPropertyValue("--rc-bottom")) || 16;
    const avail = lanesEl.clientHeight - top - bottom;
    const h = Math.min(rc.offsetHeight, avail);
    const y = Math.max(top, Math.min(Math.round(mid - h / 2), top + avail - h));
    rc.style.setProperty("--rc-y", y + "px");
  }

  /** The seat's own hit — buildSeats's only child of #seats > g.seat — or
   *  null once it has left the manifest (paintMembers's precedent). */
  /** @param {number} i @returns {?SVGGElement} */
  const hitAt = (i) => /** @type {?SVGGElement} */ (seatsG.children[i]?.firstChild ?? null);

  /**
   * A paper pressed. The item at the apex does not move — only the reading
   * lane opens, on the paper's own side (owner-decisions.md §18: "a document
   * is never the centred body").
   *
   * @param {number} i
   */
  function openDoc(i) {
    const b = bodies[i];
    if (b.kind !== "doc" || previewIdx === i) return;
    if (previewIdx >= 0) hitAt(previewIdx)?.classList.remove("open");
    previewIdx = i;
    hitAt(i)?.classList.add("open");
    onOpenPreview(b.doc, sideOf(i), api);
  }

  /** Closes the reading card, if one is open. Esc and dead space both call
   *  this from the screen; so does the belt itself the moment the apex it
   *  belonged to leaves — a paper still folded inside its item cannot be
   *  the thing a reading card is open on. */
  function closeDoc() {
    if (previewIdx < 0) return;
    hitAt(previewIdx)?.classList.remove("open");
    previewIdx = -1;
    onClosePreview(api);
  }

  /* ==================================================================== *
   * The roll — one motion, 420ms, v2's choreography exactly:
   *
   *   0ms    the belt starts turning. The card, which IS the apex body,
   *          leaves with it: it slides along the band in the direction of
   *          travel (dipping as the band dips away from the apex), shrinking
   *          toward body size and fading — collapsing back into its rock. The
   *          outgoing item's papers fold back into it over the first 170ms.
   *   ~190ms the rock it collapsed into has faded up at the seat the card
   *          slid toward; the card's content swaps out of sight.
   *   190ms  the arriving body's rock is gone and the new card blooms out of
   *          it, riding IN from the opposite side along the band. The berth
   *          has been widening the whole way if the arriving item has papers.
   *   ~240ms the arriving item's papers unfold into the berth beside it.
   *   420ms  the belt settles; the card is seated at the apex — the arriving
   *          body's jumble having eased out to nothing on the way in, so it
   *          lands on the pin and not near it.
   *
   * Under reduced motion the same thing happens with no tween: the belt is
   * simply already turned, the card is simply already the new one, and the
   * papers are simply already out.
   * ==================================================================== */
  /** @param {number} i the seat to roll to */
  function centre(i) {
    if (i === selected || i < 0 || i >= bodies.length) return;
    /* #1088: the apex is leaving the item any open paper belongs to, so its
       reading card cannot stay out — a paper still folded inside its item
       is not somewhere a reading card can be open on. */
    closeDoc();
    const dir = Math.sign(bodies[i].off - bodies[selected].off) || 1;
    prevSel = selected; selected = i;
    rollFrom = roll; rollTo = bodies[selected].off; rollT0 = performance.now();
    bloomFrom = bloom.slice(); bloomTo = bloomTargetsOf(bodies, selected, manifest.length);
    berthFrom = berthNow; berthTo = berthFor(bodies, selected, manifest.length);
    onSelect(selected, api);
    markEnds();                       /* #1062: an end just got nearer, or ran out */

    clearTimeout(swapTimer);
    if (reduced()) {
      roll = rollTo; rollT0 = -1; berthNow = berthTo;
      bloom = bloomFrom = bloomTo.slice();
      onSwap(selected, api);                       /* DEVIATION 1: Svelte's card */
      paintMembers(1); measureCard(); paintBand();
      onSettle(selected, api);
      return;
    }
    /* The card leaves the apex the way the belt leaves it: along the band. */
    const outDx = dir > 0 ? -300 : 300, outDy = dir > 0 ? geom.DIP_L : geom.DIP_R;
    wrap.classList.remove("rollin", "rollpre");
    wrap.classList.add("rollout");
    wrap.style.setProperty("--cdx", outDx + "px");
    wrap.style.setProperty("--cdy", outDy.toFixed(1) + "px");
    wrap.style.setProperty("--csc", "0.5");
    swapTimer = setTimeout(() => {
      onSwap(selected, api);
      wrap.classList.remove("rollout");
      wrap.classList.add("rollpre");
      wrap.style.setProperty("--cdx", (dir > 0 ? 300 : -300) + "px");
      wrap.style.setProperty("--cdy", (dir > 0 ? geom.DIP_R : geom.DIP_L).toFixed(1) + "px");
      void wrap.offsetWidth;                       /* commit the pre-state */
      wrap.classList.remove("rollpre");
      wrap.classList.add("rollin");
      wrap.style.removeProperty("opacity");
      wrap.style.setProperty("--cdx", "0px");
      wrap.style.setProperty("--cdy", "0px");
      wrap.style.setProperty("--csc", "1");
      setTimeout(() => { measureCard(); onSettle(selected, api); }, 240);
    }, 190);
  }

  /* Arriving from elsewhere — a manifest row on home, a filed lane in the
     inbox, a link in a reminder. THE BELT IS THE ITEM SCREEN, so there is no
     navigation to play: the page is simply already showing that item at the
     apex, papers out, with its neighbours in time around it. Same code path a
     fresh load takes. */
  /** @param {string} id the body to seat at the apex */
  function arriveAt(id) {
    const i = bodies.findIndex((b) => b.id === id);
    if (i < 0) return;
    closeDoc();
    clearTimeout(swapTimer);
    selected = prevSel = i; rollT0 = -1;
    roll = rollFrom = rollTo = bodies[i].off;
    bloomTo = bloomTargetsOf(bodies, i, manifest.length);
    bloom = bloomFrom = bloomTo.slice();
    berthNow = berthFrom = berthTo = berthFor(bodies, i, manifest.length);
    wrap.classList.remove("rollout", "rollin", "rollpre");
    wrap.style.removeProperty("opacity");
    wrap.style.setProperty("--cdx", "0px"); wrap.style.setProperty("--cdy", "0px");
    wrap.style.setProperty("--csc", "1");
    onSelect(selected, api); onSwap(selected, api);
    markEnds();                       /* #1062 */
    paintMembers(1); measureCard(); paintBand();
    onSettle(selected, api);
  }

  /* ==================================================================== *
   * The loop. The rubble drifts; the members do not — they are the
   * instrument, held at their seats the way §14 holds the dial's
   * constellations still because there they mean something. Everything else
   * in this sky is scenery, and scenery moves.
   * ==================================================================== */
  /** @param {number} now the frame's own timestamp */
  function frame(now) {
    if (!alive) return;
    const dt = last ? Math.min((now - last) / 1000, 0.08) : 0;
    last = now;
    const rolling = rollT0 >= 0;
    if (rolling) {
      const p = clamp01((now - rollT0) / GLIDE);
      const e = ease(p);
      roll = rollFrom + (rollTo - rollFrom) * e;
      berthNow = berthFrom + (berthTo - berthFrom) * e;
      paintMembers(p);
      if (p >= 1) { rollT0 = -1; bloomFrom = bloom.slice(); }
    }
    drift += DRIFT * dt;
    /* The roll gets every frame it can have. The idle drift is fifteen pixels
       a second and does not: repainting a full-width plate under the card's
       backdrop blur sixty times a second to move it a quarter of a pixel is
       work nobody can see. */
    if (rolling || now - lastPaint > 30) { paintBand(); lastPaint = now; }
    raf = requestAnimationFrame(frame);
  }

  function layout() {
    /* #1088: a resize rebuilds the seat list below (GAP_SCALE can move with
       width), which invalidates `previewIdx` as an index — simplest and
       safest is to close the reading card rather than risk it reopened on
       the wrong paper. Rare in practice (rotating a phone mid-preview). */
    closeDoc();
    const wasSel = bodies[selected]?.id ?? selectedId;
    geom = geometryOf(window.innerWidth, window.innerHeight);
    buildBodies();                    /* GAP_SCALE may have moved with W */
    const i = bodies.findIndex((b) => b.id === wasSel);
    if (i >= 0) {
      selected = prevSel = i;
      bloomTo = bloomTargetsOf(bodies, i, manifest.length);
      bloom = bloomFrom = bloomTo.slice();
      berthNow = berthFrom = berthTo = berthFor(bodies, i, manifest.length);
    }
    buildSeats();
    sizeCanvas(); readTones(); buildHaze(); buildBand();
    if (rollT0 < 0) roll = rollFrom = rollTo = bodies[selected]?.off ?? 0;
    membersSvg.setAttribute("viewBox", `0 0 ${geom.W} ${geom.H}`);
    buildEnds();
    wrap.style.top = geom.APEX_Y + "px";
    const cardw = cardWidthOf(geom);
    wrap.style.width = cardw + "px";
    /* #1088: the reading lane's own width is a CSS calc off this — the
       mockup's --readw, unchanged — so only the card's own width has to be
       handed over. */
    lanesEl.style.setProperty("--cardw", cardw + "px");
    onSelect(selected, api); onSwap(selected, api);
    paintMembers(rollT0 < 0 ? 1 : 0);
    measureCard(); paintBand();
    onSettle(selected, api);
  }

  const onResize = () => layout();
  window.addEventListener("resize", onResize);

  layout();
  if (!reduced()) raf = requestAnimationFrame(frame);

  /* Object.assign hands its target back, so this is the same object every
     callback above was already given — now wearing its controls. */
  return Object.assign(api, {
    centre,
    /** @param {string} id */
    centreById(id) {
      const i = bodies.findIndex((b) => b.id === id);
      if (i >= 0) centre(i);
    },
    arriveAt,
    /**
     * The search dims in place: the belt keeps its shape, so nothing is
     * rebuilt — only the weight of every body changes.
     *
     * @param {string} next
     * @param {Set<number>} found
     */
    setQuery(next, found) {
      query = next.trim().toLowerCase();
      matches = found;
      paintMembers(rollT0 < 0 ? 1 : 0);
    },
    openDoc,
    closeDoc,
    /* The card is the screen's to render, so the band cannot measure its
       footprint until the screen says it is there. One call: take the
       rectangle, then lay the rubble down around it. */
    remeasure() {
      measureCard();
      paintBand();
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      clearTimeout(swapTimer);
      window.removeEventListener("resize", onResize);
    },
  });
}
