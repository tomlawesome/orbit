/**
 * THE WALK ITSELF (#752, slice 2 of #477).
 *
 * Framework-free on purpose, and for the reason home.behaviour.js gives: the
 * markup is Svelte's, the DOM work is the tour's. Everything this module
 * needs from the outside is passed in — the document, the stop list, how to
 * navigate, how to record that the walk is over — so the whole state machine
 * can be driven by a unit test in a bare DOM, which is where the ratified
 * rules are pinned (tests/unit/v19-tour-*.test.mjs).
 *
 * What it does at each stop: put the reader on the screen the stop names,
 * draw or remove the example body, lift the target and drop the rest of the
 * screen behind it, point the target's `aria-describedby` at the card's own
 * copy, put the target on screen, and give the card focus.
 *
 * What it does when the walk ends, whether by *Skip* or by *Finish*: take
 * every mark off the screen, remove the example, and record `tourSeenAt`
 * once. That single write is the only request the tour ever makes.
 */
import { applyEmphasis, clearEmphasis, emphasisModeOf, packOf } from "./emphasis.js";
import { countBodies, drawExampleBody, needsExampleBody, removeExampleBody } from "./example.js";
import { TOUR_REGIONS, copyOf, targetOf } from "./stops.js";

/** The class the emphasis rules in tour.css hang off while a walk is running. */
export const RUNNING_CLASS = "tour-running";

/** The card's two copy lines, by id — what a lit element is described by. */
export const CARD_COPY_IDS = "tour-copy-1 tour-copy-2";

/**
 * @typedef {object} TourView
 * @property {string} id
 * @property {number} index    zero-based
 * @property {number} number   one-based, as the card says it
 * @property {number} total
 * @property {boolean} first
 * @property {boolean} last
 * @property {[string, string]} copy
 */

/**
 * @param {object} options
 * @param {Document} options.doc
 * @param {import("./stops.js").TourStop[]} options.stops the cut already made for this viewport
 * @param {Record<string, string[]>} [options.regions]
 * @param {boolean} [options.phone]
 * @param {() => string} [options.routeOf]        where the reader is now
 * @param {(route: string) => Promise<unknown>} [options.navigate]
 * @param {() => Promise<unknown>} [options.writeSeen] records tourSeenAt, once, at the end
 * @param {(view: TourView | null) => void} [options.onChange] hands the card its state; null when over
 * @param {() => Element | null} [options.cardOf]
 * @param {() => Promise<unknown>} [options.settle] resolves once the card has re-rendered
 * @param {number} [options.patience] milliseconds to wait for a screen to arrive
 */
export function createTour({
  doc,
  stops,
  regions = TOUR_REGIONS,
  phone = false,
  routeOf = () => doc.location.pathname,
  navigate = async () => {},
  writeSeen = async () => {},
  onChange = () => {},
  cardOf = () => doc.querySelector(".tourcard"),
  settle = async () => {},
  patience = 4000,
}) {
  let index = 0;
  let running = false;
  let written = false;
  /** Guards against a second stop starting while the first is still arriving. */
  let generation = 0;

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (!running) return;
    if (event.key === "Escape") { event.preventDefault(); void skip(); }
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); void go(1); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); void go(-1); }
  }

  /** Resolves as soon as `ready()` is true, or when patience runs out. */
  function waitFor(/** @type {() => boolean} */ ready) {
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (ready()) return resolve(true);
        if (Date.now() - started >= patience) return resolve(false);
        setTimeout(tick, 50);
      };
      setTimeout(tick, 25);
    });
  }

  /** @param {number} next */
  async function render(next) {
    const mine = ++generation;
    index = Math.max(0, Math.min(stops.length - 1, next));
    const stop = stops[index];

    if (routeOf() !== stop.route) {
      await navigate(stop.route);
      if (mine !== generation || !running) return;
    }
    /* The screen is rendered by its own route, from its own data, so the stop
       waits for it rather than assuming the navigation finished the job. */
    const here = regions[stop.route] ?? [];
    await waitFor(() => routeOf() === stop.route && here.some((one) => doc.querySelector(one)));
    if (mine !== generation || !running) return;

    const example = needsExampleBody(stop, { bodyCount: countBodies(doc) });
    if (example) drawExampleBody(doc);
    else removeExampleBody(doc);

    onChange({
      id: stop.id,
      index,
      number: index + 1,
      total: stops.length,
      first: index === 0,
      last: index === stops.length - 1,
      copy: copyOf(stop, { example }),
    });
    /* The card's copy has to be in the document before anything is described
       by it, and before focus lands on it. */
    await settle();
    if (mine !== generation || !running) return;

    const lit = applyEmphasis(doc, {
      regions: here,
      target: targetOf(stop, { phone }),
      mode: emphasisModeOf(packOf(doc)),
    });
    for (const element of lit) element.setAttribute("aria-describedby", CARD_COPY_IDS);
    /* Full brightness is no use off the bottom of the page. */
    lit[0]?.scrollIntoView?.({ block: "center", behavior: "auto" });
    /** @type {HTMLElement | null} */ (cardOf())?.focus?.();
  }

  async function start() {
    if (running) return;
    running = true;
    doc.body.classList.add(RUNNING_CLASS);
    doc.addEventListener("keydown", onKeydown);
    await render(0);
  }

  /** Back and Next. Past the last stop, Next IS Finish. */
  async function go(/** @type {number} */ delta) {
    if (!running) return;
    if (index + delta > stops.length - 1) return finish();
    if (index + delta < 0) return;
    await render(index + delta);
  }

  /**
   * The end of the walk, by either door. The record is written once — a
   * second call cannot double-write, and nothing else here talks to a server.
   */
  async function end() {
    if (!running) return;
    running = false;
    generation++;
    doc.removeEventListener("keydown", onKeydown);
    doc.body.classList.remove(RUNNING_CLASS);
    clearEmphasis(doc);
    removeExampleBody(doc);
    onChange(null);
    if (written) return;
    written = true;
    await writeSeen();
  }

  const skip = end;
  const finish = end;

  return {
    start,
    go,
    skip,
    finish,
    /** Leaves the screen as it found it WITHOUT recording the walk as taken. */
    destroy() {
      running = false;
      generation++;
      doc.removeEventListener("keydown", onKeydown);
      doc.body.classList.remove(RUNNING_CLASS);
      clearEmphasis(doc);
      removeExampleBody(doc);
    },
    get index() { return index; },
    get running() { return running; },
  };
}
