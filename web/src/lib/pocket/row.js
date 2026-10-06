/**
 * One management act on a row. `name` is the full accessible name, object
 * included ("Remove Emma Lawson"); `label` is what the pill says ("remove").
 * A `danger` act arms on its first tap and fires on its second; `arms` does
 * the same for an act that is not red (the relay's `Add to orbit`). With
 * `href` the act is a way onward (`open →`) rather than something done here.
 * `tone` colours the pill the desk way, or `filled` for the one primary.
 * @typedef {{ label: string, name: string, onact?: () => unknown, href?: string, danger?: boolean, arms?: boolean, tone?: "ok" | "up" | "warm" | "accent" | "filled" }} RowAct
 */

/** The unfold's close, in ms: the panel stays in the page until it is shut. */
export const CLOSE_MS = 200;

/** The rows mounted now, by element, so a screen can open one by address. */
const mounted = new WeakMap();
/** The open row in each group ([data-row-group] on the list, or the page). */
const openIn = new WeakMap();

/**
 * THE ROW OPENS ON A TAP (#1120, review round §1.1; the desk's own grammar,
 * home.css "THE ROW IS THE ITEM", #424). Tapping the face grows the row in
 * place into a panel under it holding the row's detail and its acts; tapping
 * the face again closes it, Escape closes it and hands focus back to the
 * face, and opening another row in the same group (`data-row-group` on the
 * list) closes the first. Nothing else closes it: not a tap elsewhere, not a
 * scroll, not a timer. That is the desk's own rule (home's one `expanded`
 * row), and the owner's on the phone (2026-09-27, #1159): "The drawer should
 * just stay open once tapped like it does on desktop".
 *
 *   keyboard       the face is a button: Enter or Space toggles; the
 *                  panel's pills are in the Tab order only while open (the
 *                  `hidden` attribute when shut); Escape closes
 *   screen reader  the face carries aria-expanded and aria-controls
 *
 * The DOM this drives (Row.svelte draws it):
 *   [data-row]               the row; [data-open] while open
 *     [data-row-face]        the button that toggles it
 *     [data-row-panel]       the panel, `hidden` while shut
 *
 * The unfold itself is CSS keyed on [data-open]; this only keeps the panel
 * in the page until the close has played (`closeMs`, 0 under reduced motion).
 * @param {HTMLElement} row
 * `onchange` hears every open and close.
 * @param {{ closeMs?: number, onchange?: (open: boolean) => void }} [options]
 * @returns {{ open: () => void, close: (focusFace?: boolean) => void, toggle: () => void, readonly isOpen: boolean, destroy: () => void }}
 */
export function mountRow(row, { closeMs, onchange } = {}) {
  const face = /** @type {HTMLElement} */ (row.querySelector("[data-row-face]"));
  const panel = /** @type {HTMLElement | null} */ (row.querySelector("[data-row-panel]"));
  const doc = row.ownerDocument;
  const win = /** @type {Window} */ (doc.defaultView);
  const still = () => typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const group = () => row.closest("[data-row-group]") ?? doc;

  let isOpen = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let hiding;


  function open() {
    if (!panel || isOpen) return;
    const other = openIn.get(group());
    if (other && other !== control) other.close();
    isOpen = true;
    openIn.set(group(), control);
    clearTimeout(hiding);
    panel.hidden = false;
    /* Laid out shut first, so the unfold has somewhere to grow from. */
    void panel.offsetHeight;
    row.dataset.open = "";
    face.setAttribute("aria-expanded", "true");
    onchange?.(true);
  }

  /** @param {boolean} [focusFace] */
  function close(focusFace = false) {
    if (!panel || !isOpen) return;
    const hadFocus = panel.contains(doc.activeElement);
    isOpen = false;
    if (openIn.get(group()) === control) openIn.delete(group());
    delete row.dataset.open;
    face.setAttribute("aria-expanded", "false");
    const ms = closeMs ?? (still() ? 0 : CLOSE_MS);
    clearTimeout(hiding);
    if (ms > 0) hiding = setTimeout(() => { if (!isOpen) panel.hidden = true; }, ms);
    else panel.hidden = true;
    if (focusFace || hadFocus) face.focus({ preventScroll: true });
    onchange?.(false);
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  /* A control inside the face (`end`, the section switch) sits beside the
     button in Row.svelte, so its tap never reaches here. */
  const onClick = () => toggle();
  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  const control = {
    open,
    close,
    toggle,
    get isOpen() { return isOpen; },
    destroy() {
      clearTimeout(hiding);
      if (openIn.get(group()) === control) openIn.delete(group());
      face.removeEventListener("click", onClick);
      row.removeEventListener("keydown", onKey);
      mounted.delete(row);
    },
  };

  if (panel) {
    face.addEventListener("click", onClick);
    row.addEventListener("keydown", onKey);
    face.setAttribute("aria-expanded", "false");
    panel.hidden = true;
  }
  mounted.set(row, control);
  return control;
}

/**
 * The mounted row an element belongs to, so a screen can open a row from
 * elsewhere (home's search result opens the item's row in the manifest).
 * @param {Element | null | undefined} el
 */
export function rowOf(el) {
  const row = el?.closest("[data-row]");
  return row ? mounted.get(row) ?? null : null;
}
