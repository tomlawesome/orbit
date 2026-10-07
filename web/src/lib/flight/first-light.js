/*
 * FIRST LIGHT, COUNTED FROM PAGE LOAD (#1253; owner, 2026-10-07: "It's
 * approximate and it's from page load ideally").
 *
 * The door's sunrise is CSS transitions started by `body.lit` (flight.css),
 * so on its own it is counted from whenever the page's code got round to
 * setting `lit`. A slow load pushes the whole sunrise, and the button with
 * it, later by however late that was. Here `lit` is due at FIRST_LIGHT_MS
 * after the page started loading; when the code arrives after that, each
 * first-light transition is moved on by the lateness, so it ends about where
 * it would have ended on time. The same goes for the Earth's day side, whose
 * transition waits for its picture as well as for `lit`.
 *
 * Catching up never cuts a picture in: every transition keeps at least
 * KEEP_MS still to run, so a very late page gets a short fade rather than a
 * jump. The standard shape is a timeline with a fixed origin and late
 * starters seeking forward (Web Animations' `currentTime`).
 */

/** When `lit` is due, in ms after the page started loading. */
export const FIRST_LIGHT_MS = 500;

/** The least of any first-light transition left to run after catching up. */
export const KEEP_MS = 400;

/**
 * When this page's `lit` was due, on `performance.now()`'s clock, for
 * pieces that start their own part of first light later (the day side
 * waits for its picture, Dawn.svelte). NaN while no door is counting.
 */
export const firstLight = { dueAt: NaN };

/**
 * How far to move on a transition that started `lateMs` after its due time.
 * @param {number} lateMs how late the transition started
 * @param {number} endMs its delay plus its duration
 * @param {number} [doneMs] how much of it has already run
 * @returns {number} the ms to add to its current time, never negative
 */
export function catchUp(lateMs, endMs, doneMs = 0) {
  if (!(lateMs > 0) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.min(lateMs, endMs - KEEP_MS - doneMs));
}

/**
 * The time first light counts from, on `performance.now()`'s clock: the
 * start of the page load when this page is the first the document showed,
 * otherwise now (an in-app move to the door, where the page load is long
 * past and counting from it would cut the whole sunrise to the minimum).
 * @param {boolean} firstPage
 */
export function originFor(firstPage) {
  return firstPage ? 0 : performance.now();
}

/**
 * Makes a class change that starts part of first light, then moves on every
 * transition under `root` that the change started, by how late it came
 * against `dueAt`. Only those: what was already running before the change
 * (a hover, the previous beat) is not first light's to move. The moving
 * waits a frame, because Chromium has not made a change's transitions when
 * asked for them in the same task (Firefox has); what has run by then is
 * counted.
 * @param {Element} root
 * @param {number} dueAt when they should have started, on `performance.now()`'s clock
 * @param {() => void} change the class change that starts them
 */
export function startLate(root, dueAt, change) {
  const late = performance.now() - dueAt;
  if (!(late > 0) || typeof root.getAnimations !== "function") { change(); return; }
  const before = new Set(root.getAnimations({ subtree: true }));
  change();
  requestAnimationFrame(() => {
    for (const a of root.getAnimations({ subtree: true })) {
      if (before.has(a) || !("transitionProperty" in a)) continue;
      const timing = a.effect?.getComputedTiming();
      if (!timing) continue;
      const done = Number(a.currentTime ?? 0);
      const by = catchUp(late, Number(timing.endTime), done);
      if (by > 0) a.currentTime = done + by;
    }
  });
}
