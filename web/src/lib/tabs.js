/**
 * §22's keyboard for a two-tab strip (#1356, web-28): one tab in the Tab
 * order, ← → swap to the other one and move focus onto it. Settings'
 * reminders tabs and the household archive card's tabs, desk and pocket,
 * all use it.
 *
 * @template {string} K
 * @param {[K, K]} keys  the two tabs, in strip order
 * @param {{ get: () => K, set: (key: K) => void, id: (key: K) => string }} tab
 *   the strip's current tab, its setter, and the id of each tab's button
 * @returns {(event: KeyboardEvent) => void} the strip's `onkeydown`
 */
export function tabArrows(keys, { get, set, id }) {
  return (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = get() === keys[0] ? keys[1] : keys[0];
    set(next);
    queueMicrotask(() => document.getElementById(id(next))?.focus());
  };
}
