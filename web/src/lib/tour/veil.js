/**
 * THE VEIL (#866): a masked full-viewport overlay that darkens the real
 * product UI everywhere except holes punched at the tour's current lit
 * targets — the mechanic design/v19/tour/round-5/f-one-take.html paints by
 * hand (its `#veil` div plus `mkCut`'s pasted cut-outs), rebuilt here to run
 * over live DOM instead of a screenshot.
 *
 * The mockup fakes a "hole" by pasting a lit rectangle, cropped from the same
 * screenshot, on top of a plain dark sheet. There is no screenshot here: the
 * lit control is the real element, sitting in the real document, and it must
 * keep its own stacking context and its own hit-testing. So a hole cannot be
 * an element placed on top of the veil — it has to be an actual gap cut into
 * the dark sheet, which is what a CSS mask is for. The lit element itself is
 * never moved, re-parented, classed or given a z-index (`emphasis.js`
 * already collides `.lit` with `home.css:495` and zeroes it out entirely at
 * `create.css:221` — this module never uses that class name, or any class on
 * the target at all).
 *
 * MASKING APPROACH: one `<div>` at position:fixed, inset:0, at the ratified
 * 0.62, holding one inline `<svg>` whose full-bleed rect is painted with the
 * pack's own `--bg` — never an invented colour, the same token the mockup's
 * own `.veil{background:var(--bg)}` uses — through an SVG `<mask>`: a white
 * full-bleed rect (mask luminance 1 → the dark sheet paints there) with one
 * black rect or circle per hole (luminance 0 → the sheet is cut away, so the
 * real element beneath shows through at its own unmodified opacity).
 *
 * #1174 (round 3): the mask used to be a CSS `mask-image` data URI, rebuilt
 * whenever a hole moved. Every rebuild is a new image the engine has to
 * decode before it can paint the sheet, and Safari decodes data URIs off the
 * main thread — a veil whose mask is in flight for a frame is a veil drawn
 * wrong for a frame, every time the film lit or moved anything. An inline
 * SVG has no image to load: a hole's attributes change and the next paint
 * has them. The holes also open and close on a short fade (`HOLE_MS`)
 * rather than in one frame — a bright patch snapping on and off over a
 * dimmed phone screen reads as the screen flickering, which is what the
 * owner saw. An SVG mask was chosen over
 * stacking several `radial-gradient`/`linear-gradient` mask layers with
 * `mask-composite`: two of the shapes here are rounded RECTANGLES, and while
 * a gradient stack can fake a circle cheaply, faking a soft-cornered rect
 * needs several gradients composited just right per corner. An SVG `<rect
 * rx>` and `<circle>` say exactly what is wanted — one hole, one shape — and
 * cover a TRAVELLING hole the same way they cover a still one, with no
 * separate code path -- chapter 9 is the film's one travelling-hole chapter,
 * where the veil is up while the thing it is cut around moves.
 *
 * This sentence used to name "chapters 5/9/12", and that was wrong twice
 * over: it reads as an instruction to raise the veil in all three, and 5 and
 * 12 are precisely the two chapters of the twelve that never raise it at all
 * (round-5/f-one-take.html:770 and :1104 open `veil(false)` and never call
 * `veil(true)` again). Both chapters were built veiling because of this line
 * and both had to be corrected. What travels in 5 and 12 is the RING, not a
 * hole; there is no hole, because there is no veil.
 *
 * CONTRAST: the veil never sits over readable text it did not already sit
 * over unlit — it darkens exactly what the mockup darkens, using the pack's
 * own `--bg`, and introduces no new colour for `tests/unit/v19-pack-*
 * -contrast.test.mjs` to grade. Anything meant to stay legible while the
 * veil is up — a callout, the transport — is tour chrome that paints above
 * this layer's z-index, not through a hole in it.
 */

export const OPACITY = 0.62;
const FADE_MS = 450;
/** A hole opening or closing (#1174 round 3): long enough that no frame
 *  flips a patch of the screen from dimmed to lit, short enough to stay
 *  inside the film's own beats (T.grow is 200ms). */
