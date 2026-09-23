/**
 * THE FILM'S VOCABULARY (#866).
 *
 * The ratified mockup (design/v19/tour/round-5/f-one-take.html) writes its
 * twelve chapters in a small, fixed set of words: `setBg`, `veil`, `ctl`,
 * `mkHl`, `mkCut`, `goto`, `press`, `tap`, `typeInto`, `unlight`, `callout`,
 * `travel`. This module is those words again, against the real product. A
 * reader can hold the mockup beside a chapter file here and follow both.
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
import { hideVeil, showVeil, veilTargets } from "./veil.js";

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
};

/** The mockup's default corner. */
const DEFAULT_RADIUS = 14;
/** Above veil.js's sheet (2000), which reserves this headroom by name. */
const Z_CHROME = 2100;
const CHROME_ID = "orbit-tour-film";
/** Kept clear at the foot of the screen so a callout never lands under the
 *  transport, as the mockup keeps its own bottom 60 stage pixels clear. */
const TRANSPORT_LANE = 60;
const CALLOUT_GAP = 18;
const CALLOUT_EDGE = 16;

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
 *
 * @typedef {object} Control
 * @property {string} sel
 * @property {Element[]} els              what is lit and pressed
 * @property {Element[]} ringEls          what the ring is measured from
 * @property {boolean} round
 * @property {number} pad
 * @property {number} radius
 * @property {HTMLDivElement[]} rings
 * @property {boolean} lifted
 * @property {{ el: Element, transform: string, filter: string, transition: string }[]} saved
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
 * @param {() => string} [options.routeOf]
 * @param {(route: string) => Promise<unknown>} [options.navigate]
 * @param {(route: string) => Promise<unknown>} [options.settle] resolves once the screen is really there
 */
