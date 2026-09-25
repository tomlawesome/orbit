import { dragAxis, swipeOffset, swipeSettles } from "./gesture.js";

/**
 * One management act on a row. `name` is the full accessible name, object
 * included ("Remove Emma Lawson"); `label` is what the pill says ("remove").
 * @typedef {{ label: string, name: string, onact: () => unknown, danger?: boolean, tone?: "ok" | "up" | "warm" | "accent" }} RowAct
 */

/**
 * ROW ACTS, BEHIND A SWIPE (#1120, proposal §1.5; owner decision §25 and
 * #1122). The acts on a management row (remove, hand over, resend, ...) are
 * revealed only by a horizontal swipe: no tap opens them and no extra button
 * shows at rest. The row's face never moves: the act tray slides over it
 * from the trailing edge (Fable, #1120), and the face's text column shrinks
 * to the tray's width. The tray goes back on a tap elsewhere, on scroll, or
 * after 6s. A swipe never performs an act.
 *
 *   keyboard       focus the row, ← or → reveals, Tab walks the acts,
 *                  Escape hides and returns to the row
 *   screen reader  every act is a real button in the accessibility tree,
 *                  named with its object ("Remove Emma Lawson"), out of the
 *                  sighted Tab order (tabindex -1) until revealed; reaching
 *                  one by swipe-navigation reveals the row so it is on top
 *
 * The DOM this drives (Row.svelte draws it):
 *   [data-row]            the row
 *     [data-row-face]     what the row shows; stays put
 *     [data-row-acts]     the act tray, over the face, off the trailing side
 *                         at rest; CSS places it open or shut from
 *                         [data-open], this only moves it with a finger
 *       button...
 *
 * @param {HTMLElement} row
 * @param {{ holdMs?: number }} [options]
 * @returns {{ open: () => void, close: (focusFace?: boolean) => void, readonly isOpen: boolean, destroy: () => void }}
 */
