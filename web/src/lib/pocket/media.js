/**
 * The pocket dialect's switch (CON-10): at most 900px wide or at most 600px
 * tall. The same query home's pocket.css uses, held once for script.
 * CSS cannot read a constant, so stylesheets write the query out; keep them
 * matching this.
 */
export const POCKET_QUERY = "(max-width: 900px), (max-height: 600px)";

/** Whether the pocket dialect is showing now. False where there is no window. */
export function isPocket() {
  return typeof matchMedia === "function" && matchMedia(POCKET_QUERY).matches;
}
