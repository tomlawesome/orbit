/*
 * THE JOURNEY'S CLOCK (#1253; ported from orbit-site's flight.js).
 *
 * Real time, except that a stall -- the page busy for a moment: a picture
 * put on the GPU, a shader made ready -- is counted as no more than a frame
 * or so. The flight (engine.js, options.now) and its beats (timeline.js,
 * runTimeline's schedule/cancel) both keep this time, so a stall pauses the
 * journey where it is rather than skipping it ahead to the landing.
 *
 * App change: a stall is capped only while `stalls(true)` is set -- the
 * flight sets it while its WebGL2 world is drawing. Otherwise the clock is
 * real time, as the flight always kept, so a machine that simply draws
 * slowly finishes the journey on time rather than stretching it.
 *
 * A HOLD stops the clock at a point in the journey until something it needs
 * has come (Flight.svelte gives it the flight's world), so a journey can
 * start the moment it is asked for and still never draw before it is ready.
 * A hold lets go by itself after `cap` milliseconds.
 */

/**
 * @param {{ now?: () => number, frame?: (fn: () => void) => number, cancelFrame?: (id: number) => void }} [env]
 */
export function journeyClock(env = {}) {
  const real = env.now ?? (() => performance.now());
  const frame = env.frame ?? ((fn) => requestAnimationFrame(fn));
  const cancelFrame = env.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  let t = 0, last = real(), raf = 0, cap = Infinity;
  /** @type {{ at: number, done: boolean } | null} */
  let hold = null;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const pending = new Map();
  let ids = 0;
  const now = () => {
    const p = real(); t += Math.min(cap, Math.max(0, p - last)); last = p;
    if (hold && !hold.done && t > hold.at) t = hold.at;
    return t;
  };
  const poll = () => {
    raf = 0; const at = now();
    for (const [id, b] of pending) if (b.at <= at) { pending.delete(id); b.fn(); }
    if (pending.size) raf = frame(poll);
  };
  return {
    now,
    /** count a stall as a frame or so (true), or keep real time (false) @param {boolean} on */
    stalls(on) { now(); cap = on ? 64 : Infinity; },
    /** @param {() => void} fn @param {number} ms */
    schedule(fn, ms) {
      const id = ++ids; pending.set(id, { at: now() + ms, fn });
      if (!raf) raf = frame(poll);
      return /** @type {any} */ (id);
    },
    /** @param {any} id */
    cancel(id) { pending.delete(id); },
    /** stop everything still pending (the component is going) */
    dispose() { pending.clear(); if (raf) cancelFrame(raf); raf = 0; },
    /**
     * Hold the clock `ms` from now until `until` settles (or `cap` ms pass).
     * @param {number} ms @param {Promise<unknown>} until @param {number} [cap]
     */
    holdAt(ms, until, cap = 8000) {
      const h = { at: now() + ms, done: false }; hold = h;
      const free = () => { h.done = true; };
      until.then(free, free); setTimeout(free, cap);
      return h;
    },
  };
}
