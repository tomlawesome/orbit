/**
 * THE FILM CLOCK (#866).
 *
 * The one-take tour is a coroutine: twelve chapters awaited back to back,
 * with nothing between them. Everything that takes time in that coroutine —
 * a wait, a tween, a typed character, the transport's own playhead — hangs
 * off THIS clock and never off the wall clock, which is what makes the film
 * pausable at all. Pause simply stops advancing the cursor; every promise
 * already waiting on it stays waiting, mid-word, mid-move.
 *
 * Carried from the ratified mockup's own clock
 * (design/v19/tour/round-5/f-one-take.html, "---- the clock ----"), which is
 * the specification. Two positions, not one:
 *
 *   `cursor` is where the FILM is — advanced by real elapsed time each frame
 *            while playing, and the only thing the transport paints from;
 *   `sched`  is where the COROUTINE has got to, exactly. Each `wait` adds its
 *            own length to `sched` and fires at that mark, so a frame that
 *            overshoots by 4ms is not paid for twice: the overshoot never
 *            accumulates into drift across a 3:41 film.
 *
 * THE DRY RUN. The transport needs every chapter's start offset before the
 * film plays a single frame, so the ticks land where their chapters actually
 * start. It gets them by running the whole film once with `dry` set: every
 * `wait` returns an already-resolved promise and adds its length to `budget`
 * instead, so twelve chapters measure themselves in a few microtasks. The
 * chapter code is identical in both modes — the vocabulary stubs the DOM out
 * (see vocabulary.js) rather than the chapter branching — which is the only
 * way the measured budget can be trusted to match the played one.
 *
 * REDUCED MOTION. Round 5's rule, verbatim: reading time is not motion. So
 * `w()` (motion) collapses to nothing and `hold()` (reading) does not, and a
 * callout is held for exactly as long in either mode. The film measures 3:41
 * normally and 2:07 reduced entirely because of that split.
 *
 * CANCELLATION. A jump, a stop or a re-run has to abandon a coroutine that is
 * suspended somewhere deep inside a chapter. It cannot be resumed and it
 * cannot be left hanging, so `cancel()` bumps a token and settles every
 * outstanding waiter by REJECTING it with the `CANCEL` sentinel: the
 * rejection unwinds the chapter's stack through its own `await`s, and the
 * runner swallows exactly that one value. Nothing else is caught.
 */

/** Thrown through a chapter's awaits to unwind it when the film moves on. */
export const CANCEL = Symbol("orbit-tour-film-cancel");

/** Longest frame the clock will believe. A backgrounded tab hands back a gap
 *  of seconds; charging the film for it would skip a chapter. The clamp lives
 *  where real frames are measured -- `startFilmLoop` below -- and NOT inside
 *  `advance`, which means what it says: move film time by exactly this much.
 *  A test drives the film in whatever steps it likes without being silently
 *  rationed. */
const MAX_FRAME_MS = 120;

/** The film time one real frame is worth, given the last timestamp seen.
 *  @param {number} ts @param {number} last */
export function frameDelta(ts, last) {
  if (!last) return 0;
  return Math.max(0, Math.min(ts - last, MAX_FRAME_MS));
}

/** Read live, never cached — the idiom veil.js, skies.js and satellites.js
 *  already use, so an OS-level change mid-film is honoured without a remount.
 *  @returns {boolean} */
export function stillMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @typedef {object} FilmClock
 * @property {(ms: number) => Promise<void>} wait      real film time, both modes
 * @property {(ms: number) => Promise<void>} w         MOTION time — nothing under reduced motion
 * @property {(ms: number) => Promise<void>} hold      READING time — the same in either mode
 * @property {(ms: number, fn: (t: number) => void) => Promise<void>} tween
 * @property {() => number} cursor
 * @property {() => number} sched
 * @property {() => boolean} playing
 * @property {(on: boolean) => void} setPlaying
 * @property {(ms: number) => void} seek
 * @property {() => void} cancel
 * @property {() => void} dryStart
 * @property {() => number} dryEnd
 * @property {() => boolean} dry
 * @property {() => boolean} reduced
 * @property {() => (() => void)} stall                     suspends film time for something unbudgeted
 * @property {() => boolean} stalled
 * @property {(ms: number) => void} advance                 drives a frame by hand (tests, and the rAF loop)
 * @property {(cb: () => void) => () => void} onFrame       painted every frame, playing or not
 * @property {(cb: (on: boolean) => void) => () => void} onPlaying
 * @property {() => void} destroy
 */

/**
 * @param {object} [options]
 * @param {() => boolean} [options.reducedMotion] overridable for tests
 * @returns {FilmClock}
 */
