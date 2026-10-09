/**
 * THE FILM'S VOCABULARY (#866).
 *
 * The ratified mockup (design/v19/tour/round-5/f-one-take.html) writes its
 * twelve chapters in a small, fixed set of words: `setBg`, `veil`, `ctl`,
 * `mkHl`, `mkCut`, `goto`, `press`, `tap`, `typeInto`, `unlight`, `callout`,
 * `travel`. This module is those words again, against the real product — all
 * but `tap`, which no chapter ever called; removed rather than kept live for
 * a caller that does not exist (#1151 W3-Q7). A reader can hold the mockup
 * beside a chapter file here and follow both.
 *
 * `wear` is the one word here the mockup has no name for: it drove its dawn
 * chapter off a `dawnPack` flag that picked a different screenshot. The
 * product has real packs, so the film wears one — and takes it off again.
 *
 * THE WHOLE TRANSLATION, in one line: the mockup drives background PNGs at
 * hard-coded pixel coordinates; the product drives real routes and real DOM
 * elements named by selector. `setBg("home-empty.png")` becomes
 * `setScreen("/home")`. `ctl({ pt: [405, 314], hl: mkHl(390, 150, 500, 500) })`
 * becomes `ctl({ sel: ".dial", round: true })`. Coordinates become selectors;
 * every geometry the film needs is MEASURED from the live element instead of
 * written down, so a screen that moves takes the film with it.
 *
 * WHAT `mkCut` BECOMES: nothing. The mockup fakes a lit control by pasting a
 * rectangle cropped from the same screenshot on top of a dark sheet, because
 * it has no product underneath — only a picture of one. Here the lit control
 * IS the real element, in the real document, and the veil is cut away from
 * over it (veil.js's masked hole). So there is no cut to make: `goto`ing a
 * control lights it, which punches the hole, and `unlight` closes it again.
 * A chapter never mentions holes at all.
 *
 * WHAT `mkHl` BECOMES: the ring this module draws around the measured
 * element, rather than at a written-down rectangle. It is grown onto the
 * control by `goto` out of the travelling dot, which is round 3's Lift
 * mechanic and the reason no pointer is ever drawn: the control itself
 * rises, glows and presses.
 *
 * THE LIT ELEMENT IS NEVER CLASSED. Same rule veil.js states and for the
 * same reason — `emphasis.js`'s `.lit` already collides with `home.css:495`
 * and is zeroed outright at `create.css:221`. The lift is applied as inline
 * style and the element's own inline values are saved and put back exactly,
 * so the film leaves the product's DOM as it found it.
 *
 * DRY MODE. The transport must know where every chapter starts before a
 * single frame plays, and gets it by running the whole film once against a
 * stopped clock (clock.js's dry mode). The chapters cannot branch on that —
 * a chapter that measured differently from the way it plays would put the
 * ticks in the wrong place — so every word below stubs ITSELF out when the
 * clock is dry, taking exactly the same waits and touching no DOM at all.
 * A chapter reads identically in both modes because it never knows.
 *
 * REDUCED MOTION is clock.js's split, used here: `w()` for movement, which
 * goes to nothing, and `hold()` for reading, which does not. Round 5's rule
 * verbatim — reading time is not motion — and the whole of why the film
 * measures 3:41 normally and 2:07 reduced.
 */
import { hideVeil, refreshVeil, showVeil, veilTargets } from "./veil.js";

/**
 * The film's timings, verbatim from the mockup's own `T`. Motion values are
 * spent through `w()` and vanish under reduced motion; the three `hold*`
 * values are reading and do not.
 */
export const T = {
  cross: 350,          /* screen change */
  /* ONE MOVE, ONE BEAT. The mockup prices a move by its length
     (`travelBase + 0.6 * distance`) because its coordinates are constants it
     can measure in the dry run. The product cannot: a distance is not known
     until the screen is in front of the reader, and every chapter's tick has
     to be placed BEFORE a frame plays. Pricing a move by a length the
     measurement could not see would drift the played film away from the
     ticks by seconds over twelve chapters -- so a move takes one beat
     whatever it covers, and the dot simply flies faster across a longer gap.
     There is deliberately no per-pixel term to reach for. */
  travelBase: 500,
  ease: "cubic-bezier(.25,.1,.25,1)",
  hover: 350,          /* a human hovers before clicking */
  press: 120,          /* pressed control to .96 and back */
  grow: 200,           /* the dot becomes the control's outline */
  lift: 300,           /* the control rises 2px */
  typeLead: 300,
  typeChar: 70,
  field: 600,          /* between fields in the drawer */
  calloutIn: 120,
  calloutOut: 180,
  holdBase: 1000,
  holdWord: 350,
  holdMin: 2400,
  bloom: 600,
  scroll: 600,
  rmHold: 1200,        /* reduced motion: a state with nothing to read */
  /* #1083: a kit Sheet's rise and fold, matching --p-rise (tokens.css). Priced
     here so a pocket chapter can charge the beat the same way it prices any
     other motion, while open()/close() themselves cost the film nothing (they
     wait on the real DOM, not the clock — see vocabulary.js's own note). */
  sheet: 300,
};

/** The mockup's default corner. */
const DEFAULT_RADIUS = 14;
/** The lift's own rise (applyLift/press) — how far a 2px translateY reaches
 *  up, and so how much clearance `clipped()` checks for (Addendum A). */
const LIFT_PX = 2;
/** Above veil.js's sheet (2000), which reserves this headroom by name. */
const Z_CHROME = 2100;
/** A ring fading out once its control is unlit — the veil's own hole
 *  closes over the same 180ms (veil.js's HOLE_MS). */
const RING_OUT_MS = 180;
const CHROME_ID = "orbit-tour-film";
/** Kept clear at the foot of the screen so a callout never lands under the
 *  transport, as the mockup keeps its own bottom 60 stage pixels clear. */
const TRANSPORT_LANE = 60;
const CALLOUT_GAP = 18;
const CALLOUT_EDGE = 16;

/* ---- #1083: the pocket's own callout geometry --------------------------
   §3.2 of the pocket build notes. The pocket has no fixed CALLOUT_EDGE: the
   gutter is the product's own `--p-gutter` (16px at 390, 12px at 360), the
   top limit is the real top chrome's measured bottom (`.p-chrome`, 56px +
   safe area) and the bottom limit is the transport's OWN measured rect
   wherever it currently stands, never a written-down lane. */
const POCKET_CHROME_FALLBACK = 56;
const POCKET_CALLOUT_MARGIN = 8;
const POCKET_MAX_WIDTH = 300;

/** How long a line is held: the mockup's `holdFor`, word for word.
 *  @param {string} text */
export function holdFor(text) {
  const words = text.trim().split(/\s+/u).length;
  return Math.max(T.holdMin, T.holdBase + T.holdWord * words);
}

/** A selector the film names but the product does not render. Loud on
 *  purpose: a chapter that lights nothing is worse than one that stops. */
export class TourControlMissing extends Error {
  /** @param {string} selector */
  constructor(selector) {
    super(`Tour film: no element matches "${selector}"`);
    this.name = "TourControlMissing";
    this.selector = selector;
  }
}

/**
 * @typedef {object} ControlSpec
 * @property {string} sel                 what to light, press and cut the veil around
 * @property {string} [ring]              what the RING wraps, when that is not `sel`
 *   itself -- round 6's chapter 8 lifts an end-cap by its hit box
 *   (`rect.endtarget`) while the press belongs to the 9.5px ink inside it.
 * @property {boolean} [all]              light every match, not just the first
 * @property {boolean} [round]            a circular ring and a circular hole
 * @property {number} [pad]               grown this far outside the element
 * @property {number} [radius]            corner, when not round
 * @property {boolean} [optional]         may legitimately match nothing
 * @property {boolean} [ringless]         (#1083 §3.5) `light()` cuts the
 *   veil's hole and lifts nothing, drawing no ring — round 8's cut-out for an
 *   open sheet's own panel, which stays bright while a row inside it is ringed.
 * @property {boolean} [visible]          (#1174) keep only the matches a
 *   reader can see: a box inside the viewport, and nothing faded to nothing
 *   by its own or an ancestor's opacity. The pocket's strips and belts keep
 *   scenery in the DOM — chips scrolled off the strip, captions of papers
 *   that have rolled off the sky at opacity 0 — and a ring drawn round
 *   scenery is a spotlight on nothing.
 *
 * @typedef {object} Control
 * @property {string} sel
 * @property {Element[]} els              what is lit and pressed
 * @property {Element[]} ringEls          what the ring is measured from
 * @property {boolean} round
 * @property {number} pad
 * @property {number} radius
 * @property {boolean} ringless
 * @property {HTMLDivElement[]} rings
 * @property {boolean} lifted
 * @property {{ el: Element, transform: string, filter: string, transition: string, flat?: boolean, svgPos?: boolean }[]} saved
 */

/** @typedef {[number, number]} Point */

/** Cancels an element's running animations, where the engine has the Web
 *  Animations API to ask. Guarded because the film's movement is decoration
 *  over state that is always set directly as well: an engine without WAAPI
 *  should show the film arriving at each state without the move between,
 *  which is what reduced motion shows too — never an exception.
 *  @param {Element} el */
function cancelAnimations(el) {
  if (typeof el.getAnimations !== "function") return;
  for (const animation of el.getAnimations()) animation.cancel();
}

/** `style` for the elements that have one, which is both of the kinds the
 *  film ever lifts: HTML controls and the sky's SVG.
 *  @param {Element} el
 *  @returns {CSSStyleDeclaration | null} */
function styleOf(el) {
  if (el instanceof HTMLElement || el instanceof SVGElement) return el.style;
  return null;
}