export const HOLE_MS = 180;
const SVG_NS = "http://www.w3.org/2000/svg";
const MASK_ID = "orbit-tour-veil-mask";
/** Above every routed page's own chrome (the highest z-index any route.css
 *  declares is 12, `home.css`'s `.askveil`); tour chrome built on top of the
 *  veil — a future transport, a callout — reserves the headroom above this. */
const Z_INDEX = 2000;
const OVERLAY_ID = "orbit-tour-veil";
const DEFAULT_RADIUS = 14;

/**
 * @typedef {{ el: Element, round: boolean, pad: number, radius: number }} VeilTarget
 *   A resolved target: the element to cut a hole for, and the hole's shape.
 * @typedef {{ x: number, y: number, w: number, h: number, round: boolean, radius: number }} VeilRect
 *   One measured hole in viewport coordinates, ready to paint into the mask.
 */

/** @type {HTMLDivElement | null} */
let overlayEl = null;
/** The mask the holes are cut in. @type {SVGMaskElement | null} */
let maskEl = null;
/** One shape per lit element, kept while it is lit so a hole that moves is
 *  the same hole moved, not a new one cut. @type {Map<Element, SVGElement>} */
const holes = new Map();
let visible = false;
/** @type {VeilTarget[]} */
let targets = [];
/** @type {string | null} */
let lastSig = null;
/** @type {number | null} */
let rafId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let hideTimer = null;

/* Read live, never cached — the same idiom skies.js and satellites.js use,
   so an OS-level reduced-motion change mid-tour is honoured without a
   remount. Only the FADE is skipped; holes still move (#866 requirement). */
function stillMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @param {Element | { el: Element, round?: boolean, pad?: number, radius?: number }} entry
 * @param {{ round?: boolean, pad?: number, radius?: number }} defaults
 */
function normalize(entry, defaults) {
  const isElement = entry instanceof Element;
  const el = /** @type {Element} */ (isElement ? entry : entry.el);
  const round = (isElement ? undefined : entry.round) ?? defaults.round ?? false;
  const pad = (isElement ? undefined : entry.pad) ?? defaults.pad ?? 0;
  const radius = (isElement ? undefined : entry.radius) ?? defaults.radius ?? DEFAULT_RADIUS;
  return { el, round, pad, radius };
}

/**
 * @param {VeilTarget} t
 * @returns {VeilRect}
 */
function computeRect(t) {
  const box = t.el.getBoundingClientRect();
  const pad = t.pad;
  return {
    x: box.left - pad,
    y: box.top - pad,
    w: box.width + pad * 2,
    h: box.height + pad * 2,
    round: t.round,
    radius: t.radius,
  };
}

/** A cheap fingerprint of the current geometry, so a frame that measured no
 *  movement can skip rebuilding and re-painting the mask entirely.
 *  @param {VeilRect[]} rects
 *  @returns {string} */
function serialize(rects) {
  const body = rects
    .map((r) => `${r.round ? "o" : "r"}${r.x.toFixed(1)},${r.y.toFixed(1)},${r.w.toFixed(1)},${r.h.toFixed(1)},${r.radius}`)
    .join("|");
  return `${body}@${window.innerWidth}x${window.innerHeight}`;
}

/** @param {SVGElement} shape @param {VeilRect} r */
function placeHole(shape, r) {
  if (r.round) {
    shape.setAttribute("cx", (r.x + r.w / 2).toFixed(1));
    shape.setAttribute("cy", (r.y + r.h / 2).toFixed(1));
    shape.setAttribute("r", (Math.max(r.w, r.h) / 2).toFixed(1));
  } else {
    shape.setAttribute("x", r.x.toFixed(1));
    shape.setAttribute("y", r.y.toFixed(1));
    shape.setAttribute("width", Math.max(0, r.w).toFixed(1));
    shape.setAttribute("height", Math.max(0, r.h).toFixed(1));
    shape.setAttribute("rx", String(r.radius));
    shape.setAttribute("ry", String(r.radius));
  }
}

