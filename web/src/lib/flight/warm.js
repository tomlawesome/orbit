/*
 * READYING THE FLIGHT BEFORE IT IS ASKED FOR (#1253).
 *
 * The flight's world (voyage.js) costs a shader compile and a few pictures
 * put on the GPU. That work is queued as chores (chores.js) and never begins
 * until the page says so:
 *
 *   · the door (SignIn.svelte) asks once its card is showing and its first
 *     light has finished drawing in, unhurried, so the work is done in idle
 *     moments and waits while someone types; and hurries it when the sign-in
 *     is submitted. The page then leaves for the landing, so what this buys
 *     is the browser's own caches -- the pictures in its HTTP cache, the
 *     compiled programs in its shader cache -- for the landing's flight. A
 *     browser that compiles on the page's own thread (no
 *     KHR_parallel_shader_compile: Firefox) would freeze the door for the
 *     length of the compile, so there the door fetches the pictures only;
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
 * The door never draws the world's test frames either (`prove: false`):
 * those wait for the flight itself.
 */
import { chore, fetchOnce, hurryChores, openChores } from "./chores.js";
import { fetchVoyage, voyageOnce } from "./voyage.js";
import { gpu } from "./fitness.js";

const EARTH = "/flight/door/dawn.webp";

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** @type {Promise<void> | null} */
let asked = null;
/** the page's world, once the chore that makes it has run
 * @type {{ warm: (how?: { prove?: boolean }) => Promise<unknown> } | null} */
let readied = null;
/** whether the world's test frames have been asked for
 * @type {Promise<unknown> | null} */
let proving = null;

/**
 * @param {{ hurry?: boolean, gentle?: boolean, prove?: boolean }} [how]
 *   hurry: the flight is wanted now. gentle: only where the compile cannot
 *   stop the page (the door). prove: false leaves the world's test frames
 *   for the flight (the door); a later call that proves still gets them run
 *   (#1222), so the arrival can have them done before its answers are back.
 */
export function readyFlight({ hurry = false, gentle = false, prove = true } = {}) {
  if (reduced() || typeof document === "undefined") return Promise.resolve();
  /* a reader who has asked the browser to save data is not warmed for (orbit-site
     main.js:70). Only the speculative asks (`gentle`: the door's, and home's on
     its first tap): the flight itself, once it starts, still asks for what it
     needs, and `asked` is left unset so that call is not shut out. */
  if (gentle && /** @type {any} */ (navigator).connection?.saveData) return Promise.resolve();
  if (!asked) {
    fetchOnce(EARTH).catch(() => {});
    asked = chore(() => gpu(), 60, "flight").then((g) => {
      if (!g) return null;
      fetchVoyage();
      if (gentle && !g.parallel) return null;
      /* the world made (its shaders set compiling) as a chore of its own, so
         even that waits for the page's say-so */
      return chore(() => {
        /* wrapped, so this chore ends here: the warm-up queues chores of its
           own, and a chore that waited on them would never let them run */
        const world = voyageOnce();
        readied = world;
        return { warming: world ? world.warm({ prove }) : null };
      }, 60, "flight").then(({ warming }) => warming);
    }).then(() => {}, () => {});
    if (prove) proving = asked;
  }
  /* an earlier call that did not prove (the door's) left the test frames
     undone: run them now that someone wants them. Where the world was never
     made (the GPU refused, or a gentle ask without parallel compile) there is
     nothing to prove; `warm` remembers its own answer, so this is once. */
  if (prove && !proving) {
    proving = asked.then(() => (readied
      ? chore(() => ({ done: readied?.warm({ prove: true }) }), 60, "flight").then(({ done }) => done)
      : null)).then(() => {}, () => {});
  }
  if (hurry) hurryChores("flight"); else openChores();
  return asked;
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
 * reveal that is still being drawn (#1299). The same wait as SignIn.svelte's
 * `drawnIn`, which that file keeps for the door.
 *
 * It is the door's own ask (gentle, no test frames): never under save-data,
 * never a compile that would stop the page, and a call that comes after the
 * sign-out has begun readying finds `asked` set and does nothing more.
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
const drawnIn = () => {
  try {
    const ends = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime) && painted(a));
    return Promise.all(ends.map((a) => a.finished.catch(() => {})));
  } catch { return Promise.resolve([]); }
};

/**
 * @param {{ after?: number }} [how]  after: ms from now (orbit-site's 4000)
 * @returns {() => void} stops it, if the page is left first
 */
export function readyFlightAtLeisure({ after = 4000 } = {}) {
  let off = false;
  const timer = setTimeout(() => {
    drawnIn().then(() => { if (!off) readyFlight({ gentle: true, prove: false }); });
  }, after);
  return () => { off = true; clearTimeout(timer); };
}