/** The union of several elements' boxes, in viewport coordinates.
 *  @param {Element[]} els
 *  @param {number} pad */
function boxOf(els, pad = 0) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of els) {
    const box = el.getBoundingClientRect();
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  if (left === Infinity) return { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 };
  return {
    x: left - pad,
    y: top - pad,
    w: right - left + pad * 2,
    h: bottom - top + pad * 2,
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
  };
}

/** A point on a box's named side -- the midpoint of that edge.
 *  @param {{x:number,y:number,w:number,h:number,cx:number,cy:number}} box
 *  @param {"left"|"right"|"top"|"bottom"} side
 *  @returns {Point} */
function edgeOf(box, side) {
  if (side === "left") return [box.x, box.cy];
  if (side === "right") return [box.x + box.w, box.cy];
  if (side === "top") return [box.cx, box.y];
  return [box.cx, box.y + box.h];
}

/** The quadratic the dot flies, as the mockup flies it.
 *  @param {Point} p0 @param {Point} c @param {Point} p1 @param {number} t
 *  @returns {Point} */
function bez(p0, c, p1, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
  ];
}

/**
 * Binds the vocabulary to one document, one clock and one way of navigating.
 * Everything a chapter can do, it does through the object this returns — so
 * a chapter is a pure function of its context and a unit test can hand it a
 * counterfeit one.
 *
 * @param {object} options
 * @param {import("./clock.js").FilmClock} options.clock
 * @param {Document} [options.doc]
 * @param {boolean} [options.pocket] (#1083) the pocket dialect, fixed at
 *   mount (`isPocket()`, decided by the caller — chapters never call
 *   `matchMedia` themselves, they only ever read `ctx.pocket`).
 * @param {() => string} [options.routeOf]
 * @param {(route: string) => Promise<unknown>} [options.navigate]
 * @param {(route: string) => Promise<unknown>} [options.settle] resolves once the screen is really there
 */