export function createFilmContext({
  clock,
  doc = document,
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
    return layer;
  }

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
    /* The fields the film typed over are about to leave with the screen. */
    dropTyped();
    const release = clock.stall();
    try {
      await navigate(route);
      await settle(route);
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
    if (dry()) {
      return { sel: s.sel, els: [], ringEls: [], round, pad, radius, rings: [], lifted: false, saved: [] };
    }
    const els = s.all
      ? Array.from(doc.querySelectorAll(s.sel))
      : [doc.querySelector(s.sel)].filter((el) => el !== null);
    if (els.length === 0 && !s.optional) throw new TourControlMissing(s.sel);
    const ringEls = s.ring
      ? Array.from(doc.querySelectorAll(s.ring))
      : els;
    return { sel: s.sel, els, ringEls, round, pad, radius, rings: [], lifted: false, saved: [] };
  }

  /** Lights controls without travelling to them — the mockup turning several
   *  `.hl`s on at once, as chapter 1 does for the four outer suns.
   *  @param {...Control} controls */
  function light(...controls) {
    for (const c of controls) {
      if (dry() || c.els.length === 0) continue;
      ensureRings(c);
      syncRings(c);
      ringState(c, "on");
      addLit(c);
    }
  }

  /** @param {Control} c */
  function applyLift(c) {
    if (dry() || c.lifted) return;
    c.lifted = true;
    for (const el of c.els) {
      const style = styleOf(el);
      if (!style) continue;
      c.saved.push({
        el,
        transform: style.transform,
        filter: style.filter,
        transition: style.transition,
      });
      style.transition = still() ? "none" : `transform ${T.lift}ms ${T.ease},filter ${T.lift}ms ease`;
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

  /**
   * The mockup's `goto`: travel, become the control's outline, and lift it.
   * @param {Control} c
   * @param {{ willPress?: boolean }} [o]
   */
  async function goto(c, o = {}) {
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
      const base = c.lifted ? "translateY(-2px)" : "translate(0,0)";
      for (const el of c.els) {
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

  /** The mockup's `unlight`. @param {...Control} controls */
  function unlight(...controls) {
    for (const c of controls) {
      if (dry()) continue;
      ringState(c, "off");
      for (const ring of c.rings) ring.remove();
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

  /** The mockup's `tap`: visit, press, and leave dark again.
   *  @param {Control} c @param {{ keep?: boolean, willPress?: boolean }} [o] */
  async function tap(c, o = {}) {
    await goto(c, o);
    await press(c);
    if (o.keep !== true) unlight(c);
  }

  /* ---- typing (the mockup's typeInto) ----------------------------------- */

  /** An opaque background to paint the typed line on: the field's own, or
   *  the first ancestor that has one, so the ghost hides whatever the real
   *  field is showing underneath (`#f-name` ships with "New Entry" in it, a
   *  date input shows its own placeholder).
   *  @param {Element} el */
  function backdropOf(el) {
    if (typeof window.getComputedStyle !== "function") return "var(--panel)";
    /** @type {Element | null} */
    let node = el;
    while (node) {
      const bg = window.getComputedStyle(node).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/u.test(bg)) return bg;
      node = node.parentElement;
    }
    return "var(--panel)";
  }

  /** The film's own text, laid over one field and wearing that field's font.
   *  @param {Element} el
   *  @returns {{ line: HTMLSpanElement, caret: HTMLElement }} */
  function ghostOver(el) {
    const root = ensureChrome();
    const box = boxOf([el]);
    const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(el) : null;
    const ghost = doc.createElement("div");
    ghost.className = "tourfilm-typed";
    ghost.style.cssText = [
      "position:fixed",
      `left:${box.x}px`,
      `top:${box.y}px`,
      `width:${box.w}px`,
      `height:${box.h}px`,
      "display:flex",
      "align-items:center",
      "box-sizing:border-box",
      "overflow:hidden",
      "white-space:pre",
      "pointer-events:none",
      `background:${backdropOf(el)}`,
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
    root.appendChild(ghost);
    return { line, caret };
  }

  /** Every ghost currently on the screen, so the film can take them off.
   *  @type {HTMLElement[]} */
  let ghosts = [];

  /** Takes the typed text off the screen. The product never had it, so there
   *  is nothing to put back — the ghosts simply go. */
  function dropTyped() {
    for (const ghost of ghosts) ghost.remove();
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
        ghosts.push(/** @type {HTMLElement} */ (ghost.line.parentElement));
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
   * Opens a paper's reading card FOR REAL (08-the-belt.js, #866/#1093) — the
   * one place in this whole vocabulary that dispatches a genuine click,
   * where every other word only ever animates one (`press`'s own doc: "the
   * whole reason press() does not click").
   *
   * That rule is about MUTATION, not about clicking as such: a swatch's
   * click runs `setSwatch` (localStorage and a server preference, why
   * 11-your-sky.js reimplements the visual instead — `wear`, above) and the
   * reading card's own restore button runs `restoreDocument`, a real server
   * write. A paper's click is neither: `openDoc` (belt.behaviour.js) sets a
   * class on its own seat and the screen's own view state (`previewIdx`,
   * `previewDoc`) — no `localStorage`, no address-bar change (that is
   * `centre`'s, and a document's press never reaches `centre` — #1088's own
   * rule), no server request. Nothing here persists, so dispatching it is
   * the honest way to make the real card mount, the same as any reader's
   * own press would. This word must only ever be handed a paper's own hit —
   * never the card's own restore button or anything else inside it once the
   * card is open.
   *
   * @param {Control} c one or more papers' own real hits; the first is
   *   pressed, because the film never knows or cares which paper it is
   */
  function read(c) {
    if (dry() || c.els.length === 0) return;
    c.els[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    readingOpen = true;
  }

  /**
   * Closes whatever card `read()` opened, the same way a reader would:
   * Escape, which the item screen's own `onKeydown` (`+page.svelte`) already
   * closes the preview on. No selector is needed — the film never named
   * which paper it opened, only that Escape closes whichever is open — and
   * no new handle onto the belt is needed either, which keeps the tour/
   * product boundary one-way exactly as it already is everywhere else.
   */
  function unread() {
    if (!readingOpen) return;
    readingOpen = false;
    if (dry()) return;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }

  /* ---- the callout ------------------------------------------------------ */

  /**
   * @param {string} text
   * @param {Point} pt
   * @param {"left"|"right"|"top"|"bottom"} side
   * @param {{ dy?: number, label?: boolean, w?: number }} o
   */
  function showCallout(text, pt, side, o) {
    const root = ensureChrome();
    const box = doc.createElement("div");
    box.className = "tourfilm-callout";
    box.textContent = text;
    box.style.cssText = [
      "position:fixed",
      `max-width:${o.w ?? 260}px`,
      "width:max-content",
      "text-wrap:balance",
      "box-sizing:border-box",
      "background:var(--panel-raised)",
      "backdrop-filter:blur(14px)",
      "border:1px solid var(--line)",
      "border-radius:12px",
      "padding:11px 14px",
      o.label
        ? "font:11px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mid)"
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
      "background:var(--panel-raised)",
      "backdrop-filter:blur(14px)",
      "border:1px solid var(--line)",
      "transform:rotate(45deg)",
      "z-index:-1",
    ].join(";");
    box.appendChild(stem);
    root.appendChild(box);

    const wd = box.offsetWidth;
    const ht = box.offsetHeight;
    let x;
    let y;
    if (side === "left") { x = pt[0] - CALLOUT_GAP - wd; y = pt[1] - ht / 2; }
    else if (side === "right") { x = pt[0] + CALLOUT_GAP; y = pt[1] - ht / 2; }
    else if (side === "top") { x = pt[0] - wd / 2; y = pt[1] - CALLOUT_GAP - ht; }
    else { x = pt[0] - wd / 2; y = pt[1] + CALLOUT_GAP; }
    if (o.dy) y += o.dy;
    /* never off the screen, and never under the transport */
    x = Math.max(CALLOUT_EDGE, Math.min(x, window.innerWidth - CALLOUT_EDGE - wd));
    y = Math.max(CALLOUT_EDGE, Math.min(y, window.innerHeight - TRANSPORT_LANE - ht));
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    if (side === "left" || side === "right") {
      stem.style.top = `${Math.max(12, Math.min(pt[1] - y, ht - 12)) - 7}px`;
      stem.style[side === "left" ? "right" : "left"] = "-8px";
    } else {
      stem.style.left = `${Math.max(14, Math.min(pt[0] - x, wd - 14)) - 7}px`;
      stem.style[side === "top" ? "bottom" : "top"] = "-8px";
    }
    const slide = { left: [6, 0], right: [-6, 0], top: [0, 6], bottom: [0, -6] }[side];
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
   * @param {{ hold?: number, dy?: number, label?: boolean, w?: number, mark?: string }} [o]
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
      const pt = Array.isArray(anchor)
        ? anchor
        : anchor.els.length === 0
          ? centreOfViewport()
          : edgeOf(boxOf(anchor.ringEls, anchor.pad), side);
      live = showCallout(text, pt, side, o);
    }
    await clock.hold(o.hold ?? holdFor(text));
    if (o.mark) await mark(o.mark);
  }

  /** The mockup's `dropCallout`: a callout leaves as the next move begins. */
  function dropCallout() {
    if (!live) return;
    const box = live;
    live = null;
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
    dropTyped();
    /* The reader's own sky, back — before anything else can be jumped to. */
    unwear();
    /* Whatever card a paper's own press opened, closed the same way Esc
       already closes it — a film that ends leaving a reading card open is
       a bug the same way one that ends leaving a pack worn would be. */
    unread();
    if (layer) {
      for (const stale of Array.from(layer.querySelectorAll(".tourfilm-ring,.tourfilm-callout,.tourfilm-typed"))) {
        stale.remove();
      }
    }
    if (dot) dot.style.opacity = "0";
    veilTargets([]);
    at = centreOfViewport();
    placeDot(at);
  }

  /** Everything gone, including the veil and the chrome layer itself. */
  function destroy() {
    clear();
    hideVeil();
    veiled = false;
    unsubscribe();
    if (layer) layer.remove();
    layer = null;
    dot = null;
  }

  return {
    doc,
    clock,
    T,
    /* clock words, so a chapter never imports the clock itself */
    w: clock.w,
    hold: clock.hold,
    wait: clock.wait,
    tween: clock.tween,
    holdFor,
    dry,
    reduced: still,
    /* the film's own words */
    setScreen,
    veil,
    veiled: () => veiled,
    ctl,
    light,
    unlight,
    quiet,
    goto,
    press,
    tap,
    typeInto,
    wear,
    read,
    unread,
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
    /* the script (round 7, #1097): read by player.js's measure() */
    transcript: () => transcriptLines.slice(),
    resetTranscript: () => { transcriptLines = []; },
  };
}

/** @typedef {ReturnType<typeof createFilmContext>} FilmContext */
