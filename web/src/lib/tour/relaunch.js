/**
 * "TAKE THE WALK AGAIN" (#753, slice 3 of #477) — the seam between the
 * settings control and the arrival effect in Tour.svelte, framework-free
 * like engine.js's own state machine so the whole path is driven by a unit
 * test without a mounted component (tests/unit/v19-tour-walk-again.test.mjs).
 *
 * THE PROBLEM. Tour.svelte's `started` guard is a one-shot per page load:
 * once the walk has begun once on this load — even if it returned instantly
 * because `tourSeenAt` was already set — no later arrival on /home begins it
 * again. That is right for ordinary navigation (leaving /home and coming
 * back must not restart a walk already in progress or already taken), but
 * wrong for a reader who has just cleared the record on purpose and asked
 * for the walk back.
 *
 * THE FIX. `requestTourRestart` sets a one-shot flag the moment the control
 * is activated, BEFORE the record is cleared or the navigation starts.
 * Tour.svelte's arrival effect asks `tourMayBegin(started)` instead of
 * reading `started` alone; it consumes the flag at most once, so exactly the
 * one arrival that follows a relaunch gets through.
 */

let requested = false;

/* #1189: "Watch the tour" sits in the account menus too, which are open on
   /home itself. Navigating to /home from /home changes nothing Tour.svelte's
   arrival effect watches, so there the relaunch tells Tour.svelte directly.
   One listener at a time: there is one Tour.svelte, mounted by the layout. */
/** @type {(() => void) | null} */
let inPlace = null;

/**
 * Tour.svelte's subscription to a relaunch made while already on /home.
 * @param {() => void} listener
 * @returns {() => void} unsubscribe
 */
export function onRestartInPlace(listener) {
  inPlace = listener;
  return () => {
    if (inPlace === listener) inPlace = null;
  };
}

/** Called by the settings control, before it clears the record and navigates. */
export function requestTourRestart() {
  requested = true;
}

/**
 * Tour.svelte's arrival effect calls this in place of checking `started`
 * alone. First arrival ever (`started` false) always proceeds. After that,
 * only an arrival that follows a `requestTourRestart()` call gets through,
 * and only once — the flag is consumed on the way past.
 *
 * @param {boolean} started Tour.svelte's own one-shot-per-load guard
 */
export function tourMayBegin(started) {
  if (!started) return true;
  if (!requested) return false;
  requested = false;
  return true;
}

/**
 * The control's own handler: clear the server's record, THEN navigate — so
 * the walk's own arrival read of `tourSeenAt` (#751) sees null rather than
 * racing the write. Dependency-injected, like `createTour`, so this whole
 * path is testable without a network or a mounted component.
 *
 * @param {object} deps
 * @param {() => Promise<unknown>} deps.clearTourSeen
 * @param {() => Promise<unknown>} deps.navigateHome
 * @param {() => boolean} [deps.onHome] true when the reader is already on
 *   /home, where navigating there again would start nothing (#1189)
 */
export async function relaunchTour({ clearTourSeen, navigateHome, onHome = () => false }) {
  requestTourRestart();
  await clearTourSeen();
  if (onHome()) inPlace?.();
  else await navigateHome();
}

/** Test-only: the flag is module-level so tests must be able to reset it. */
export function _resetTourRestartForTests() {
  requested = false;
  inPlace = null;
}
