/**
 * Rebuild once a resize has settled (#1356, web-28): the "paint once,
 * rebuild on resize, debounced" idiom the grain, the maintenance and 404
 * skies and the satellites backdrop share.
 *
 * @param {() => void} rebuild  called `ms` after the last resize in a burst
 * @param {number} ms
 * @returns {() => void} the teardown: the listener off and any pending
 *   rebuild dropped
 */
export function onResizeSettled(rebuild, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const onResize = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, ms);
  };
  window.addEventListener("resize", onResize);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("resize", onResize);
  };
}
