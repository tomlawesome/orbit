/**
 * §22's keyboard for a tab strip (#1356, web-28), the WAI-ARIA tablist
 * pattern: one tab in the Tab order, → moves to the next tab and ← to the
 * previous, wrapping at either end, and focus follows. With two tabs both
 * arrows swap to the other, as they always have. Settings' Mail tabs (three
 * since #1509) and the household archive card's tabs, desk and pocket, all
 * use it.
 *
 * @template {string} K
 * @param {K[]} keys  the tabs, in strip order
 * @param {{ get: () => K, set: (key: K) => void, id: (key: K) => string }} tab
 *   the strip's current tab, its setter, and the id of each tab's button
 * @returns {(event: KeyboardEvent) => void} the strip's `onkeydown`
 */
export function tabArrows(keys, { get, set, id }) {
  return (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = Math.max(0, keys.indexOf(get()));
    const next = keys[(at + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length];
    set(next);
    queueMicrotask(() => document.getElementById(id(next))?.focus());
  };
}