export function createClock({ reducedMotion = stillMotion } = {}) {
  let playing = false;
  let cursor = 0;
  let sched = 0;
  let token = 0;
  let dry = false;
  let budget = 0;
  /* Unbudgeted real time the film is waiting on — a route arriving, a screen
     rendering. The dry run cannot know how long a navigation takes, so film
     time must not run during one, or the played film drifts ahead of the
     coroutine by however slow the network was. */
  let stalls = 0;

  /** @type {{ at: number, my: number, resolve: () => void, reject: (reason: symbol) => void }[]} */
  const waiters = [];
  /** @type {Set<() => void>} */
  const frameCbs = new Set();
  /** @type {Set<() => void>} */
  const painters = new Set();
  /** @type {Set<(on: boolean) => void>} */
  const playingCbs = new Set();

  /** @param {number} ms */
  function wait(ms) {
    const span = Math.max(0, ms);
    if (dry) {
      budget += span;
      return Promise.resolve();
    }
    const my = token;
    sched += span;
    const at = sched;
    return new Promise((resolve, reject) => {
      waiters.push({ at, my, resolve: () => resolve(undefined), reject });
    });
  }

  /** Motion time. Gone under reduced motion — the state simply arrives. */
  const w = (/** @type {number} */ ms) => wait(reducedMotion() ? 0 : ms);
  /** Reading time. NOT motion, so it is the same length in either mode. */
  const hold = (/** @type {number} */ ms) => wait(ms);

  /**
   * A per-frame tween on the film clock, so a pause freezes it mid-move.
   * Under reduced motion (and in the dry run) it lands on its end state at
   * once and only the wait remains — which, being motion, is nothing.
   *
   * @param {number} ms
   * @param {(t: number) => void} fn called with 0..1
   */
  function tween(ms, fn) {
    if (dry || reducedMotion()) {
      fn(1);
      return w(ms);
    }
    const start = sched;
    const step = () => {
      const t = ms <= 0 ? 1 : Math.min(1, (cursor - start) / ms);
      fn(t);
      if (t >= 1) frameCbs.delete(step);
    };
    frameCbs.add(step);
    return wait(ms).then(
      () => { frameCbs.delete(step); fn(1); },
      (error) => { frameCbs.delete(step); throw error; },
    );
  }

  /**
   * One frame of film time. The rAF loop calls this with the real elapsed
   * milliseconds; a test calls it with whatever it likes.
   * @param {number} dt
   */
  function advance(dt) {
    if (playing && stalls === 0) {
      cursor += Math.max(0, dt);
      for (const cb of Array.from(frameCbs)) cb();
      /* Backwards, because firing a waiter can push another one. */
      for (let k = waiters.length - 1; k >= 0; k--) {
        if (waiters[k].at <= cursor) fire(waiters.splice(k, 1)[0]);
      }
    }
    for (const cb of Array.from(painters)) cb();
  }

  /** @param {{ my: number, resolve: () => void, reject: (reason: symbol) => void }} waiter */
  function fire(waiter) {
    if (waiter.my === token) waiter.resolve();
    else waiter.reject(CANCEL);
  }

  return {
    wait,
    w,
    hold,
    tween,
    cursor: () => cursor,
    sched: () => sched,
    playing: () => playing,
    setPlaying(on) {
      if (on === playing) return;
      playing = on;
      for (const cb of Array.from(playingCbs)) cb(on);
    },
    seek(ms) {
      cursor = ms;
      sched = ms;
    },
    /** Abandons every suspended chapter: the token moves, so each outstanding
     *  waiter settles as a CANCEL rejection rather than a resolution.
     *
     *  The schedule is rewound to where the film actually is. A cancelled
     *  chapter had already booked its waits minutes ahead, and leaving
     *  `sched` out there would mean the NEXT chapter's first wait could never
     *  fire -- it would be scheduled past a cursor nothing will ever advance
     *  that far. The player seeks straight afterwards on a jump; this makes a
     *  bare cancel safe too. */
    cancel() {
      token++;
      frameCbs.clear();
      for (const waiter of waiters.splice(0)) fire(waiter);
      sched = cursor;
    },
    dryStart() {
      dry = true;
      budget = 0;
    },
    dryEnd() {
      dry = false;
      return budget;
    },
    dry: () => dry,
    reduced: () => reducedMotion(),
    /** Holds film time still for something the dry run could not budget for.
     *  Call the returned function exactly once, when it has arrived. */
    stall() {
      stalls++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        stalls = Math.max(0, stalls - 1);
      };
    },
    stalled: () => stalls > 0,
    advance,
    onFrame(cb) {
      painters.add(cb);
      return () => painters.delete(cb);
    },
    onPlaying(cb) {
      playingCbs.add(cb);
      return () => playingCbs.delete(cb);
    },
    destroy() {
      token++;
      for (const waiter of waiters.splice(0)) fire(waiter);
      frameCbs.clear();
      painters.clear();
      playingCbs.clear();
      playing = false;
    },
  };
}

/**
 * Drives a clock from real frames. Kept out of `createClock` so a test can
 * advance the film by hand — the whole point of the two-position design is
 * that nothing depends on real elapsed time except this one function.
 *
 * @param {FilmClock} clock
 * @returns {() => void} stops the loop
 */
export function startFilmLoop(clock) {
  let last = 0;
  let id = 0;
  let live = true;
  /** @param {number} ts */
  const frame = (ts) => {
    if (!live) return;
    id = requestAnimationFrame(frame);
    const dt = frameDelta(ts, last);
    last = ts;
    clock.advance(dt);
  };
  id = requestAnimationFrame(frame);
  return () => {
    live = false;
    cancelAnimationFrame(id);
  };
}