/** Moves every lit target's hole to where its element is now.
 *  @param {VeilRect[]} rects */
function applyMask(rects) {
  if (!overlayEl) return;
  targets.forEach((t, k) => {
    const shape = holes.get(t.el);
    if (shape) placeHole(shape, rects[k]);
  });
}

/**
 * Cuts a hole for every target that has none, and closes the hole of every
 * element no longer lit — on a fade, both ways, unless motion is reduced.
 * A hole still closing whose element is lit again is opened again, not cut
 * twice.
 */
function syncHoleSet() {
  if (!maskEl) return;
  const still = stillMotion();
  const wanted = new Set(targets.map((t) => t.el));
  for (const [el, shape] of holes) {
    if (wanted.has(el)) continue;
    holes.delete(el);
    if (still) { shape.remove(); continue; }
    shape.classList.add("leaving");
    shape.style.fillOpacity = "0";
    setTimeout(() => shape.remove(), HOLE_MS + 40);
  }
  for (const t of targets) {
    if (holes.has(t.el)) continue;
    const shape = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, t.round ? "circle" : "rect"));
    shape.setAttribute("class", "hole");
    shape.setAttribute("fill", "#000");
    placeHole(shape, computeRect(t));
    if (still) {
      shape.style.fillOpacity = "1";
      maskEl.appendChild(shape);
    } else {
      shape.style.fillOpacity = "0";
      shape.style.transition = `fill-opacity ${HOLE_MS}ms ease`;
      maskEl.appendChild(shape);
      /* the start value has to be computed before the end value is set, or
         there is nothing to transition from */
      void getComputedStyle(shape).fillOpacity;
      shape.style.fillOpacity = "1";
    }
    holes.set(t.el, shape);
  }
}

/** Re-measures every current target; repaints the mask only if something
 *  actually moved. Returns whether it repainted, which is also "is this
 *  worth watching for another frame". */
function updateHoles() {
  if (!overlayEl) return false;
  const rects = targets.map(computeRect);
  const sig = serialize(rects);
  if (sig === lastSig) return false;
  lastSig = sig;
  applyMask(rects);
  return true;
}

function stopLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/* THE RE-MEASURE LOOP. Runs on requestAnimationFrame only while something is
   actually moving: each tick re-measures and repaints only on a real change,
   and reschedules only when it found one — a target that has settled lets
   the loop go quiet on its own rather than spinning forever. `scroll` and
   `resize` (below) cover the case nothing is animating but the layout moved
   anyway, and restart the loop if that revealed further movement (e.g. a
   scroll that interrupts a still-running CSS transition). Chapters 5, 9 and
   12 light a body travelling round the dial; those keep this loop running
   for the length of the travel and then it goes idle again on its own. */
function measureLoop() {
  rafId = null;
  if (!visible || targets.length === 0) return; /* nothing lit: stay stopped */
  if (updateHoles()) scheduleLoop();
}

function scheduleLoop() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(measureLoop);
}

function onViewportChange() {
  if (!visible || targets.length === 0) return;
  if (updateHoles()) scheduleLoop();
}

/**
 * #1174: re-measures the holes now, as a scroll would — for a lit element
 * the PAGE moves without scrolling (the belt bringing a pressed paper to
 * its apex, a row unfolding above a lit control). The loop above goes
 * quiet once nothing has moved for a frame and only a scroll or a resize
 * wakes it; the film's own per-frame sync (vocabulary.js) calls this so a
 * hole follows its element whatever moved it. Repaints only on a change.
 */
export function refreshVeil() {
  onViewportChange();
}

function addListeners() {
  // capture:true so a scroll inside any scrollable ancestor is caught, not
  // only a scroll of the window itself.
  window.addEventListener("scroll", onViewportChange, { passive: true, capture: true });
  window.addEventListener("resize", onViewportChange);
}

function removeListeners() {
  window.removeEventListener("scroll", onViewportChange, { capture: true });
  window.removeEventListener("resize", onViewportChange);
}

