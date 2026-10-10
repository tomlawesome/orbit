/**
 * ARM, THEN FIRE (#1120, proposal §1.8; one implementation and one timeout
 * since #1342). A dangerous act's first tap arms it ("tap again to remove")
 * and does nothing else; the second tap fires. It disarms by itself after 4s,
 * on the reader's scroll, on any other tap, and on Escape (disarmOnElsewhere).
 *
 * Every screen, desk and phone, uses this; none keeps its own timer.
 */

export const ARM_MS = 4000;

/**
 * `armed` is the armed key: `true` for the unkeyed `tap()`, the key itself for
 * `tap(key)` (one arm serving a list of buttons, `arm.armed === id`), `false`
 * when idle.
 * `onchange` hears that value; a caller that only ever taps unkeyed can type
 * its parameter `boolean`, a keyed one `string | boolean`, so it is `any` here.
 * @typedef {boolean | string | number} ArmValue
 * @param {{ ms?: number | (() => number | undefined), onchange?: (armed: any) => void }} [options]
 *   `ms` may be a function, read at each arming, so a component can pass a
 *   prop that changes.
 */
export function createArm({ ms = ARM_MS, onchange = () => {} } = {}) {
  /** @type {ArmValue} */
  let armed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let stopWatching = () => {};
  /** @param {ArmValue} next */
  const set = (next) => {
    if (armed === next) return;
    armed = next;
    onchange(next);
  };
  const disarm = () => {
    clearTimeout(timer);
    stopWatching();
    stopWatching = () => {};
    set(false);
  };
  return {
    get armed() { return armed; },
    /**
     * The tap. True when this tap should fire the act: the same key was already
     * armed. A different key re-arms for it and restarts the hold.
     *
     * Pass the tapped `button` (an event's `currentTarget`) and the arm also
     * disarms itself on scroll, Escape and a press outside that button
     * (disarmOnElsewhere) for as long as it stays armed. A component that
     * already calls disarmOnElsewhere itself, like ArmButton, omits it.
     * @param {string | number | boolean} [key]
     * @param {HTMLElement | null} [button]
     */
    tap(key = true, button = null) {
      if (armed === key) {
        disarm();
        return true;
      }
      stopWatching();
      set(key);
      clearTimeout(timer);
      timer = setTimeout(disarm, (typeof ms === "function" ? ms() : ms) ?? ARM_MS);
      stopWatching = button ? disarmOnElsewhere(button, disarm) : () => {};
      return false;
    },
    disarm,
  };
}

/** Keys that scroll the page when pressed anywhere but in a field. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

/**
 * The page-wide disarm triggers: the reader scrolling (a wheel, a touch
 * drag, a scrolling key), a press anywhere outside `button`, Escape.
 * Returns the cleanup.
 *
 * "On scroll" (proposal §1.8) is the reader's scroll, read from the input
 * that makes it, not from `scroll` events: tapping the pill focuses it, and
 * a browser that focuses on tap scrolls a pill sitting at a sheet's edge
 * into view, which fired `scroll` and disarmed it between the two taps, so
 * the second tap only armed it again.
 * @param {HTMLElement} button
 * @param {() => void} disarm
 */
export function disarmOnElsewhere(button, disarm) {
  const win = /** @type {Window} */ (button.ownerDocument.defaultView);
  /** @param {Event} event */
  const outside = (event) => !(event.target instanceof Node) || !button.contains(event.target);
  /** @param {Event} event */
  const onElsewhere = (event) => {
    if (outside(event)) disarm();
  };
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (event.key === "Escape" || (SCROLL_KEYS.has(event.key) && outside(event))) disarm();
  };
  win.addEventListener("wheel", disarm, { capture: true, passive: true });
  win.addEventListener("touchmove", onElsewhere, { capture: true, passive: true });
  win.addEventListener("pointerdown", onElsewhere, true);
  win.addEventListener("keydown", onKey, true);
  return () => {
    win.removeEventListener("wheel", disarm, { capture: true });
    win.removeEventListener("touchmove", onElsewhere, { capture: true });
    win.removeEventListener("pointerdown", onElsewhere, true);
    win.removeEventListener("keydown", onKey, true);
  };
}
