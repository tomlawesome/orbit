/*
 * THE FLIGHT'S BACKGROUND WORK, A PIECE AT A TIME (#1253; ported from
 * orbit-site's assets/js/chores.js).
 *
 * Readying the flight's world is heavy for the page: pictures put on the GPU,
 * shaders made, frames drawn so the driver has everything it needs. Done all
 * at once it stutters whatever is moving. So each piece is a chore, queued
 * here and done one at a time, each in a pause between frames, with a few
 * frames' rest between one and the next, and none at all until the page says
 * the work may begin (openChores): on the door, once its card is showing and
 * its first light has finished drawing in.
 *
 * The network is not a chore: pictures are fetched (and decoded) as soon as
 * they are asked for, off the page's own thread; only what touches the page
 * or the GPU waits its turn.
 *
 * When the flight is wanted (hurryChores) what it still needs is done
 * straight away, a frame between each piece. The measures (frames timed to
 * fit the drawing to the machine: tag "measure") are never hurried.
 *
 * App addition: an unhurried chore also waits while someone is typing, so a
 * texture upload never lands between a keystroke and its echo.
 */

/** @typedef {{ fn: () => unknown, resolve: (v: any) => void, reject: (e: unknown) => void, rest: number, tag: string }} Job */

/** @type {Job[]} */
const queue = [];
let open = false, running = false, lastInput = -Infinity;
/** @type {string[] | null} */
let want = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let wake;
const TYPING_QUIET = 600;

/* a pause between frames, but never waited on long: while the door moves the
   browser may rarely call a moment idle */
/** @param {() => void} fn */
const idle = (fn) => (typeof requestIdleCallback === "function"
  ? requestIdleCallback(fn, { timeout: 250 })
  : setTimeout(fn, 30));
/* the order the rest are done in: the flight first, the measures last */
const ORDER = ["flight", "", "measure"];
/** @param {string} tag */
const rank = (tag) => { const i = ORDER.indexOf(tag); return i < 0 ? ORDER.length : i; };

if (typeof addEventListener === "function") {
  /* capture, so a field that stops propagation still counts as typing */
  for (const type of ["keydown", "input", "compositionupdate"]) {
    addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
  }
}

function pump() {
  if (running || !queue.length) return;
  const now = performance.now();
  /* what the wanted flight needs, first */
  let i = want ? queue.findIndex((j) => /** @type {string[]} */ (want).includes(j.tag)) : -1;
  const hurried = i >= 0;
  if (!hurried) {
    if (!open) return;
    /* someone is typing: wait until they pause */
    if (now - lastInput < TYPING_QUIET) {
      clearTimeout(wake); wake = setTimeout(pump, TYPING_QUIET - (now - lastInput) + 20);
      return;
    }
    i = 0;
    for (let k = 1; k < queue.length; k++) if (rank(queue[k].tag) < rank(queue[i].tag)) i = k;
  }
  running = true;
  const run = () => {
    const [job] = queue.splice(Math.min(i, queue.length - 1), 1);
    let out;
    try { out = job.fn(); } catch (e) { out = Promise.reject(e); }
    Promise.resolve(out).then(job.resolve, job.reject).finally(() => {
      running = false;
      /* a rest between chores: a couple of frames, so whatever is moving
         keeps moving; hurried, still a frame */
      requestAnimationFrame(() => setTimeout(pump, hurried ? 0 : job.rest));
    });
  };
  if (hurried) setTimeout(run, 0); else idle(run);
}

/**
 * Queue a piece of work (tag says what it readies); resolves with what it
 * returns, or what its promise resolves to.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {number} [rest]
 * @param {string} [tag]
 * @returns {Promise<T>}
 */
export function chore(fn, rest = 60, tag = "") {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject, rest, tag }); pump(); });
}
/** The page is ready for the work to begin. */
export function openChores() { open = true; pump(); }
/** The flight is wanted: what it needs (its tags) is done now. @param {string | string[]} tags */
export function hurryChores(tags) {
  want = [].concat(/** @type {any} */ (tags || []));
  open = true; pump();
}

/* the pictures, fetched once for whatever wants them, and asked for as early
   as is wanted: the network is never a chore */
/** @type {Map<string, Promise<Blob>>} */
const fetched = new Map();
/** @param {string} url @returns {Promise<Blob>} */
export function fetchOnce(url) {
  if (!fetched.has(url)) {
    fetched.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); }));
  }
  return /** @type {Promise<Blob>} */ (fetched.get(url));
}

/* how long the readying took, in the console: the first visit's GPU work
   differs greatly between machines and browsers, and this says where the
   time went */
/** @param {string} what @param {number} [since] */
export function note(what, since = 0) {
  try {
    console.info(`orbit · ${what}: ${Math.round(performance.now() - since)} ms${since ? "" : " after opening"}`);
  } catch { /* fine */ }
}
