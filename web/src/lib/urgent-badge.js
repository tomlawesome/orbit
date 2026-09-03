/**
 * The installed app's OS-level badge (#763) — the small overdue count a
 * browser paints on Orbit's icon once it is installed as a PWA.
 *
 * Feature-detected on every call, never assumed: the Badging API has no
 * `"badging" in navigator` flag to check up front, most browsers do not
 * implement it at all, and the ones that do only honour it once the reader
 * has actually installed Orbit. None of that is a failure this needs to
 * report — the count is cosmetic, so an absent or refusing API is silence.
 */

/**
 * @param {number} n  how many arrivals are overdue right now
 * @param {*} [scope] injected for tests; defaults to the real window
 */
export function showUrgentCount(n, scope = globalThis) {
  const nav = scope?.navigator;
  try {
    const result = n > 0 ? nav?.setAppBadge?.(n) : nav?.clearAppBadge?.();
    result?.catch?.(() => {
      /* Some platforms reject the promise when there is no OS-level badge
         to draw on — still cosmetic, still not worth surfacing. */
    });
  } catch {
    /* A handful of implementations throw synchronously instead. */
  }
}