function ensureOverlay() {
  if (overlayEl && overlayEl.isConnected) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.id = OVERLAY_ID;
  overlayEl.setAttribute("aria-hidden", "true");
  overlayEl.style.cssText = [
    "position:fixed",
    "inset:0",
    "opacity:0",
    "pointer-events:none", // never blocks a click on the real control it is cut around
    `z-index:${Z_INDEX}`,
  ].join(";");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("style", "position:absolute;inset:0;display:block;overflow:hidden");
  const defs = document.createElementNS(SVG_NS, "defs");
  maskEl = /** @type {SVGMaskElement} */ (document.createElementNS(SVG_NS, "mask"));
  maskEl.setAttribute("id", MASK_ID);
  maskEl.setAttribute("maskUnits", "userSpaceOnUse");
  maskEl.setAttribute("x", "0");
  maskEl.setAttribute("y", "0");
  maskEl.setAttribute("width", "100%");
  maskEl.setAttribute("height", "100%");
  const all = document.createElementNS(SVG_NS, "rect");
  all.setAttribute("width", "100%");
  all.setAttribute("height", "100%");
  all.setAttribute("fill", "#fff");
  maskEl.appendChild(all);
  defs.appendChild(maskEl);
  const sheet = document.createElementNS(SVG_NS, "rect");
  sheet.setAttribute("class", "sheet");
  sheet.setAttribute("width", "100%");
  sheet.setAttribute("height", "100%");
  sheet.setAttribute("style", "fill:var(--bg)");
  sheet.setAttribute("mask", `url(#${MASK_ID})`);
  svg.append(defs, sheet);
  overlayEl.appendChild(svg);
  document.body.appendChild(overlayEl);
  addListeners();
  return overlayEl;
}

function teardownOverlay() {
  if (overlayEl) overlayEl.remove();
  overlayEl = null;
  maskEl = null;
  holes.clear();
  lastSig = null;
  removeListeners();
}

/**
 * Shows the veil, fading it in to `options.opacity` (default the ratified
 * 0.62). Mounts the overlay once; calling this again while it is already
 * showing just cancels any pending hide.
 *
 * @param {{ opacity?: number }} [options]
 */
export function showVeil(options = {}) {
  const el = ensureOverlay();
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  visible = true;
  const instant = stillMotion();
  el.style.transition = instant ? "none" : `opacity ${FADE_MS}ms ease`;
  if (!instant) void el.offsetHeight; /* force layout so opacity 0→n actually transitions */
  el.style.opacity = String(options.opacity ?? OPACITY);
  syncHoleSet(); /* a hide cancelled mid-fade left the old holes behind */
  if (targets.length > 0) scheduleLoop();
}

/**
 * Hides the veil (fading it out first, unless reduced motion) and removes
 * the overlay from the document. Also clears the current lit targets and
 * stops the re-measure loop — there is nothing left to watch once nothing is
 * showing.
 */
export function hideVeil() {
  visible = false;
  stopLoop();
  targets = [];
  if (!overlayEl) return;
  const el = overlayEl;
  const instant = stillMotion();
  el.style.transition = instant ? "none" : `opacity ${FADE_MS}ms ease`;
  el.style.opacity = "0";
  if (instant) {
    teardownOverlay();
    return;
  }
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    teardownOverlay();
  }, FADE_MS);
}

/**
 * Sets which elements are currently lit — i.e. which holes the veil should
 * show. Call with an empty array (or nothing) to go back to a plain dark
 * sheet. Each entry is either the element itself, or `{ el, round, pad,
 * radius }` for per-hole shape; `options` gives the defaults every entry
 * that does not override them falls back to.
 *
 * @param {(Element | { el: Element, round?: boolean, pad?: number, radius?: number })[]} elements
 * @param {{ round?: boolean, pad?: number, radius?: number }} [options]
 */
export function veilTargets(elements, options = {}) {
  targets = (elements ?? []).map((entry) => normalize(entry, options));
  lastSig = null; /* force a repaint even if the new geometry matches the old */
  ensureOverlay();
  syncHoleSet();
  updateHoles();
  if (visible && targets.length > 0) scheduleLoop();
  else stopLoop();
}
