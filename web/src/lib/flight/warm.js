/*
 * READYING THE FLIGHT BEFORE IT IS ASKED FOR (#1253).
 *
 * The flight's world costs a shader compile and a few pictures put on the
 * GPU. That work is queued as the shared door's chores and never begins
 * until the page says so:
 *
 *   · the door (SignIn.svelte) asks once its card is showing and its first
 *     light has finished drawing in, unhurried, so the work is done in idle
 *     moments and waits while someone types; and hurries it when the sign-in
 *     is submitted. The page then leaves for the landing, so what this buys
 *     is the browser's own caches -- the pictures in its HTTP cache, the
 *     compiled programs in its shader cache -- for the landing's flight. A
 *     browser that compiles on the page's own thread (no
 *     KHR_parallel_shader_compile: Firefox, Safari) would freeze the door
 *     for the length of the compile, so there the compile is done behind
 *     first light's running ring, as orbit-site does (`compileFlightNow`,
 *     held by the shared door's `dawn.light()`, at most 9 s; #1299), never
 *     on the drawn door. Only where the door has a journey on it (the
 *     arrival's climb): the bare door has no world to make, and fetches its
 *     pictures alone (below);
 *   · home asks, hurried, when the sign-out is armed (its first tap), so the
 *     descent has its world by the time the second tap has revoked the
 *     session; and long before that, unhurried, a few seconds after it has
 *     arrived and its painted animations are done (`readyFlightAtLeisure`,
 *     #1299), as orbit-site readies its journeys on any page but the door:
 *     a descent that waits for nothing has found its world already made;
 *   · the arrival (`/`, Arrival.svelte) asks, hurried, the moment it knows a
 *     launch is owed -- before its session and workspace answers -- and asks
 *     again, proving, once the session says this reader will fly here (#1222);
 *   · the flight itself asks, hurried, when a journey starts (Flight.svelte).
 *
 * Under reduced motion there is no flight, so nothing is readied.
 *
 * FIRST, WHETHER THE GPU MAY BE USED AT ALL (fitness.js `gpu()`, #1253): one
 * context, made as a chore of its own. Refused (a performance caveat, a
 * software renderer), the flight is drawn on its own canvas and nothing more
 * is asked of the GPU on this page, nor are the world's pictures fetched.
 *
 * THE WORLD IS THE SHARED DOOR'S NOW (#1371): it belongs to the page's
 * journey (the folder's `door.journey()`, made by Flight.svelte, which hands
 * it over with `useJourney`), and this module only decides WHEN to call its
 * `warm()` (#1371 note 33895). A page with no journey on it (the door) fetches
 * the world's pictures, for the landing's flight to find in the browser's
 * cache; a journey mounted later is made then, if a call has already said
 * it may be.
 *
 * #1371: waits for ai/orbit-site#2 -- the folder takes over `gpu()`, the
 * world's test frames (`journey.warm({ prove })`) and the unhurried warming
 * (`journey.later()`); fitness.js and this split then go. Until then `prove`
 * is accepted and has no effect: the folder's warm() runs no test frames.
 */
import { chore, fetchOnce, hurryChores, openChores, image, flightPictures } from "$lib/door-host.js";
import { gpu } from "./fitness.js";

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** the page's GPU verdict, asked for once (the first call's chore)
 * @type {Promise<import("./fitness.js").Gpu | null> | null} */
let asked = null;
/** @typedef {{ warm: () => Promise<unknown>, compiled: () => Promise<unknown> }} Journey */
/** the page's journey, while one is mounted
 * @type {Journey | null} */
let journey = null;
/** whether a call has said the world may be made (a journey mounted later is made at once) */
let allowed = false;
/** the journey's world being made, once a call that may make it has queued it
 * @type {Promise<unknown> | null} */
let making = null;
/** set when the world's shaders are made (or it was never going to be) */
let compiledSignal = () => {};
const compiledSoon = new Promise((resolve) => { compiledSignal = () => resolve(undefined); });

/** the journey's world made (its shaders set compiling), as a chore of its own so even that waits for the page's say-so */
function make() {
  if (!journey) return null;
  if (!making) {
    const j = journey;
    /* wrapped, so this chore ends here: the warm-up queues chores of its own,
       and a chore that waited on them would never let them run */
    making = chore(() => ({ warming: j.warm() }), 60, "flight").then(({ warming }) => {
      j.compiled().then(compiledSignal, compiledSignal);
      return warming;
    });
  }
  return making;
}

/**
 * The page's journey, from Flight.svelte as it mounts. A call that has
 * already said the world may be made has it made now.
 * @param {Journey} j
 * @returns {() => void} the journey let go, as Flight.svelte unmounts
 */
export function useJourney(j) {
  journey = j;
  making = null;
  if (allowed) make();
  return () => { if (journey === j) { journey = null; making = null; } };
}

/**
 * @param {{ hurry?: boolean, gentle?: boolean, prove?: boolean, compile?: boolean }} [how]
 *   hurry: the flight is wanted now. gentle: only where the compile cannot
 *   stop the page (the door), and never under save-data. compile: with
 *   gentle, make the world even where the browser compiles on the page's own
 *   thread (Firefox, Safari), for a caller that has chosen a quiet moment for
 *   the pause (#1299). prove: waits for ai/orbit-site#2 (above).
 *
 * Every call is judged by its own options, whoever asked first: a gentle ask
 * that was refused a world on a browser that compiles on the page's thread
 * leaves the way open for a later ask that may make it (the flight's own),
 * and a world already made or queued is never made twice (#1299).
 */
