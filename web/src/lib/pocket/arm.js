/**
 * ARM, THEN FIRE (#1120, proposal §1.8). A dangerous act's first tap arms it
 * ("tap again to remove") and does nothing else; the second tap fires. It
 * disarms by itself after 4s, on the reader's scroll, on any other tap, and
 * on Escape.
 *
 * The desk has written this inline five times (Chrome.svelte's sign-out, the
 * belt's archive/cancel, the inbox's approve/dismiss, settings' methods and
 * devices, the pocket's suggestion sheet), none of them timing out. This is
 * the one the pocket kit uses; the desk copies move over as their screens
 * get their phone layouts, rather than all at once here.
 */

export const ARM_MS = 4000;

/**
 * @param {{ ms?: number | (() => number | undefined), onchange?: (armed: boolean) => void }} [options]
 *   `ms` may be a function, read at each arming, so a component can pass a
 *   prop that changes.
 */
export function createArm({ ms = ARM_MS, onchange = () => {} } = {}) {
  let armed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @param {boolean} next */
  const set = (next) => {
    if (armed === next) return;
    armed = next;
    onchange(next);
  };
  const disarm = () => {
    clearTimeout(timer);
    set(false);
  };
  return {
    get armed() { return armed; },
    /** The tap. True when this tap should fire the act. */
    tap() {
      if (!armed) {
        set(true);
        clearTimeout(timer);
        timer = setTimeout(disarm, (typeof ms === "function" ? ms() : ms) ?? ARM_MS);
        return false;
      }
      disarm();
      return true;
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
