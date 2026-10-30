/**
 * The reduced-motion question, asked one way (#1356, web-20).
 *
 * Sixteen screens and engines used to write the media query out for
 * themselves, some guarded against a missing `matchMedia` and some not. This
 * is the one copy. It is read live, never cached, so an OS-level change
 * mid-session is honoured at the next ask without a remount.
 *
 * `web/src/lib/door/` is the imported orbit-site copy and keeps its own.
 */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * Whether the reader has asked for less motion. False where there is no
 * `matchMedia` to ask (server rendering, a bare test DOM).
 *
 * @param {{ matchMedia?: (query: string) => { matches: boolean } }} [view]
 *   the window to ask, when it is not the global one (a row's own document)
 * @returns {boolean}
 */
export function prefersReducedMotion(view) {
  if (view) return typeof view.matchMedia === "function" && view.matchMedia(REDUCED_MOTION).matches;
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
}