export function readyFlight({ hurry = false, gentle = false, compile = false } = {}) {
  if (reduced() || typeof document === "undefined") return Promise.resolve();
  /* a reader who has asked the browser to save data is not warmed for (orbit-site
     main.js:70). Only the speculative asks (`gentle`: the door's, and home's on
     its first tap): the flight itself, once it starts, still asks for what it
     needs, and `asked` is left unset so that call is not shut out. */
  if (gentle && /** @type {any} */ (navigator).connection?.saveData) return Promise.resolve();
  if (!asked) {
    fetchOnce(image("dawn/dawn.webp")).catch(() => {});
    asked = chore(() => gpu(), 60, "flight").then((g) => {
      if (g) for (const url of flightPictures()) fetchOnce(url).catch(() => {});
      else compiledSignal();
      return g;
    });
    asked.catch(() => compiledSignal());
  }
  const result = asked.then((g) => {
    if (!g || (gentle && !g.parallel && !compile)) return null;
    allowed = true;
    return make();
  }).then(() => {}, () => {});
  if (hurry) hurryChores("flight"); else openChores();
  return result;
}

/**
 * Whether making the flight's world here would stop the page for the length
 * of the compile: a browser that compiles on the page's own thread (no
 * KHR_parallel_shader_compile: Firefox, Safari), where the page may use the
 * GPU at all, and the reader has asked for neither reduced motion nor
 * save-data. The door holds its first light's ring for it (#1299). Asks the
 * page's one GPU verdict (fitness.js), which is the same context the world
 * then uses.
 */
export function compileStopsPage() {
  if (reduced() || typeof document === "undefined") return false;
  if (/** @type {any} */ (navigator).connection?.saveData) return false;
  const g = gpu();
  return !!g && !g.parallel;
}

/**
 * Make the world now, hurried, behind the door's running ring (#1299), and
 * resolve when its shaders are compiled (not when the whole warm-up is done).
 * The caller bounds the wait.
 */
export function compileFlightNow() {
  const done = readyFlight({ hurry: true, gentle: true, compile: true, prove: false });
  return Promise.race([compiledSoon, done]);
}

/**
 * The sign-in was submitted: the flight is wanted on the next page, so
 * whatever is still queued for it goes first (and starts now, if the door had
 * not got to it yet). Still never a compile that would stop the page.
 */
export function hurryFlight() {
  return readyFlight({ hurry: true, gentle: true, prove: false });
}

/*
 * orbit-site's "a little later" (main.js: `setTimeout(() => { warmJourneys();
 * openChores(); }, 4000)` on arriving anywhere but the door), for a page that
 * is not the door: the flight's world is readied once the page has had a few
 * seconds and its painted animations have finished, so the chores (which
 * touch the GPU, and a compile on the page's own thread) never run under a
 * reveal that is still being drawn (#1299). The same wait as the door's (SignIn.svelte
 * imports `drawnIn` from here).
 *
 * It is the door's own ask (gentle, no test frames): never under save-data
 * or reduced motion. Where the browser compiles on the page's own thread
 * (Firefox) it still makes the world, as orbit-site does: one pause of about
 * a second while the page is quiet, which is the owner's choice (#1299). A
 * call that comes after the world is made or queued does nothing more.
 */
const COMPOSITED = new Set(["transform", "opacity", "offset", "easing", "composite", "computedOffset"]);
/** @param {Animation} a */
const painted = (a) => {
  try {
    const t = /** @type {KeyframeEffect} */ (a.effect).target;
    if (typeof SVGElement === "function" && t instanceof SVGElement && !(t instanceof SVGSVGElement)) return true;
    const tp = /** @type {any} */ (a).transitionProperty;
    const props = tp ? [tp] : /** @type {KeyframeEffect} */ (a.effect).getKeyframes().flatMap(Object.keys);
    return props.some((k) => !COMPOSITED.has(k));
  } catch { return true; }
};
export const drawnIn = () => {
  try {
    const ends = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime) && painted(a));
    return Promise.all(ends.map((a) => a.finished.catch(() => {})));
  } catch { return Promise.resolve([]); }
};

/** the leisure asks still waiting to be made, each by its own stop
 * @type {Set<() => void>} */
const leisure = new Set();

/**
 * @param {{ after?: number }} [how]  after: ms from now (orbit-site's 4000)
 * @returns {() => void} stops it, if the page is left first
 */
export function readyFlightAtLeisure({ after = 4000 } = {}) {
  let off = false;
  const stop = () => { off = true; clearTimeout(timer); leisure.delete(stop); };
  const timer = setTimeout(() => {
    drawnIn().then(() => { if (!off) { leisure.delete(stop); readyFlight({ gentle: true, compile: true, prove: false }); } });
  }, after);
  leisure.add(stop);
  return stop;
}

/**
 * The descent has begun (Leave.svelte): a leisure ask not yet made is
 * dropped. A sign-out within a few seconds of arriving would otherwise have
 * it fire mid-descent, and where the browser compiles on the page's own
 * thread (Firefox) that is a pause of over a second in the middle of the
 * flight (#1299). The descent never waits for its world: it flies the world
 * if it is already made, and its own canvas if not, as ever.
 */
export function stopLeisure() {
  for (const stop of [...leisure]) stop();
}
