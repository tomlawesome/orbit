/*
 * FIRST LIGHT, WHEN IT HAPPENS (#1253; owner, 2026-10-07: the site's own
 * timing). Ported from orbit-site's `showDoor` (assets/js/main.js:157-235,
 * c189d38), without the wait on shader compilation the app does not have: the
 * flight's warming is warm.js's and chores.js's, started by SignIn.svelte once
 * the door is lit and drawn.
 *
 * The door's sunrise is CSS transitions and animations started by `body.lit`
 * (flight.css), so everything is counted from `lit`. `lit` itself does not
 * wait on a clock: it waits for what the door is made of.
 *
 *   · the fonts and the Earth's first picture (`dawn-pre`), the two pieces
 *     that would change the door's face as they arrived;
 *   · while they come, the ring is a light running its circle (`body.loading`,
 *     the runner), a lap at a time. When they have come it finishes the lap it
 *     is on, then goes straight into its own drawing;
 *   · on a first visit it always runs at least one lap, so the first sight of
 *     the door is the light and then the ring drawn, never the ring at once;
 *   · it is given a quarter of a second to find everything there already, and
 *     on a visit that is not the first it then lights at once;
 *   · it never waits for ever: seven laps, or 13 s, and the door lights
 *     regardless (and without the runner's motion, under reduced motion, on
 *     the pieces alone, up to 8 s).
 */

/** The longest the door waits for a lap-less start to find its pieces in. */
export const GRACE_MS = 250;

/** Laps of the runner after which the door lights whatever has not come. */
export const MAX_LAPS = 7;

/** The hard stop: the door lights this long after the wait began. */
export const BACKSTOP_MS = 13000;

/** The longest the ring runs on for the flight's shaders (the site's 9 s). */
export const COMPILE_CAP_MS = 9000;

/** The longest the pieces are waited for when the runner has no motion. */
export const STILL_WAIT_MS = 8000;

/** localStorage key: when this browser last saw the door. */
export const SEEN_KEY = "orbit-door-seen";

/** A browser that has not seen the door for this long sees a first visit again. */
export const SEEN_FRESH_MS = 36 * 3600e3;

/**
 * Whether this is a first visit: nothing seen, or nothing seen for 36 hours
 * (the pictures are no longer kept, so the door has to come again). Records
 * this visit. A browser that will not say is a first visit.
 * @param {Pick<Storage, "getItem" | "setItem"> | undefined} storage
 * @param {number} [now]
 */
export function isFirstVisit(storage, now = Date.now()) {
  try {
    if (!storage) return true;
    const seen = storage.getItem(SEEN_KEY);
    storage.setItem(SEEN_KEY, String(now));
    return !seen || now - Number(seen) > SEEN_FRESH_MS;
  } catch { return true; }
}

/**
 * A promise, or nothing at all, waited for at most `ms`.
 * @param {Promise<unknown> | undefined} p
 * @param {number} ms
 * @returns {Promise<unknown>}
 */
export function within(p, ms) {
  return Promise.race([Promise.resolve(p).catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}

/**
 * Resolves when the Earth's first picture has arrived or failed to (a missing
 * picture must not hold the door dark), at once if it already has. `world`
 * carries `data-earth="settled"` from Dawn.svelte once either has happened.
 * @param {Element | null} world
 * @returns {Promise<void>}
 */
export function earthSettled(world) {
  const pre = world?.querySelector(".earth image.pre");
  if (!world || !pre || /** @type {HTMLElement} */ (world).dataset.earth === "settled") return Promise.resolve();
  return new Promise((resolve) => {
    pre.addEventListener("load", () => resolve(), { once: true });
    pre.addEventListener("error", () => resolve(), { once: true });
  });
}

/**
 * Starts the wait for first light and calls `light` when it is over, in a
 * frame of its own.
 * @param {object} o
 * @param {Promise<unknown>} o.critical the pieces first light waits for (fonts, the Earth)
 * @param {Pick<EventTarget, "addEventListener" | "removeEventListener"> | null} o.runner the ring's running light
 * @param {number} o.minLaps whole laps to run first (1 on a first visit)
 * @param {() => void} o.loading the pieces are not all here: shows the runner (`body.loading`)
 * @param {() => boolean} o.animated whether the runner has motion; asked after `loading` has run
 * @param {() => void} o.light first light
 * @param {(() => Promise<unknown>) | null} [o.compile] where shaders would stop the page: asked for once the
 *   pieces are here and the ring is running (two frames on), and waited for (at most COMPILE_CAP_MS) before
 *   first light; the caller also owes at least one lap (minLaps) so the ring is there to hide the pause
 * @returns {() => void} stops everything still pending
 */
export function startFirstLight({ critical, runner, minLaps, loading, animated, light, compile = null }) {
  let here = false;
  let lit = false;
  let stopped = false;
  let laps = 0;
  /** @type {ReturnType<typeof setTimeout>[]} */
  const timers = [];
  const go = () => {
    if (lit || stopped) return;
    lit = true;
    runner?.removeEventListener("animationiteration", lap);
    requestAnimationFrame(() => { if (!stopped) light(); });
  };
  /* a lap has ended: light if the pieces are here and the laps are run, or if it has been long enough */
  const lap = () => {
    laps++;
    if ((here && laps >= minLaps) || laps >= MAX_LAPS) go();
  };
  /* the shaders' compile, once the pieces are here AND the ring is up and
     running (two frames on): the pause is spent behind the ring, never before
     it is seen. Until it is done the pieces are not "here" for the lap. */
  let pieces = false;
  let ringUp = false;
  let compiling = false;
  const compileBehind = () => {
    if (!compile || compiling || !pieces || !ringUp || stopped) return;
    compiling = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (stopped) return;
      let started;
      try { started = compile(); } catch { started = undefined; }
      within(started, COMPILE_CAP_MS).then(() => { here = true; });
    }));
  };
  const arrived = () => { pieces = true; if (compile) compileBehind(); else here = true; };
  critical.then(arrived, arrived);
  within(critical, GRACE_MS).then(() => {
    if (stopped) return;
    if (here && !minLaps) { go(); return; }
    loading();
    ringUp = true;
    compileBehind();
    runner?.addEventListener("animationiteration", lap);
    /* without the runner's motion there are no laps: just the pieces */
    if (!runner || !animated()) within(critical, STILL_WAIT_MS).then(go);
    timers.push(setTimeout(go, BACKSTOP_MS));
  });
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    runner?.removeEventListener("animationiteration", lap);
  };
}
