/**
 * THE TEXT SIZE LIST, ONE PLACE (#1180). Mirrors theme.js.
 *
 * Four steps scale the root font (tokens.css: html[data-text-size=...]), so
 * every rem follows. Comfortable is today's look and the default; a stored
 * value outside the list resolves to it. The ids are the ones the server
 * stores (`textSizes` in src/lib/preferences.ts, checked by
 * tests/unit/text-size.test.mjs).
 *
 * app.html's pre-paint script cannot import this -- it runs before first
 * paint -- so it keeps a literal copy of the list and the default, and a test
 * parses both and asserts they agree, as it does for the theme list.
 */

export const TEXT_SIZES = ["standard", "comfortable", "large", "extra-large"];

export const DEFAULT_TEXT_SIZE = "comfortable";

/**
 * What each step is called on a tile.
 * @type {ReadonlyArray<{ value: string, words: string }>}
 */
export const TEXT_SIZE_CHOICES = [
  { value: "standard", words: "standard" },
  { value: "comfortable", words: "comfortable" },
  { value: "large", words: "large" },
  { value: "extra-large", words: "extra large" },
];

/**
 * A stored or requested size, made safe to apply: itself when it is on the
 * list, the default otherwise.
 *
 * @param {unknown} id
 * @returns {string}
 */
export function textSizeOrDefault(id) {
  return typeof id === "string" && TEXT_SIZES.includes(id) ? id : DEFAULT_TEXT_SIZE;
}

/**
 * Puts a step on the page now and caches it for the next paint. DOM and cache
 * only: the server write is savePreferences in data/workspace.js.
 *
 * @param {string} id
 */
export function applyTextSize(id) {
  const size = textSizeOrDefault(id);
  document.documentElement.setAttribute("data-text-size", size);
  try { localStorage.setItem("orbit-text-size", size); } catch { /* private mode: this page only */ }
}
