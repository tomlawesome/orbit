/*
 * WHEN THE FLIGHT'S WORLD MAY BE ASKED FOR (#1253, #1299; carried from
 * Flight.svelte's readyWorld by #1371). The world is the shared door's
 * (`journey.warm()`, `journey.later()`); what is Orbit's is whether to ask, and
 * how. The decision is plain data in, answer out, so the truth table is run as
 * code (a `.svelte` file needs a compiler the unit suite does not pull in).
 */

/**
 * The unhurried ask home makes a few seconds after it has arrived: gentle, and
 * made even where the browser compiles on the page's own thread (the owner's
 * choice, #1299), but speculative -- no GPU test frames (`prove: false`). The
 * flight's own ask is the one that proves the world fit.
 */
export const LEISURE_ASK = Object.freeze({ gentle: true, compile: true, prove: false });

/**
 * Whether `readyWorld` goes on to ask the folder for the world.
 *   No journey, or reduced motion (there is no flight): never.
 *   A gentle ask holds off under save-data, and where the compile would stop
 *   the page (it is not made aside), unless a quiet moment was chosen for it
 *   (`compile`). The two readings are functions so they are only taken when a
 *   gentle ask needs them.
 * @param {{ journey: boolean, reduced: boolean, gentle: boolean, compile: boolean,
 *           savingData: () => boolean, compilesAside: () => boolean }} ask
 * @returns {boolean}
 */
export function mayReadyWorld({ journey, reduced, gentle, compile, savingData, compilesAside }) {
  if (!journey || reduced) return false;
  if (gentle && (savingData() || (!compilesAside() && !compile))) return false;
  return true;
}

/**
 * The unhurried ask: the folder's `journey.later()`, which waits its few
 * seconds and the page's painted animations, and drops the ask if a flight or
 * a descent begins first. Never with no journey, under reduced motion or under
 * save-data.
 * @param {{ journey: { later: (fn: () => void, how?: { after?: number }) => () => void } | null | undefined,
 *           reduced: boolean, savingData: boolean,
 *           ready: (how: { gentle: boolean, compile: boolean, prove: boolean }) => unknown,
 *           how?: { after?: number } }} ask
 * @returns {() => void} stops it, if the page is left first
 */
export function readyWorldAtLeisure({ journey, reduced, savingData, ready, how = {} }) {
  if (!journey || reduced || savingData) return () => {};
  return journey.later(() => { ready({ ...LEISURE_ASK }); }, how);
}