export function createFilmContext({
  clock,
  doc = document,
  pocket = false,
  routeOf = () => doc.location.pathname,
  navigate = async () => {},
  settle = async () => {},
}) {
  /** @type {HTMLDivElement | null} */
  let layer = null;
  /** @type {HTMLDivElement | null} */
  let dot = null;
  /** @type {HTMLDivElement | null} */
  let live = null;            /* the callout currently out */
  /** Re-places `live` against its anchor's current box (#1174), when the
   *  callout was pinned to a control rather than a point. @type {(() => void) | null} */
  let livePlace = null;
  /** @type {Control[]} */
  let litControls = [];
  /** @type {Set<Animation>} */
  const filmAnims = new Set();
  /** Where the dot is now, in viewport coordinates. It rests in the middle
   *  of the screen until a chapter's `enter` puts it somewhere. @type {Point} */
  let at = [0, 0];
  let veiled = false;
  let unsubscribe = () => {};

  /** The current run's transcript (round 7, #1097): every non-label
   *  `callout` text, in the order it was spoken, collected while the clock
   *  is dry. The player resets this before each chapter's measuring pass
   *  and reads it back after, so the script the transport draws is the
   *  same words the chapter itself plays — never a second copy to forget.
   *  @type {string[]} */
  let transcriptLines = [];
  /** Every `waitForReal` that ran out (#1174 round 6), for the phone check.
   *  @type {{ selector: string, ms: number, route: string }[]} */
  const waitedOut = [];
  const dry = () => clock.dry();
  const still = () => clock.reduced();

  function centreOfViewport() {
    return /** @type {Point} */ ([window.innerWidth / 2, window.innerHeight / 2]);
  }
  at = centreOfViewport();

  /* ---- the chrome layer: ring, dot and callout all live here ------------
     Built imperatively and styled inline, exactly as veil.js builds its
     sheet, so the film carries no stylesheet of its own into a product that
     has not mounted it yet -- and so every value below is visibly a pack
     token rather than an invented colour. */
  function ensureChrome() {
    if (layer && layer.isConnected) return layer;
    layer = doc.createElement("div");
    layer.id = CHROME_ID;
    /* The words this layer carries live in the script region instead
       (round 7, design/v19/tour/round-7/README.md): a callout is a picture
       that changes on a clock, and a virtual cursor that finds one mid-fade
       has no way to get it back. The script gives a reader every line at
       their own pace, so the layer stays out of the tree rather than
       becoming a trap. */
    layer.setAttribute("aria-hidden", "true");
    /* #1083 §3.7: every element the film mounts on <body> stays pressable
       while a kit sheet is up — focus.js's `inertPage` already skips this
       attribute. Harmless on desk, where no sheet ever inerts the page. */
    layer.setAttribute("data-pocket-above", "");
    layer.style.cssText = [
      "position:fixed",
      "inset:0",
      "pointer-events:none",
      `z-index:${Z_CHROME}`,
    ].join(";");
    doc.body.appendChild(layer);

    dot = doc.createElement("div");
    dot.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:6px",
      "height:6px",
      "margin:-3px 0 0 -3px",
      "border-radius:50%",
      "background:var(--accent)",
      "box-shadow:0 0 10px color-mix(in srgb,var(--accent) 25%,transparent)",
      "opacity:0",
      "transition:opacity .2s ease",
      `z-index:${Z_CHROME + 20}`,
    ].join(";");
    layer.appendChild(dot);
    at = centreOfViewport();
    placeDot(at);
    window.addEventListener("scroll", onViewportChange, { passive: true, capture: true });
    window.addEventListener("resize", onViewportChange);
    return layer;
  }

  /* ---- #1174: the chrome follows the page ------------------------------
     Every mark the film draws — a ring, a typed line, the callout — is a
     fixed box measured once from the element it sits on. The pocket's
     screens scroll under the film (a `goto` scrolls the control into the
     band, chapter 4 scrolls to the manifest, a kit Row opening scrolls to
     itself, and a phone's own browser bar collapsing resizes the viewport),
     and every one of those left the marks where the element WAS: a ring
     floating over the wrong row, typed text over the wrong field. The veil
     already re-measures its holes on scroll and resize (veil.js); this is
     the same loop for the rest of the chrome. One frame at a time, capture
     phase so a scroll inside any scroller is caught, not only the window's. */
  /** @type {number | null} */
  let syncRaf = null;
  function syncChrome() {
    syncRaf = null;
    dropGone();
    for (const c of litControls) syncRings(c);
    for (const { ghost, el } of ghosts) placeGhost(ghost, el);
    if (livePlace) livePlace();
    refreshVeil();
  }
  function onViewportChange() {
    if (syncRaf !== null || typeof requestAnimationFrame !== "function") return;
    syncRaf = requestAnimationFrame(syncChrome);
  }
  /* And on every frame the film paints (clock.js's painters run whether the
     film is playing or paused, driven by the transport's loop): an element
     can move without any scroll — the belt turns to bring a pressed paper
     to its apex and its captions cross the screen; a row unfolds above a
     lit control — and the marks must go with it, as chapters 5, 9 and 12
     already keep their ring on a body they move themselves. Cheap: a few
     boxes measured, and nothing repainted unless one changed. */
  const offFrame = clock.onFrame(() => {
    if (dry() || (litControls.length === 0 && ghosts.length === 0 && !live)) return;
    syncChrome();
  });

  /** @param {Point} p */
  function placeDot(p) {
    if (!dot) return;
    cancelAnimations(dot);
    dot.style.transform = `translate(${p[0]}px,${p[1]}px)`;
  }

  /**
   * Every animation the film starts goes through here, so a pause can hold
   * it. Only the FILM's own animations are tracked — the mockup pauses every
   * animation in its document, which it can afford because the document is
   * nothing but the film; the product's sky has animations of its own and
   * the tour has no business stopping them.
   *
   * @param {Element} node
   * @param {Keyframe[]} frames
   * @param {KeyframeAnimationOptions} opts
   */
  function anim(node, frames, opts) {
    if (dry() || still()) return Promise.resolve();
    if (typeof node.animate !== "function") return Promise.resolve();
    const animation = node.animate(frames, opts);
    filmAnims.add(animation);
    if (!clock.playing()) animation.pause();
    const forget = () => filmAnims.delete(animation);
    return animation.finished.then(forget, forget);
  }

  unsubscribe = clock.onPlaying((on) => {
    for (const animation of Array.from(filmAnims)) {
      try {
        if (on) animation.play();
        else animation.pause();
      } catch { /* already finished, already gone */ }
    }
  });

  /* ---- the ring (the mockup's mkHl) ------------------------------------ */

  /** @param {Control} c @param {number} index */
  function ringStyle(c, index) {
    const box = boxOf([c.ringEls[index]], c.pad);
    return [
      "position:fixed",
      `left:${box.x}px`,
      `top:${box.y}px`,
      `width:${box.w}px`,
      `height:${box.h}px`,
      `border-radius:${c.round ? "50%" : `${c.radius}px`}`,
      "opacity:0",
      "pointer-events:none",
      "transition:opacity .45s ease,box-shadow .3s ease",
      "box-shadow:0 0 0 1.5px var(--accent),0 0 0 8px color-mix(in srgb,var(--accent) 18%,transparent),0 0 34px color-mix(in srgb,var(--accent) 35%,transparent)",
    ].join(";");
  }

  /** @param {Control} c */
  function ensureRings(c) {
    if (c.rings.length || dry()) return c.rings;
    const root = ensureChrome();
    c.rings = c.ringEls.map((_, index) => {
      const ring = doc.createElement("div");
      ring.className = "tourfilm-ring";
      ring.style.cssText = ringStyle(c, index);
      root.appendChild(ring);
      return /** @type {HTMLDivElement} */ (ring);
    });
    return c.rings;
  }

  /** Re-measures a lit control's rings against the elements they wrap. The
   *  veil re-measures its own holes on its own loop; this keeps the ring
   *  with them, which is what chapters 5, 9 and 12's travelling body needs.
   *  @param {Control} c */
  function syncRings(c) {
    c.rings.forEach((ring, index) => {
      const box = boxOf([c.ringEls[index]], c.pad);
      ring.style.left = `${box.x}px`;
      ring.style.top = `${box.y}px`;
      ring.style.width = `${box.w}px`;
      ring.style.height = `${box.h}px`;
    });
  }

  /** @param {Control} c @param {"on"|"strong"|"quiet"|"off"} state */
  function ringState(c, state) {
    for (const ring of c.rings) {
      if (state === "off") {
        ring.style.opacity = "0";
        continue;
      }
      ring.style.opacity = "1";
      if (state === "strong") {
        ring.style.boxShadow =
          "0 0 0 1.5px var(--accent),0 0 0 8px color-mix(in srgb,var(--accent) 26%,transparent),0 0 46px color-mix(in srgb,var(--accent) 50%,transparent)";
      } else if (state === "quiet") {
        ring.style.boxShadow = "0 0 0 1.25px var(--accent)";
      }
    }
  }

  /** The veil's holes are exactly the controls currently lit. */
  function applyHoles() {
    if (dry()) return;
    const targets = litControls.flatMap((c) =>
      c.els.map((el) => ({ el, round: c.round, pad: c.pad, radius: c.radius })),
    );
    veilTargets(targets);
  }

  /** @param {Control} c */
  function addLit(c) {
    if (!litControls.includes(c)) litControls.push(c);
    applyHoles();
  }

  /** @param {Control} c */
  function dropLit(c) {
    litControls = litControls.filter((one) => one !== c);
    applyHoles();
  }

  /* ---- the words themselves -------------------------------------------- */

  /**
   * Races a real, unbudgeted wait — already inside a `clock.stall()`, which
   * is the only reason this is safe (below) — against the clock's own
   * cancellation (#1151 W3-R2). `clock.cancel()` only ever settles waits
   * booked through `clock.wait()`: a raw `navigate()`/`settle()` promise or
   * a bare `setTimeout` is invisible to it, so a chapter suspended on one of
   * those used to keep running after Stop or a jump, racing whatever chapter
   * started next (and, for chapter 5's own demo body, keeping it on the
   * real star chart for as long as that race took to resolve on its own —
   * #1151 W3-R1, the same gap under a different name).
   *
   * The guard is `clock.wait(0)`, not a long or infinite one: `wait()`
   * always books its span onto `sched` regardless of `stall()`, so any
   * span here would silently push every wait still to come later than it
   * should be — exactly what `stall()` exists to prevent. Zero costs
   * nothing there. It still cannot fire on its own while stalled, because
   * `advance()` skips its whole waiter-firing pass whenever `stalls > 0`
   * (clock.js) — so for as long as the caller's own `clock.stall()` stays
   * held, this guard only ever settles by `cancel()` rejecting it with
   * CANCEL. Once the stall is released it resolves on the next frame like
   * any other spent wait, which is harmless: the race it was guarding has
   * always long since settled by then. Callers outside a stall must not
   * use this — the guard would race the real wait for real, not stand
   * aside from it.
   *
   * No caller reads the resolved value — every call site is a bare
   * `await cancellable(...)` for the ordering/cancellation alone — so the
   * honest return type is void, not the raced promise's own T: the
   * wait(0) side of the race can legitimately resolve first (undefined),
   * which svelte-check's gate caught as a real type mismatch (#1151
   * W3-R1 W3-R2, this function's own origin). Discarded explicitly
   * (`.then(() => {})`) rather than merely declared away, so the type
   * matches what the function actually ever hands back.
   * @param {Promise<any>} promise
   * @returns {Promise<void>}
   */
  function cancellable(promise) {
    return Promise.race([promise, clock.wait(0)]).then(() => {});
  }

  /**
   * The mockup's `setBg`. A chapter names a real route; the film walks
   * there and waits for the screen to arrive. That wait is REAL time the dry
   * run could not have budgeted for, so the clock is stalled across it — the
   * film does not run on while a slow navigation is in flight.
   *
   * @param {string} route
   */
  async function setScreen(route) {
    if (dry()) return;
    if (routeOf() === route) return;
    /* The fields the film typed over are about to leave with the screen,
       and the room a scroll made below the old one goes with it. */
    dropTyped();
    room(0);
    const release = clock.stall();
    try {
      await cancellable(navigate(route));
      await cancellable(settle(route));
      /* #1174: a kit sheet closing pops its own history entry, and the
         browser delivers that popstate a moment later — sometimes after the
         walk to the next screen has begun, and the router then keeps the
         screen the popstate names. One more walk, once the dust has
         settled, lands where the chapter said. */
      if (routeOf() !== route) {
        await cancellable(new Promise((res) => setTimeout(res, 150)));
        await cancellable(navigate(route));
        await cancellable(settle(route));
      }
    } finally {
      release();
    }
    /* #1174 round 3: every chapter opens a screen at its top, as `clear()`
       resets a jump. A walk from a screen the film had scrolled (chapter
       2's /create, scrolled down to its save bar) let the router's own
       scroll reset run as home's `scroll-behavior:smooth` glide, and
       chapter 3's first line was placed while the dial was still off the
       top of the screen. Instant, so the next beat measures a page that
       has arrived. */
    const win = doc.defaultView;
    if (win && typeof win.scrollTo === "function" && (win.scrollY || 0) > 0) {
      win.scrollTo({ top: 0, behavior: "instant" });
    }
    dropGone();
  }

  /**
   * #1174: a ring belongs to an element. A control left lit into a screen
   * change (chapter 2 leaves the add button lit for chapter 3 to inherit,
   * as the mockup does) has elements that leave with that screen, and its
   * ring outlived them — drawn on the next screen at the old place, or, once
   * the chrome followed the page, shrunk round a 0x0 box. Whatever is lit
   * and no longer in the document is unlit here, as if the chapter had.
   */
  function dropGone() {
    for (const c of litControls.slice()) {
      if (c.els.length === 0 || c.els.some((el) => el.isConnected)) continue;
      for (const ring of c.rings) ring.remove();
      c.rings = [];
      restore(c);
      dropLit(c);
    }
  }

  /**
   * Waits for a selector to actually exist, bounded and unbudgeted (a
   * `clock.stall()`, the same idiom `setScreen`'s own navigation uses) —
   * for the one screen `settle()`'s single tick is not enough for: the
   * pocket's own `/create` renders nothing behind `#pocket-entry` until its
   * own async household read finishes (`routes/create/pocket.svelte`'s
   * `phase`), which is real network time no `tick()` can wait out (#1083,
   * found running chapter 2's pocket cut headless). No-op in dry mode, and
   * costs nothing there.
   *
   * The bound is generous on purpose (#1174): the wait is a stall, so a
   * screen that is there in 200ms costs 200ms, and a phone on a slow link
   * or a busy host that takes six seconds is not a reason to stop the film
   * with "no element matches" — which is what a 4s bound did under load.
   *
   * @param {string} selector
   * @param {number} [timeoutMs]
   */
  async function waitForReal(selector, timeoutMs = 12_000) {
    if (dry() || doc.querySelector(selector)) return;
    const release = clock.stall();
    try {
      const deadline = Date.now() + timeoutMs;
      while (!doc.querySelector(selector) && Date.now() < deadline) {
        /* Cancellable (#1151 W3-R1/W3-R2): up to 12s of raw timers this
           polling loop could otherwise keep running through, unseen by
           clock.cancel(), after Stop or a jump. */
        await cancellable(new Promise((res) => setTimeout(res, 32)));
      }
      /* #1174 round 6: a wait that ran out is the film standing still for
         something that was never coming -- 12 seconds of a frozen clock on
         the reader's screen (chapter 8 on a new household, waiting for a
         belt with nothing on it). Recorded, so the phone check can fail on
         it however fast or slow the host: under the stall budget it looked
         like an honest wait. */
      if (!doc.querySelector(selector)) waitedOut.push({ selector, ms: timeoutMs, route: routeOf() });
    } finally {
      release();
    }
  }

  /** The mockup's `veil`. @param {boolean} on */
  function veil(on) {
    veiled = !!on;
    if (dry()) return;
    if (on) {
      showVeil();
      applyHoles();
    } else {
      hideVeil();
    }
  }

  /**
   * #1174: whether a reader can see this element at all — a non-empty box
   * that touches the viewport, and the element's OWN opacity above nothing
   * (SVG's `opacity` presentation attribute, which the belt sets to 0 on an
   * off-sky caption, reads back through computed style like any other).
   * Its own, deliberately, not its ancestors': a screen still fading in
   * around a control is a control about to be seen, not scenery.
   * @param {Element} el
   */
  function shown(el) {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    if (box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth || box.top >= window.innerHeight) return false;
    if (typeof window.getComputedStyle !== "function") return true;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    return !(parseFloat(cs.opacity) < 0.05);
  }

  /* ---- #1174 round 4: room below the page ----------------------------
     A chapter that scrolls the page to something low on it (chapter 4's
     manifest) can only take it as far as the page's own end. The pocket
     home is barely taller than a phone, so on the owner's iPhone "the page
     scrolls to the manifest" moved it hardly at all: the manifest stayed
     where it was, low on the screen. `room(px)` puts a blank, film-owned
     block of that height after everything on the page, so the scroll can
     land where the chapter means; `room(0)` takes it away, as do `clear()`
     and every screen change, so the page is left as it was found. */
  /** @type {HTMLElement | null} */
  let roomEl = null;
  /** @param {number} px */
  function room(px) {
    if (dry()) return;
    const h = Math.max(0, Math.ceil(px));
    if (h === 0) {
      roomEl?.remove();
      roomEl = null;
      return;
    }
    if (!roomEl || !roomEl.isConnected) {
      roomEl = doc.createElement("div");
      roomEl.className = "tourfilm-room";
      roomEl.setAttribute("aria-hidden", "true");
      doc.body.appendChild(roomEl);
    }
    roomEl.style.cssText = `display:block;height:${h}px;margin:0;padding:0;pointer-events:none`;
  }

  /**
   * The mockup's `ctl`, with a selector where it had a rectangle. Resolves
   * NOW, against the live document, and says so loudly when the product does
   * not render what the film named — the failure a coordinate could never
   * have: a chapter silently lighting nothing.
   *
   * @param {ControlSpec | string} spec
   * @returns {Control}
   */
  function ctl(spec) {
    const s = typeof spec === "string" ? { sel: spec } : spec;
    const round = s.round ?? false;
    const pad = s.pad ?? 0;
    const radius = s.radius ?? DEFAULT_RADIUS;
    const ringless = s.ringless ?? false;
    if (dry()) {
      return { sel: s.sel, els: [], ringEls: [], round, pad, radius, ringless, rings: [], lifted: false, saved: [] };
    }
    let els = s.all
      ? Array.from(doc.querySelectorAll(s.sel))
      : [doc.querySelector(s.sel)].filter((el) => el !== null);
    if (s.visible) {
      els = (s.all ? els : Array.from(doc.querySelectorAll(s.sel))).filter(shown);
      if (!s.all) els = els.slice(0, 1);
    }
    if (els.length === 0 && !s.optional) throw new TourControlMissing(s.sel);
    const ringEls = s.ring
      ? Array.from(doc.querySelectorAll(s.ring))
      : els;
    return { sel: s.sel, els, ringEls, round, pad, radius, ringless, rings: [], lifted: false, saved: [] };
  }

  /** Lights controls without travelling to them — the mockup turning several
   *  `.hl`s on at once, as chapter 1 does for the four outer suns. A
   *  `ringless` control (#1083 §3.5) only cuts the veil's hole: no ring is
   *  drawn and nothing is lifted — round 8's cut-out for an open sheet's own
   *  panel, kept bright while a row inside it is ringed separately.
   *  @param {...Control} controls */
  function light(...controls) {
    if (!dry()) dropGone();
    for (const c of controls) {
      if (dry() || c.els.length === 0) continue;
      if (!c.ringless) {
        ensureRings(c);
        syncRings(c);
        ringState(c, "on");
      }
      addLit(c);
    }
  }

  /**
   * Addendum A (2026-09-30, #1083): true when a 2px rise would leave an
   * ancestor that hides or scrolls its overflow — a kit Row's
   * `overflow:clip` (sized exactly to its face), a sheet body's `auto`.
   * Runtime detection rather than a per-control flag, so it applies
   * wherever the film later lights a clipped control without a chapter
   * needing to know.
   * @param {Element} el
   */
  function clipped(el) {
    if (typeof window.getComputedStyle !== "function") return false;
    const r = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== doc.body; node = node.parentElement) {
      const cs = window.getComputedStyle(node);
      if (cs.overflowY === "visible" && cs.overflowX === "visible") continue;
      const box = node.getBoundingClientRect();
      if (r.top - LIFT_PX < box.top + 0.5) return true;
    }
    return false;
  }

  /**
   * Addendum B (#1174, chapter 8's fault A): true for an SVG element whose
   * OWN `transform` attribute is its real position — the pocket belt's
   * `.capseat` groups, painted every frame by `translate(x,y)` on that very
   * attribute. The CSS `transform` PROPERTY a lift or a press would set
   * does not compose with that attribute; it replaces it outright (the CSS
   * Transforms spec's own rule), so the control snaps to roughly (0,0) in
   * its SVG's own coordinate space for as long as it stays lit — which
   * rendered as a ring on "checklist.pdf" sitting over the back link
   * instead of on the paper it names. Detected at runtime, the same way
   * `clipped()` finds a control a lift would show cut, rather than asking
   * every chapter to know which controls move themselves this way.
   * @param {Element} el
   */
  function svgPositioned(el) {
    return el instanceof SVGElement && el.hasAttribute("transform");
  }

  /** @param {Control} c */
  function applyLift(c) {
    if (dry() || c.lifted) return;
    c.lifted = true;
    for (const el of c.els) {
      const style = styleOf(el);
      if (!style) continue;
      const flat = clipped(el);
      const svgPos = svgPositioned(el);
      c.saved.push({
        el,
        transform: style.transform,
        filter: style.filter,
        transition: style.transition,
        flat: flat || svgPos,
        svgPos,
      });
      style.transition = still() ? "none" : `transform ${T.lift}ms ${T.ease},filter ${T.lift}ms ease`;
      /* Addendum A: the lift yields to a clip — the ring alone says
         "lifted". A translated face that would leave a Row's own clip is a
         control shown cut, and the glow is invisible inside the clip
         anyway, so nothing is lost but 2px of movement nobody can see.
         Addendum B: it yields the same way to its own position. */
      if (flat || svgPos) continue;
      style.transform = "translateY(-2px)";
      style.filter = "drop-shadow(0 0 14px color-mix(in srgb,var(--accent) 34%,transparent))";
    }
  }

  /** Puts back exactly the inline values the element had. @param {Control} c */
  function restore(c) {
    for (const { el, transform, filter, transition } of c.saved) {
      const style = styleOf(el);
      if (!style) continue;
      style.transform = transform;
      style.filter = filter;
      style.transition = transition;
    }
    c.saved = [];
    c.lifted = false;
  }

  /**
   * The mockup's `travel`: the 6px dot flies a gentle arc to where it is
   * going. It is not a pointer and never becomes one — `growInto` turns it
   * into the control's own outline the moment it arrives, which is the whole
   * Lift mechanic.
   *
   * @param {Point | Control} to
   * @param {number} [dur]
   */
  async function travel(to, dur) {
    dropCallout();
    /* A control the product legitimately does not render (`optional`) still
       costs the film its beat -- the budget must not depend on the data --
       but the dot has nowhere to go, so it stays where it is. */
    if (!Array.isArray(to) && to.els.length === 0) return clock.w(dur ?? T.travelBase);
    const target = Array.isArray(to) ? to : /** @type {Point} */ ([boxOf(to.ringEls, to.pad).cx, boxOf(to.ringEls, to.pad).cy]);
    const from = /** @type {Point} */ ([at[0], at[1]]);
    const distance = Math.hypot(target[0] - from[0], target[1] - from[1]);
    const ms = dur ?? T.travelBase;
    at = [target[0], target[1]];
    if (dry()) return clock.w(ms);
    ensureChrome();
    if (dot) dot.style.opacity = "1";
    if (still() || distance < 0.5) {
      placeDot(at);
      return clock.w(ms);
    }
    /* the control point sits 12% of the distance off the chord */
    const nx = -(target[1] - from[1]) / distance;
    const ny = (target[0] - from[0]) / distance;
    /** @type {Point} */
    const control = [
      (from[0] + target[0]) / 2 + nx * distance * 0.12,
      (from[1] + target[1]) / 2 + ny * distance * 0.12,
    ];
    /** @type {Keyframe[]} */
    const frames = [];
    for (let i = 0; i <= 32; i++) {
      const p = bez(from, control, target, i / 32);
      frames.push({ transform: `translate(${p[0]}px,${p[1]}px)` });
    }
    if (dot) {
      cancelAnimations(dot);
      void anim(dot, frames, { duration: ms, easing: T.ease, fill: "forwards" });
    }
    return clock.w(ms);
  }

  /** The mockup's `growInto`: the dot becomes the control's outline.
   *  @param {Control} c */
  async function growInto(c) {
    if (dry() || c.els.length === 0) return clock.w(T.grow);
    ensureRings(c);
    syncRings(c);
    ringState(c, "on");
    addLit(c);
    if (!still()) {
      const seed = /** @type {Point} */ ([at[0], at[1]]);
      c.rings.forEach((ring, index) => {
        const box = boxOf([c.ringEls[index]], c.pad);
        void anim(ring, [
          {
            left: `${seed[0] - 3}px`,
            top: `${seed[1] - 3}px`,
            width: "6px",
            height: "6px",
            borderRadius: "50%",
          },
          {
            left: `${box.x}px`,
            top: `${box.y}px`,
            width: `${box.w}px`,
            height: `${box.h}px`,
            borderRadius: ring.style.borderRadius,
          },
        ], { duration: T.grow, easing: T.ease });
      });
    }
    if (dot) dot.style.opacity = "0";
    return clock.w(T.grow);
  }

  /** The top chrome's measured bottom edge (`.p-chrome`, #1083 §3.1/§3.2):
   *  56px plus the safe area when the real element is mounted, the fixed
   *  fallback when it is not (the pocket's own `--p-chrome` token). */
  function chromeBottom() {
    const chrome = doc.querySelector(".p-chrome");
    return chrome ? chrome.getBoundingClientRect().bottom : POCKET_CHROME_FALLBACK;
  }

  /** The vertical band a pocket control or callout must stay inside: below
   *  the top chrome, above wherever the transport currently stands (its own
   *  measured rect when mounted, `TRANSPORT_LANE` at the foot when not —
   *  #1083 §3.1/§3.2, both read the pill "wherever it is").
   *
   *  When the pill is docked to the TOP (transport.js's own `.top`, while a
   *  kit sheet is up), its rect sits near the chrome, not the foot — using
   *  it as the band's lower limit there would put the limit above the top,
   *  an inside-out band for whatever the sheet holds. The band's floor falls
   *  back to the viewport's own foot in that case, same as before the pill
   *  ever mounts. */
  function pocketBand() {
    const bar = doc.getElementById("orbit-tour-transport");
    const pill = bar && !bar.classList.contains("top") ? bar.getBoundingClientRect() : null;
    return { top: chromeBottom(), bottom: pill ? pill.top : window.innerHeight - TRANSPORT_LANE };
  }

  /** #1083 §3.1: on the pocket, `goto` scrolls the control into view first
   *  when its ring box does not sit wholly inside `pocketBand()` — nothing on
   *  desk scrolls. One animation frame is waited under `clock.stall()`, the
   *  same idiom `setScreen` uses for a navigation the dry run could not have
   *  budgeted for, so the film's measured length is untouched.
   *  @param {Control} c */
  async function scrollIntoBand(c) {
    if (!pocket || dry() || c.els.length === 0) return;
    const box = boxOf(c.ringEls, c.pad);
    const band = pocketBand();
    if (box.y >= band.top && box.y + box.h <= band.bottom) return;
    const release = clock.stall();
    try {
      /* "instant", never "auto" (#1174): home's own `html{scroll-behavior:
         smooth}` makes "auto" a smooth scroll that is still travelling when
         the control is measured a frame later, so the ring and the dot land
         where the control WAS. The film's travel is the motion here; the
         page simply needs to be there. */
      c.els[0].scrollIntoView({ block: "center", behavior: "instant" });
      /* A plain timer, not requestAnimationFrame: this wait is only about
         giving the scroll a moment to land, not about a paint. Cancellable
         (#1151 W3-R1/W3-R2) for the same reason setScreen's own real waits
         are: a bare setTimeout is invisible to clock.cancel(). */
      await cancellable(new Promise((res) => setTimeout(res, 16)));
    } finally {
      release();
    }
  }

  /**
   * The mockup's `goto`: travel, become the control's outline, and lift it.
   * @param {Control} c
   * @param {{ willPress?: boolean }} [o]
   */
  async function goto(c, o = {}) {
    /* #1174: a screen the PRODUCT changed under the film (a body's own tap
       flying to its item, pocket.svelte's `tapBody`) is not a `setScreen`,
       so whatever was lit on the old screen is dropped at the next word
       that draws — its element is gone with the screen. */
    if (!dry()) dropGone();
    await scrollIntoBand(c);
    await travel(c);
    await growInto(c);
    applyLift(c);
    if (!dry()) ringState(c, "strong");
    await clock.w(T.lift);
    if (o.willPress !== false) await clock.w(T.hover);
  }

  /** The mockup's `press`: the control presses ITSELF. @param {Control} c */
  async function press(c) {
    if (!dry() && !still()) {
      for (const el of c.els) {
        const saved = c.saved.find((s) => s.el === el);
        /* Addendum B: an SVG element positioned by its own `transform`
           attribute cannot take even `translate(0,0)` as a squash base —
           that is still an inline `transform` PROPERTY, which overrides the
           attribute exactly as the lift's own did (see `svgPositioned`).
           No press animation plays for it; the ring and the clock cost are
           the whole of this beat for a control that moves itself. */
        if (saved?.svgPos) continue;
        /* Addendum A: a lifted-but-clipped element never actually moved
           (applyLift left it flat), so its press must not either — reading
           a per-element flag rather than `c.lifted` alone. */
        const flat = saved?.flat;
        const base = c.lifted && !flat ? "translateY(-2px)" : "translate(0,0)";
        const style = styleOf(el);
        if (style) style.transition = "none";
        void anim(el, [
          { transform: `${base} scale(1)` },
          { transform: `${base} scale(.96)` },
          { transform: `${base} scale(1)` },
        ], { duration: T.press * 2, easing: "ease-in-out" });
      }
    }
    await clock.w(T.press * 2);
  }

  /** A ring put out (#1174 round 3): faded, as it was faded in, rather
   *  than deleted between one frame and the next — a ring blinking out as
   *  the hole under it closes is the flash the owner's phone showed every
   *  time the film moved on. Gone at once under reduced motion.
   *  @param {HTMLElement} ring */
  function retireRing(ring) {
    if (still()) { ring.remove(); return; }
    ring.style.transition = `opacity ${RING_OUT_MS}ms ease`;
    ring.style.opacity = "0";
    setTimeout(() => ring.remove(), RING_OUT_MS + 40);
  }

  /** The mockup's `unlight`. @param {...Control} controls */
  function unlight(...controls) {
    for (const c of controls) {
      if (dry()) continue;
      ringState(c, "off");
      for (const ring of c.rings) retireRing(ring);
      c.rings = [];
      restore(c);
      dropLit(c);
    }
  }

  /** Leaves the ring on at the quiet tier — a chip that has been chosen and
   *  keeps a thin ring once the film moves on. @param {Control} c */
  function quiet(c) {
    if (dry()) return;
    ringState(c, "quiet");
    restore(c);
  }

  /* ---- typing (the mockup's typeInto) ----------------------------------- */

  /** How opaque a computed colour is: 0 for none, 1 for a solid one. Reads
   *  the forms engines serialise a computed `background-color` in —
   *  `rgb()`, `rgba()`, and `color(srgb … / a)` for a `color-mix()` — and
   *  takes anything it cannot read for solid, as this cover always did.
   *  @param {string} color */
  function alphaOf(color) {
    if (!color || color === "transparent") return 0;
    const m = /\/\s*([\d.]+)(%?)\s*\)$/u.exec(color) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/u.exec(color);
    if (!m) return 1;
    const a = parseFloat(m[1]);
    return m[2] ? a / 100 : a;
  }

  /** An opaque ground to paint the typed line on, so the cover hides
   *  whatever the real field is showing underneath (`#f-name` shows its
   *  "Name this entry" placeholder, a date input shows its own, every
   *  pocket field its "e.g." suggestion).
   *
   *  #1174 round 4: the field's own background is not enough when it is
   *  see-through. The pocket's fields are 55% of the page colour over the
   *  card (EntryForm.svelte's `.pc-field input`), so a cover in that colour
   *  was 55% opaque, and on the owner's iPhone the field's "e.g. Car MOT"
   *  showed behind the film's "Car MOT — Volvo V60". So the backgrounds are
   *  stacked as the page stacks them — the field's own on top, then each
   *  ancestor's — down to the first solid one, and the browser composites
   *  them exactly as it does the field: the same colour, now solid. Written
   *  as the declarations themselves (`background-color` the solid ground,
   *  `background-image` the see-through layers over it).
   *  @param {Element} el */
  function backdropOf(el) {
    if (typeof window.getComputedStyle !== "function") return "background-color:var(--panel)";
    /** @type {string[]} */
    const layers = [];
    /** @type {Element | null} */
    let node = el;
    while (node) {
      const bg = window.getComputedStyle(node).backgroundColor;
      const alpha = alphaOf(bg);
      if (alpha > 0) layers.push(bg);
      if (alpha >= 1) break;
      node = node.parentElement;
    }
    /* Nothing solid all the way up: the page's own colour is under it all. */
    if (layers.length === 0 || alphaOf(layers[layers.length - 1]) < 1) layers.push("var(--bg)");
    const ground = /** @type {string} */ (layers.pop());
    const over = layers.map((c) => `linear-gradient(${c},${c})`).join(",");
    return `background-color:${ground}${over ? `;background-image:${over}` : ""}`;
  }

  /** Sits a typed ghost exactly over its field's current box (#1174: called
   *  again whenever the page moves under it).
   *  @param {HTMLElement} ghost @param {Element} el */
  function placeGhost(ghost, el) {
    const box = boxOf([el]);
    ghost.style.left = `${box.x}px`;
    ghost.style.top = `${box.y}px`;
    ghost.style.width = `${box.w}px`;
    ghost.style.height = `${box.h}px`;
  }

  /** The film's own text, laid over one field and wearing that field's font.
   *  @param {Element} el
   *  @returns {{ line: HTMLSpanElement, caret: HTMLElement, ghost: HTMLDivElement }} */
  function ghostOver(el) {
    const root = ensureChrome();
    const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(el) : null;
    const ghost = doc.createElement("div");
    ghost.className = "tourfilm-typed";
    ghost.style.cssText = [
      "position:fixed",
      "display:flex",
      "align-items:center",
      "box-sizing:border-box",
      "overflow:hidden",
      "white-space:pre",
      "pointer-events:none",
      backdropOf(el),
      /* The field's own border, so the solid cover still reads as the
         field and the line sits where the field's own text would. */
      `border-style:${style?.borderStyle || "none"}`,
      `border-width:${style?.borderWidth || "0px"}`,
      `border-color:${style?.borderColor || "transparent"}`,
      `padding-left:${style?.paddingLeft || "0px"}`,
      `padding-right:${style?.paddingRight || "0px"}`,
      `font:${style?.font || "13.5px/1.45 var(--ui)"}`,
      `color:${style?.color || "var(--ink)"}`,
      `border-radius:${style?.borderRadius || "0px"}`,
      `z-index:${Z_CHROME + 5}`,
    ].join(";");
    const line = doc.createElement("span");
    const caret = doc.createElement("i");
    caret.style.cssText = [
      "display:inline-block",
      "width:1.5px",
      "height:1.05em",
      "margin-left:1px",
      "background:var(--accent)",
      "vertical-align:text-bottom",
    ].join(";");
    ghost.append(line, caret);
    placeGhost(ghost, el);
    root.appendChild(ghost);
    return { line, caret, ghost };
  }

  /** Every ghost currently on the screen, with the field it sits over, so
   *  the film can take them off and keep them over their fields meanwhile.
   *  @type {{ ghost: HTMLElement, el: Element }[]} */
  let ghosts = [];

  /** Takes the typed text off the screen. The product never had it, so there
   *  is nothing to put back — the ghosts simply go. */
  function dropTyped() {
    for (const { ghost } of ghosts) ghost.remove();
    ghosts = [];
  }

  /**
   * The mockup's `typeInto`: a string appears in a field one character per
   * wait, so a pause stops it mid-word and playing on picks the word up
   * where it was left. `T.typeLead` before the first character, `T.typeChar`
   * between them — the two timings this module has always listed and nothing
   * had spent.
   *
   * IT NEVER TOUCHES THE FIELD. The mockup types into a span it made up,
   * because it has no product underneath. Here there IS a real input, and
   * writing into it would be the one destructive thing the film does:
   * `value` set behind Svelte's back, the app's own input handlers either
   * fired or (worse) left out of step, and an entry half-filled for the
   * reader when the credits roll. So the text is the film's own, painted on
   * the chrome layer over the field's measured box in the field's own font —
   * the same trick as the ring, which draws around an element rather than
   * classing it. `clear()` takes the ghosts off with everything else, and a
   * screen change drops them, because the fields they sat over are gone.
   *
   * @param {Control} c
   * @param {string} text
   * @param {{ mark?: string }} [o] a review mark, fired MID-STRING as the
   *   mockup fires its own, so the held frame is a half-typed field
   */
  async function typeInto(c, text, o = {}) {
    await clock.w(T.typeLead);
    /* 55% in, verbatim from the mockup's `Math.floor(text.length * 0.55)`. */
    const half = Math.floor(text.length * 0.55);
    /** @type {{ line: HTMLSpanElement, caret: HTMLElement }[]} */
    const written = [];
    if (!dry() && c.els.length > 0) {
      for (const el of c.els) {
        const ghost = ghostOver(el);
        ghosts.push({ ghost: ghost.ghost, el });
        written.push(ghost);
      }
      /* Reduced motion: the state arrives, it does not animate. The waits
         below still run and still cost nothing, exactly as `w()` promises. */
      if (still()) for (const { line } of written) line.textContent = text;
    }
    for (let k = 0; k < text.length; k++) {
      if (!still()) for (const { line } of written) line.textContent = text.slice(0, k + 1);
      if (o.mark && k === half) await mark(o.mark);
      await clock.w(T.typeChar);
    }
    for (const { caret } of written) caret.remove();
  }

  /* ---- wearing a pack --------------------------------------------------- */

  /** The theme the reader arrived in, remembered the first time the film
   *  wears another one over it. `undefined` means the film is not wearing
   *  anything; `null` means they arrived with no `data-theme` at all.
   *  @type {string | null | undefined} */
  let wornOver;

  /** A swatch's title is the product's pack name with its spaces and hyphens
   *  dropped — `packOf` in web/src/routes/home/swatches.js, the one line the
   *  product's own click handler uses. Repeated rather than imported: the
   *  tour is a lib and does not reach into a route's module.
   *  @param {string} pack */
  const packName = (pack) => pack.replace(/[\s-]/gu, "");

  /**
   * Wears a theme pack FOR THE FILM, and only for the film.
   *
   * The mockup had a `dawnPack` flag its slideshow read, because it was
   * painting screenshots. The product wears a pack the way the product does:
   * `document.documentElement.dataset.theme`, which re-skins every screen at
   * once. What this word deliberately does NOT do is the rest of
   * `setSwatch` (swatches.js) — no `localStorage["orbit-theme"]`, no server
   * preference, no pressed-state rewrite on the swatches. Those are the
   * reader's settings, and a film that changed them would leave the tour's
   * one promise broken: the reader's own sky is untouched.
   *
   * So the pack they arrived in is remembered here and put back by `clear()`
   * — which the player calls when the film ends, when the reader jumps, and
   * when they press stop. A skip halfway through the dawn chapter therefore
   * lands them back in their own sky, not in the film's.
   *
   * @param {string | null} pack a pack name or a swatch title; `null` puts
   *   the reader's own back
   */
  function wear(pack) {
    if (dry()) return;
    const root = doc.documentElement;
    if (wornOver === undefined) wornOver = root.dataset.theme ?? null;
    if (pack === null) {
      unwear();
      return;
    }
    root.dataset.theme = packName(pack);
  }

  /** Puts the reader's own pack back, exactly as they arrived in it. */
  function unwear() {
    if (wornOver === undefined) return;
    const root = doc.documentElement;
    if (wornOver === null) delete root.dataset.theme;
    else root.dataset.theme = wornOver;
    wornOver = undefined;
  }

  /* ---- reading a paper --------------------------------------------------- */

  /** Set the moment `read()` opens a card, cleared the moment `unread()`
   *  closes it — so `clear()` knows whether it owes a close, the same shape
   *  `wornOver` gives wear/unwear. */
  let readingOpen = false;

  /**
   * Opens a paper's preview card FOR REAL (08-the-item.js; #866/#1093, and
   * #1319's drawer) — one of the two words in this vocabulary that dispatch
   * a genuine click (`open`, below, is the other), where every other word
   * only ever animates one (`press`'s own doc: "the whole reason press()
   * does not click").
   *
   * That rule is about MUTATION, not about clicking as such: a swatch's
   * click runs `setSwatch` (localStorage and a server preference, why
   * 11-your-sky.js reimplements the visual instead — `wear`, above) and the
   * preview card's own restore and remove buttons are real server writes.
   * A paper's click in home's drawer (`[data-doc-row]`) is neither: it sets
   * the screen's own view state (`previewDoc` on the desk, `previewPaper`
   * on the pocket) — no `localStorage`, no address-bar change, no server
   * request. Nothing here persists, so dispatching it is the honest way to
   * make the real card mount, the same as any reader's own press would.
   * This word must only ever be handed a paper's own row — never the
   * card's own buttons or anything else inside it once the card is open.
   *
   * @param {Control} c one or more papers' own rows; the first is pressed,
   *   because the film never knows or cares which paper it is
   */
  function read(c) {
    if (dry() || c.els.length === 0) return;
    c.els[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    readingOpen = true;
  }

  /**
   * Closes whatever card `read()` opened, the same way a reader would:
   * Escape, which the preview card's own key handler (PreviewCard.svelte)
   * closes it on, ahead of home's own Escape, so the drawer stays open. No
   * selector is needed — the film never named which paper it opened, only
   * that Escape closes whichever is open — which keeps the tour/product
   * boundary one-way exactly as it already is everywhere else.
   *
   * #1083: dispatched on `doc`, not `window` — a document-dispatched keydown
   * still bubbles to the window's own handler, and `doc` is also where the
   * pocket's kit sheet listens in its capture phase (`holdSheet`,
   * sheet.js), so the same dispatch closes either surface.
   */
  function unread() {
    if (!readingOpen) return;
    readingOpen = false;
    if (dry()) return;
    /* #1174: marked as the film's own, exactly as `close()` marks its
       Escape. Unmarked, the transport's capture-phase key handler took this
       for the reader pressing Escape and STOPPED THE FILM at chapter 8 — on
       the desk after "later → steps the belt", on the pocket the moment the
       preview sheet folded — since #1083 moved the dispatch from `window`
       (which a document listener never sees) to `doc`. */
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(event, "tourfilm", { value: true, configurable: true });
    doc.dispatchEvent(event);
  }

  /* ---- #1083 §3.4: the pocket's sheet and row openers -------------------- */

  /** Every undo `open()` has queued, run in reverse by `clear()`. Each entry
   *  looks its own target up fresh when it runs rather than holding a
   *  reference, so a target the screen has already disposed of (a jump, a
   *  navigation) is simply not found and costs nothing to skip.
   *  @type {(() => unknown)[]} */
  let openUndo = [];

  /**
   * Opens a sheet, a row or a drawer mode FOR REAL, the same one genuine
   * click `read()` already makes for a paper (see its own doc, above) — a
   * generalisation on the same terms, not a second rule. Allowed targets,
   * recorded here so nobody mistakes this for a licence to click anything:
   * `#morb` (opens the account hatch, a kit Sheet), a dial body `.pk-body`
   * (opens its manifest row in place), and, in home's item drawer (#1319,
   * 08-the-item.js): the desk's manifest row `a.item` (opens it in place,
   * #424 — the row's own shallow `/home?item=<id>` entry, which Back or
   * Escape takes away again), the drawer's pencil `.ivedit` (the rows go
   * live: a draft, nothing sent until save, which the film never presses)
   * and a live value's `.pick` (its chooser card or sheet). Each is view
   * state only — nothing here writes. A paper's own row is `read()`'s, not
   * this word's.
   *
   * Queues the undo `clear()` needs to leave no sheet up, no row open and
   * no drawer editing: a row's own toggle button
   * (`[data-row-face][aria-expanded="true"]`) for a `.pk-body`, `close()`
   * for anything else — the film's own Escape, which home's own keys take
   * in its order: the chooser, then the editing, then the open row.
   *
   * Returns that undo as a handle, so a chapter can put back the one thing
   * it opened, when it means to, and `clear()` then owes it nothing.
   *
   * @param {Control} c
   * @returns {() => Promise<void>}
   */
  function open(c) {
    if (dry() || c.els.length === 0) return async () => {};
    const el = c.els[0];
    const isRow = el.classList?.contains("pk-body") ?? false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    /** @type {() => unknown} */
    const undo = isRow
      ? () => {
        const face = doc.querySelector('[data-row-face][aria-expanded="true"]');
        if (face) face.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
      : () => close();
    openUndo.push(undo);
    return async () => {
      const at = openUndo.lastIndexOf(undo);
      if (at < 0) return;
      openUndo.splice(at, 1);
      await undo();
    };
  }

  /**
   * Puts away everything `open()` opened and nothing has put back yet,
   * newest first, waiting on each: `clear()`'s own undo, for a chapter that
   * means to leave the page as it found it rather than a jump that has to
   * (chapter 9 closing the drawer chapter 8 opened). Dry mode: no-op, zero
   * time — the fold is motion, priced by the chapter itself.
   */
  async function shut() {
    if (dry()) return;
    while (openUndo.length > 0) {
      const undo = /** @type {() => unknown} */ (openUndo.pop());
      await undo();
    }
  }

  /**
   * Closes whatever `open()` opened, the way a reader's own Escape would: a
   * document-dispatched keydown (§3.4 above), marked `tourfilm` so the
   * transport's own key handler (§4.6) ignores it rather than treating it as
   * the reader stopping the film. Then waits — bounded at 800ms, polling
   * every 16ms — until no `.p-sheet-layer.open` remains and the sheet's own
   * history entry (`pocketSheet`) is gone, so the next beat never races the
   * sheet's fold. Dry mode: no-op, zero time — the fold is motion, and
   * chapters price it themselves with `w(T.sheet)`.
   *
   * Polled with a plain timer rather than `requestAnimationFrame`: this wait
   * is not about a paint, so it has no reason to depend on one.
   */
  async function close() {
    if (dry()) return;
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(event, "tourfilm", { value: true, configurable: true });
    doc.dispatchEvent(event);
    const win = /** @type {Window} */ (doc.defaultView ?? window);
    const deadline = Date.now() + 800;
    while (
      doc.querySelector(".p-sheet-layer.open")
      || (win.history.state && /** @type {Record<string, unknown>} */ (win.history.state).pocketSheet !== undefined)
    ) {
      if (Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, 16));
    }
    /* #1174: the sheet's own history pop is delivered by the browser a tick
       after the state reads clean; give it that tick so the next walk is
       not raced by it (see setScreen). */
    await new Promise((res) => setTimeout(res, 60));
  }

  /* ---- the callout ------------------------------------------------------ */

  /** The product's own `--p-gutter` (tokens.css: 16px at 390, 12px at 360),
   *  read live so a callout's pocket clamp always matches the real column —
   *  never a written-down width (#1083 §3.2). Falls back to the same
   *  breakpoint tokens.css itself uses when the property cannot be read
   *  (no live document, e.g. mid dry-run measurement of a real chapter). */
  function gutterPx() {
    const raw = typeof window.getComputedStyle === "function"
      ? parseFloat(window.getComputedStyle(doc.documentElement).getPropertyValue("--p-gutter"))
      : NaN;
    if (Number.isFinite(raw) && raw > 0) return raw;
    return window.innerWidth <= 389 ? 12 : 16;
  }

  /**
   * @param {string} text
   * @param {Point} pt
   * @param {"left"|"right"|"top"|"bottom"} side
   * @param {{ dy?: number, label?: boolean, w?: number, pin?: boolean }} o
   *   `pin` (#1174): keep the side asked for even when the box does not fit
   *   there, and clamp it into the band instead of flipping — chapter 5's
   *   reminder line sits over the dial's top under the chrome (round 8's
   *   toast position), where a flip would drop it under the dial instead.
   * @param {{ box?: {x:number,y:number,w:number,h:number,cx:number,cy:number} | null, control?: Control | null }} [pocketFit]
   *   #1083 §3.2: the anchor's own box, so a pocket callout can flip an
   *   explicit top/bottom when it does not fit, and clamp against the real
   *   top chrome and the transport's own measured rect. `control` (#1174) is
   *   the anchor itself when there is one, so the box can follow it.
   */
  function showCallout(text, pt, side, o, pocketFit = {}) {
    const root = ensureChrome();
    const box = doc.createElement("div");
    box.className = "tourfilm-callout";
    box.textContent = text;
    const maxWidth = pocket ? Math.min(o.w ?? POCKET_MAX_WIDTH, window.innerWidth - 2 * gutterPx()) : (o.w ?? 260);
    box.style.cssText = [
      "position:fixed",
      `max-width:${maxWidth}px`,
      "width:max-content",
      "text-wrap:balance",
      /* Centred both ways (owner, 2026-10-02): a balanced line is shorter
         than its box, and left-set it reads as off-centre. Even padding
         centres it vertically. */
      "text-align:center",
      "box-sizing:border-box",
      /* Lifted off the page (owner, 2026-10-02: the theme's own panel was
         too dark to catch on the beats that move quickly). Opaque, so no
         word behind shows through; a fifth of the pack's ink mixed into its
         ground, so it reads lighter on the dark packs and a shade deeper on
         the light ones. The edge is the pack's ink, never the accent: the
         accent is the highlight rings' colour, and a bubble must not read
         as one (owner, 2026-10-02). */
      "background:color-mix(in srgb, var(--bg) 80%, var(--ink) 20%)",
      "border:1px solid color-mix(in srgb, var(--ink) 26%, transparent)",
      "box-shadow:0 10px 30px rgba(0,0,0,.35)",
      "border-radius:12px",
      "padding:11px 14px",
      o.label
        ? `font:${pocket ? 12 : 11}px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mid)`
        : "font:13.5px/1.45 var(--ui);color:var(--ink)",
      "opacity:0",
      "pointer-events:none",
      `z-index:${Z_CHROME + 10}`,
      "transition:opacity .24s ease-out,transform .24s ease-out",
    ].join(";");
    const stem = doc.createElement("i");
    stem.style.cssText = [
      "position:absolute",
      "width:14px",
      "height:14px",
      "background:color-mix(in srgb, var(--bg) 80%, var(--ink) 20%)",
      "border:1px solid color-mix(in srgb, var(--ink) 26%, transparent)",
      "transform:rotate(45deg)",
      "z-index:-1",
    ].join(";");
    box.appendChild(stem);
    root.appendChild(box);

    const wd = box.offsetWidth;
    const ht = box.offsetHeight;

    /* #1083 §3.2: an explicit top/bottom flips on the pocket when the box
       does not fit in the band it was asked to sit in (< box height + the
       gap). `left`/`right` are resolved to `top`/`bottom` by the caller
       (callout(), below) before this ever runs. */
    let finalSide = side;
    if (pocket && !o.pin && pocketFit.box && (side === "top" || side === "bottom")) {
      const band = pocketBand();
      const room = side === "top" ? pt[1] - band.top : band.bottom - pt[1];
      if (room < ht + CALLOUT_GAP) finalSide = side === "top" ? "bottom" : "top";
    }
    if (finalSide !== side && pocketFit.box) {
      pt = edgeOf(pocketFit.box, finalSide);
    }

    /* #1174: the anchor point is read fresh each time the box is placed, so
       a callout pinned to a control stays on it when the page scrolls or the
       viewport resizes under it (syncChrome). A callout given a bare point
       keeps that point. */
    const control = pocketFit.control ?? null;
    const pointNow = () => (control && control.els.length > 0)
      ? edgeOf(boxOf(control.ringEls, control.pad), finalSide)
      : pt;

    function place() {
      const p = pointNow();
      /* What this line points at, for the phone check (tour-pocket-webkit
         .spec.js): the anchor's current box, or "none" when the control it
         was pinned to matched nothing — a line pointing at nothing. */
      const a = control && control.els.length > 0 ? boxOf(control.ringEls, control.pad) : null;
      box.dataset.tourfilmAnchor = a ? `${a.x},${a.y},${a.w},${a.h}` : (control ? "none" : "point");
      box.dataset.tourfilmSide = finalSide;
      box.dataset.tourfilmDy = String(o.dy ?? 0);
      const band = pocket ? pocketBand() : null;
      let x;
      let y;
      if (finalSide === "left") { x = p[0] - CALLOUT_GAP - wd; y = p[1] - ht / 2; }
      else if (finalSide === "right") { x = p[0] + CALLOUT_GAP; y = p[1] - ht / 2; }
      else if (finalSide === "top") { x = p[0] - wd / 2; y = p[1] - CALLOUT_GAP - ht; }
      else { x = p[0] - wd / 2; y = p[1] + CALLOUT_GAP; }
      if (o.dy) y += o.dy;
      if (pocket && band) {
        /* the pocket's own gutter horizontally; never over the top chrome or
           inside the transport's own measured rect, wherever it stands */
        const gutter = gutterPx();
        x = Math.max(gutter, Math.min(x, window.innerWidth - gutter - wd));
        y = Math.max(band.top + POCKET_CALLOUT_MARGIN, Math.min(y, band.bottom - POCKET_CALLOUT_MARGIN - ht));
      } else {
        /* never off the screen, and never under the transport */
        x = Math.max(CALLOUT_EDGE, Math.min(x, window.innerWidth - CALLOUT_EDGE - wd));
        y = Math.max(CALLOUT_EDGE, Math.min(y, window.innerHeight - TRANSPORT_LANE - ht));
      }
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      if (finalSide === "left" || finalSide === "right") {
        stem.style.top = `${Math.max(12, Math.min(p[1] - y, ht - 12)) - 7}px`;
        stem.style[finalSide === "left" ? "right" : "left"] = "-8px";
      } else {
        stem.style.left = `${Math.max(14, Math.min(p[0] - x, wd - 14)) - 7}px`;
        stem.style[finalSide === "top" ? "bottom" : "top"] = "-8px";
      }
    }
    place();
    livePlace = control ? place : null;
    const slide = { left: [6, 0], right: [-6, 0], top: [0, 6], bottom: [0, -6] }[finalSide];
    box.style.transform = still() ? "translate(0,0)" : `translate(${slide[0]}px,${slide[1]}px)`;
    requestAnimationFrame(() => {
      box.style.opacity = "1";
      box.style.transform = "translate(0,0)";
    });
    return /** @type {HTMLDivElement} */ (box);
  }

  /**
   * The mockup's `callout`: the ratified line, pinned to the thing just
   * acted on, and held for as long as it takes to read — in either motion
   * mode, because reading is not motion.
   *
   * Where the mockup wrote a point, a chapter here names the control and the
   * side: the box is anchored to the MIDPOINT OF THAT EDGE of the live
   * element, which is what the mockup's own coordinates are in three of
   * chapter 1's four cases and self-maintaining in all of them.
   *
   * @param {string} text
   * @param {Control | Point} anchor
   * @param {"left"|"right"|"top"|"bottom"} side
   * @param {{ hold?: number, dy?: number, label?: boolean, w?: number, mark?: string, pin?: boolean }} [o]
   */
  async function callout(text, anchor, side, o = {}) {
    dropCallout();
    /* Round 7: a line is a callout without `label: true` -- the small
       uppercase tags the film pins on lanes and papers are the picture
       naming a part, which a sentence beside it already says, so they are
       not read into the script. Recorded only while dry: this is the
       player's measuring pass, run once per chapter before a frame plays. */
    if (dry() && !o.label) transcriptLines.push(text);
    await clock.w(T.calloutIn);
    if (!dry()) {
      dropGone();
      const anchorBox = !Array.isArray(anchor) && anchor.els.length > 0
        ? boxOf(anchor.ringEls, anchor.pad)
        : null;
      /* #1083 §3.2: on the pocket, left/right resolve to whichever of
         top/bottom has more room between the anchor and the band's own
         limit (the top chrome below it, the transport above it). */
      let resolvedSide = side;
      if (pocket && anchorBox && (side === "left" || side === "right")) {
        const band = pocketBand();
        const roomAbove = anchorBox.y - band.top;
        const roomBelow = band.bottom - (anchorBox.y + anchorBox.h);
        resolvedSide = roomBelow >= roomAbove ? "bottom" : "top";
      }
      const pt = Array.isArray(anchor)
        ? anchor
        : anchorBox
          ? edgeOf(anchorBox, resolvedSide)
          : centreOfViewport();
      live = showCallout(text, pt, resolvedSide, o, { box: anchorBox, control: Array.isArray(anchor) ? null : anchor });
    }
    await clock.hold(o.hold ?? holdFor(text));
    if (o.mark) await mark(o.mark);
  }

  /** The mockup's `dropCallout`: a callout leaves as the next move begins. */
  function dropCallout() {
    if (!live) return;
    const box = live;
    live = null;
    livePlace = null;
    box.style.transition = "opacity .18s ease";
    box.style.opacity = "0";
    setTimeout(() => box.remove(), T.calloutOut + 240);
  }

  /**
   * The mockup's review hook, kept because the design host drives the film
   * through it: `window.__hold = "<mark>"` stops the film at that moment and
   * holds the coroutine THERE, so the state can be photographed rather than
   * torn down by the next line.
   *
   * Holding is just the clock: stopped, a zero-length wait cannot fire, so
   * the chapter is suspended until the film plays again — and is rejected
   * with CANCEL, unwinding cleanly, if the reader jumped instead.
   *
   * @param {string} name
   */
  async function mark(name) {
    if (dry()) return;
    const hooks = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    hooks.__mark = name;
    if (hooks.__hold !== name) return;
    clock.setPlaying(false);
    hooks.__held = name;
    await clock.wait(0);
  }

  /** Where the dot rests as a chapter opens (the mockup's `enter`). A
   *  selector, so it is a place on the screen rather than a coordinate.
   *  @param {string} [selector] */
  function enter(selector) {
    if (dry()) return;
    ensureChrome();
    const el = selector ? doc.querySelector(selector) : null;
    at = el ? /** @type {Point} */ ([boxOf([el]).cx, boxOf([el]).cy]) : centreOfViewport();
    placeDot(at);
  }

  /** Takes every mark the film has made off the screen and puts the
   *  product's own DOM back as it was found. The player calls this between
   *  chapters on a jump, and at the end. */
  function clear() {
    for (const c of litControls) {
      for (const ring of c.rings) ring.remove();
      c.rings = [];
      restore(c);
    }
    litControls = [];
    for (const animation of Array.from(filmAnims)) {
      try { animation.cancel(); } catch { /* already gone */ }
    }
    filmAnims.clear();
    if (live) { live.remove(); live = null; }
    livePlace = null;
    dropTyped();
    /* The reader's own sky, back — before anything else can be jumped to. */
    unwear();
    /* Whatever card a paper's own press opened, closed the same way Esc
       already closes it — a film that ends leaving a reading card open is
       a bug the same way one that ends leaving a pack worn would be. */
    unread();
    /* #1083 §3.4: whatever `open()` opened, in reverse — a jump or a stop
       must leave no sheet up and no row open on the pocket either. Each
       undo looks its own target up fresh, so one already gone with the
       screen it belonged to is simply not found. */
    for (const undo of openUndo.slice().reverse()) void undo();
    openUndo = [];
    if (layer) {
      for (const stale of Array.from(layer.querySelectorAll(".tourfilm-ring,.tourfilm-callout,.tourfilm-typed"))) {
        stale.remove();
      }
    }
    if (dot) dot.style.opacity = "0";
    veilTargets([]);
    room(0);
    /* #1174 round 5: whatever a chapter staged on the product's own page —
       chapter 4's example rows, chapter 5's danger ring — marks itself
       `data-tourfilm-staged`, and goes here on a jump or a stop as well as
       at the chapter's own end, so the page is left as the film found it. */
    for (const staged of Array.from(doc.querySelectorAll("[data-tourfilm-staged]"))) staged.remove();
    /* #1174: the page back at the top, where every chapter opens and where
       the film found it. A jump or a stop out of a chapter that had scrolled
       the page (chapter 4's manifest, a pocket `goto`) left it there, and
       the next chapter's dial — the walking body of chapter 5 — played off
       the top of the screen. Instant: the film's own scroll is a beat of its
       own; this is the stage being reset between takes. */
    const win = doc.defaultView;
    if (win && typeof win.scrollTo === "function" && (win.scrollY || 0) > 0) {
      win.scrollTo({ top: 0, behavior: "instant" });
    }
    at = centreOfViewport();
    placeDot(at);
  }

  /** Everything gone, including the veil and the chrome layer itself. */
  function destroy() {
    clear();
    hideVeil();
    veiled = false;
    unsubscribe();
    offFrame();
    if (layer) layer.remove();
    window.removeEventListener("scroll", onViewportChange, { capture: true });
    window.removeEventListener("resize", onViewportChange);
    if (syncRaf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(syncRaf);
    syncRaf = null;
    layer = null;
    dot = null;
  }

  return {
    doc,
    clock,
    T,
    /** #1083: the pocket dialect, fixed at mount. Chapters read this to
     *  choose selectors and anchors; they never call `matchMedia`. */
    pocket,
    /* clock words, so a chapter never imports the clock itself */
    w: clock.w,
    hold: clock.hold,
    wait: clock.wait,
    tween: clock.tween,
    /** #1174 round 5: a Web Animation on the film's own terms — paused
     *  with the film, cancelled by `clear()`, nothing at all under reduced
     *  motion or in the dry run. Resolves when it finishes or is cancelled. */
    animate: anim,
    room,
    holdFor,
    dry,
    reduced: still,
    /* the film's own words */
    setScreen,
    waitForReal,
    veil,
    veiled: () => veiled,
    ctl,
    light,
    unlight,
    quiet,
    goto,
    press,
    typeInto,
    wear,
    read,
    unread,
    open,
    shut,
    close,
    /** #1083 §4.6: whether the film itself currently owns an open sheet or
     *  row — the transport's own Escape handler reads this to tell "the film
     *  should stop" from "the reader is closing their own sheet". */
    hasOpenUndo: () => openUndo.length > 0,
    travel,
    growInto,
    callout,
    dropCallout,
    mark,
    enter,
    clear,
    destroy,
    /* measurement, exposed for the chapters that need to place something */
    boxOf,
    lit: () => litControls.slice(),
    /** #1174: every ring the film has up, beside the box of the element it
     *  was drawn round as that element measures NOW — the phone check's
     *  own account of "a spotlight in the right place": each ring's box
     *  equals its element's, the element is in the document and shown. */
    litBoxes: () => litControls.flatMap((c) => c.rings.map((ring, index) => {
      const el = c.ringEls[index];
      const r = ring.getBoundingClientRect();
      const t = el ? boxOf([el], c.pad) : { x: 0, y: 0, w: 0, h: 0 };
      return {
        ring: { x: r.left, y: r.top, w: r.width, h: r.height },
        target: { x: t.x, y: t.y, w: t.w, h: t.h },
        connected: Boolean(el && el.isConnected),
        shown: Boolean(el && el.isConnected && shown(el)),
        sel: c.sel,
      };
    })),
    /* the script (round 7, #1097): read by player.js's measure() */
    transcript: () => transcriptLines.slice(),
    /* #1174 round 6: the waits for the page that ran out */
    waitedOut: () => waitedOut.map((one) => ({ ...one })),
    resetTranscript: () => { transcriptLines = []; },
  };
}

/** @typedef {ReturnType<typeof createFilmContext>} FilmContext */
