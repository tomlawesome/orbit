import { LONG_PRESS_MS, SLOP, reorderTarget } from "./gesture.js";

/**
 * LONG-PRESS REORDER (#1120, proposal §1.5): a finger resting on a row lifts
 * it (with a haptic tick where the platform gives one), a drag carries it,
 * and letting go drops it and reports `onreorder(from, to)`. The caller owns
 * the order and re-renders; nothing here moves DOM nodes.
 *
 * Keyboard and screen-reader users reorder through the row itself: Alt-↑/↓
 * on its face, or the `move up` / `move down` pills in its opened panel
 * (review round §1.1), not through this.
 *
 * @param {HTMLElement} list - holds the rows, each [data-row]
 * @param {{ onreorder: (from: number, to: number) => void, pressMs?: number }} options
 * @returns {{ destroy: () => void, update: (next: { onreorder: (from: number, to: number) => void }) => void }}
 */
export function mountReorder(list, { onreorder, pressMs = LONG_PRESS_MS }) {
  let report = onreorder;
  /* The click that follows a drop is not a tap on the row. */
  let swallowClick = false;
  /** @type {{ id: number, y: number, x: number, row: HTMLElement, rows: HTMLElement[], from: number, lifted: boolean, timer: ReturnType<typeof setTimeout> } | null} */
  let press = null;

  const rowsOf = () => /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll(":scope > [data-row], :scope > * > [data-row]")));

  /** @param {PointerEvent} event */
  const onDown = (event) => {
    const target = /** @type {Element} */ (event.target);
    const row = /** @type {HTMLElement | null} */ (target.closest("[data-row]"));
    if (!row || !list.contains(row) || event.button > 0 || target.closest("[data-row-panel]")) return;
    const rows = rowsOf();
    const from = rows.indexOf(row);
    if (from < 0 || rows.length < 2) return;
    press = {
      id: event.pointerId, x: event.clientX, y: event.clientY, row, rows, from, lifted: false,
      timer: setTimeout(() => lift(), pressMs),
    };
  };
  const lift = () => {
    if (!press) return;
    press.lifted = true;
    press.row.dataset.lifted = "";
    list.dataset.reordering = "";
    try { press.row.setPointerCapture(press.id); } catch { /* the pointer is already gone */ }
    navigator.vibrate?.(10);
  };
  /** @param {PointerEvent} event */
  const onMove = (event) => {
    if (!press || event.pointerId !== press.id) return;
    const dy = event.clientY - press.y;
    if (!press.lifted) {
      /* Moving before the press matures is a scroll, not a lift. */
      if (Math.hypot(event.clientX - press.x, dy) > SLOP) end();
      return;
    }
    press.row.style.transform = `translateY(${dy}px)`;
  };
  /** @param {PointerEvent} event */
  const onUp = (event) => {
    if (!press || event.pointerId !== press.id) return;
    if (press.lifted) {
      const to = reorderTarget({
        from: press.from, dy: event.clientY - press.y,
        rowHeight: press.row.offsetHeight || 56, count: press.rows.length,
      });
      const from = press.from;
      swallowClick = true;
      end();
      if (to !== from) report(from, to);
      return;
    }
    end();
  };
  const end = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press.row.style.transform = "";
    delete press.row.dataset.lifted;
    delete list.dataset.reordering;
    press = null;
  };
  /* Once lifted, the finger drags the row, not the page: a touch the page
     began scrolling cannot be taken back, so its moves are stopped here. */
  /** @param {TouchEvent} event */
  const onTouchMove = (event) => {
    if (press?.lifted) event.preventDefault();
  };
  /** @param {Event} event */
  const onClick = (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  /** @param {Event} event */
  const onMenu = (event) => {
    if (press) event.preventDefault();
  };

  list.addEventListener("pointerdown", onDown);
  list.addEventListener("pointermove", onMove);
  list.addEventListener("pointerup", onUp);
  list.addEventListener("pointercancel", end);
  list.addEventListener("touchmove", onTouchMove, { passive: false });
  list.addEventListener("contextmenu", onMenu);
  list.addEventListener("click", onClick, true);
  return {
    update(next) { report = next.onreorder; },
    destroy() {
      end();
      list.removeEventListener("pointerdown", onDown);
      list.removeEventListener("pointermove", onMove);
      list.removeEventListener("pointerup", onUp);
      list.removeEventListener("pointercancel", end);
      list.removeEventListener("touchmove", onTouchMove);
      list.removeEventListener("contextmenu", onMenu);
      list.removeEventListener("click", onClick, true);
    },
  };
}
