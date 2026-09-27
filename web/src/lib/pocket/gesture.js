/**
 * The pocket's gesture arithmetic (#1120, proposal §1.3, §1.4, §1.5): pure
 * functions, so the decisions a finger drives are testable without layout.
 * The components feed them pointer and scroll positions and apply the answer.
 */

/** A drag has to travel this far before it counts as a direction at all. */
export const SLOP = 8;

/**
 * Which way a pointer drag is going, once it has gone far enough to say.
 * The belt only takes horizontal drags so a vertical one still scrolls the page.
 * @param {number} dx
 * @param {number} dy
 * @returns {"x" | "y" | null}
 */
export function dragAxis(dx, dy) {
  if (Math.hypot(dx, dy) < SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * What a released drag on a sheet does (§1.4): close it, grow a list sheet
 * to full height, or spring back. Dragging down a quarter of its height, or
 * a downward flick, closes; a list sheet dragged up 48px grows.
 * @param {{ dy: number, height: number, velocity?: number, size: string, grown?: boolean }} p
 *   dy positive downward, velocity in px/ms
 * @returns {"close" | "grow" | "shrink" | "stay"}
 */
export function sheetRelease({ dy, height, velocity = 0, size, grown = false }) {
  if (dy > 16 && (dy > height / 4 || velocity > 0.5)) return grown ? "shrink" : "close";
  if (size === "list" && !grown && (dy < -48 || velocity < -0.5)) return "grow";
  return "stay";
}

/**
 * The top chrome's retract rule (§1.3): it goes when the page scrolls down
 * past its own height and comes back on any real scroll up, and it is always
 * there at the top of the page. `hidden` is the current state.
 * @param {{ y: number, lastY: number, hidden: boolean, height: number }} p
 * @returns {boolean} whether the chrome should now be hidden
 */
export function chromeHidden({ y, lastY, hidden, height }) {
  if (y <= height) return false;
  const delta = y - lastY;
  if (delta > 4) return true;
  if (delta < -4) return false;
  return hidden;
}

/** How long a finger must rest on a row before it lifts for reorder (§1.5). */
export const LONG_PRESS_MS = 450;

/**
 * Which index a lifted row lands on, from how far it has been dragged.
 * @param {{ from: number, dy: number, rowHeight: number, count: number }} p
 */
export function reorderTarget({ from, dy, rowHeight, count }) {
  const to = from + Math.round(dy / rowHeight);
  return Math.max(0, Math.min(count - 1, to));
}