export function mountRow(row, { holdMs = 6000 } = {}) {
  const face = /** @type {HTMLElement} */ (row.querySelector("[data-row-face]"));
  const acts = /** @type {HTMLElement | null} */ (row.querySelector("[data-row-acts]"));
  const doc = row.ownerDocument;
  const win = /** @type {Window} */ (doc.defaultView);
  const buttons = () => /** @type {HTMLElement[]} */ (acts ? Array.from(acts.querySelectorAll("button")) : []);
  const reveal = () => acts?.offsetWidth || 0;

  let isOpen = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /* `x` is swipeOffset's answer, how far open (negative) the finger has
     pulled the tray; the tray sits `reveal + x` from its open place. With
     `settle`, hand the tray back to the CSS, which slides it home. */
  const place = (/** @type {number} */ x, /** @type {boolean} */ settle) => {
    if (!acts) return;
    if (settle) {
      acts.style.transition = "";
      acts.style.transform = "";
      return;
    }
    acts.style.transition = "none";
    acts.style.transform = `translateX(${Math.max(0, reveal() + x)}px)`;
  };
  /* The face's text column makes room for the whole tray at once. */
  const makeRoom = () => row.style.setProperty("--p-row-tray", `${reveal()}px`);
  const setTabStops = (/** @type {boolean} */ on) => {
    for (const button of buttons()) button.tabIndex = on ? 0 : -1;
  };
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      /* Never pull the acts out from under someone using them. */
      if (acts && acts.contains(doc.activeElement)) return armTimer();
      close();
    }, holdMs);
  };

  /** @param {Event} event */
  const onOutside = (event) => {
    if (event.target instanceof Node && row.contains(event.target)) return;
    close();
  };
  const onScroll = () => close();

  function open() {
    if (!acts) return;
    if (!isOpen) {
      isOpen = true;
      makeRoom();
      row.dataset.open = "";
      setTabStops(true);
      win.addEventListener("pointerdown", onOutside, true);
      win.addEventListener("scroll", onScroll, { capture: true, passive: true });
    }
    place(-reveal(), true);
    armTimer();
  }

  /** @param {boolean} [focusFace] */
  function close(focusFace = false) {
    clearTimeout(timer);
    const hadFocus = acts?.contains(doc.activeElement) ?? false;
    place(0, true);
    if (!isOpen) return;
    isOpen = false;
    delete row.dataset.open;
    setTabStops(false);
    win.removeEventListener("pointerdown", onOutside, true);
    win.removeEventListener("scroll", onScroll, { capture: true });
    if (focusFace || hadFocus) face.focus({ preventScroll: true });
  }

  /* Keyboard: the row's own keys, only while focus is on the face. */
  /** @param {KeyboardEvent} event */
  const onFaceKey = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!acts) return;
      event.preventDefault();
      if (isOpen) close(true);
      else open();
    } else if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      close(true);
    }
  };
  /** @param {KeyboardEvent} event */
  const onActsKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  /* A screen reader landing on a covered act uncovers the row. */
  const onActsFocus = () => {
    if (!isOpen) open();
    else armTimer();
  };

  /* The swipe. touch-action:pan-y on the face (Row.svelte) leaves vertical
     drags to the page, so a horizontal one arrives here. */
  /** @type {{ id: number, x: number, y: number, axis: "x" | "y" | null, lastX: number, lastT: number, v: number } | null} */
  let track = null;
  let swallowClick = false;
  /** @param {PointerEvent} event */
  const onDown = (event) => {
    if (!acts || event.button > 0 || row.dataset.lifted !== undefined) return;
    track = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, lastX: event.clientX, lastT: event.timeStamp, v: 0 };
  };
  /** @param {PointerEvent} event */
  const onMove = (event) => {
    if (!track || event.pointerId !== track.id) return;
    if (row.dataset.lifted !== undefined) { track = null; return; }
    const dx = event.clientX - track.x;
    if (track.axis === null) {
      track.axis = dragAxis(dx, event.clientY - track.y);
      if (track.axis === "y") { track = null; return; }
      if (track.axis === "x") {
        makeRoom();
        row.dataset.swiping = "";
        face.setPointerCapture?.(event.pointerId);
      }
    }
    if (track.axis !== "x") return;
    const dt = Math.max(1, event.timeStamp - track.lastT);
    track.v = (event.clientX - track.lastX) / dt;
    track.lastX = event.clientX;
    track.lastT = event.timeStamp;
    place(swipeOffset({ dx, reveal: reveal(), open: isOpen }), false);
  };
  /** @param {PointerEvent} event */
  const onUp = (event) => {
    if (!track || event.pointerId !== track.id) return;
    const moved = track.axis === "x";
    const dx = event.clientX - track.x;
    const velocity = track.v;
    track = null;
    delete row.dataset.swiping;
    if (!moved) return;
    swallowClick = true;
    if (swipeSettles({ dx, reveal: reveal(), open: isOpen, velocity })) open();
    else close();
  };
  const onCancel = () => {
    if (!track) return;
    track = null;
    delete row.dataset.swiping;
    if (isOpen) open();
    else close();
  };
  /* A swipe that ends over a link must not follow it. */
  /** @param {MouseEvent} event */
  const onClick = (event) => {
    if (swallowClick) {
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    /* Tapping an open row's face puts the acts away rather than acting. */
    if (isOpen) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  face.addEventListener("keydown", onFaceKey);
  face.addEventListener("pointerdown", onDown);
  face.addEventListener("pointermove", onMove);
  face.addEventListener("pointerup", onUp);
  face.addEventListener("pointercancel", onCancel);
  face.addEventListener("click", onClick, true);
  acts?.addEventListener("keydown", onActsKey);
  acts?.addEventListener("focusin", onActsFocus);
  setTabStops(false);

  return {
    open,
    close,
    get isOpen() { return isOpen; },
    destroy() {
      clearTimeout(timer);
      win.removeEventListener("pointerdown", onOutside, true);
      win.removeEventListener("scroll", onScroll, { capture: true });
      face.removeEventListener("keydown", onFaceKey);
      face.removeEventListener("pointerdown", onDown);
      face.removeEventListener("pointermove", onMove);
      face.removeEventListener("pointerup", onUp);
      face.removeEventListener("pointercancel", onCancel);
      face.removeEventListener("click", onClick, true);
      acts?.removeEventListener("keydown", onActsKey);
      acts?.removeEventListener("focusin", onActsFocus);
    },
  };
}
