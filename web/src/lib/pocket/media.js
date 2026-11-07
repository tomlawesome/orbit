/**
 * The pocket dialect's switch (CON-10): under 840px wide or under 480px
 * tall (owner decision 45, #1382). The same query home's pocket.css uses, held once for script.
 * CSS cannot read a constant, so stylesheets write the query out; keep them
 * matching this.
 */
export const POCKET_QUERY = "(max-width: 839.98px), (max-height: 479.98px)";

/** Whether the pocket dialect is showing now. False where there is no window. */
export function isPocket() {
  return typeof matchMedia === "function" && matchMedia(POCKET_QUERY).matches;
}

/**
 * Calls `onchange` with the pocket switch's new value each time it flips, and
 * returns the stop. For a page's `$effect`: PageSky's `hidden` prop follows it
 * (#1689), so a page that draws no sky on a phone renders none.
 * @param {(pocket: boolean) => void} onchange
 * @returns {() => void}
 */
export function watchPocket(onchange) {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(POCKET_QUERY);
  const follow = () => onchange(query.matches);
  follow();
  query.addEventListener?.("change", follow);
  return () => query.removeEventListener?.("change", follow);
}
