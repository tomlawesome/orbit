import { inertPage, tabbables, trapTab } from "./focus.js";

/**
 * A sheet is a dialog (#1120, proposal §1.4, §1.12): focus moves in on open
 * and back to the opener on close, Tab stays inside, Escape asks to close,
 * and the page behind is inert. Plain DOM, so Sheet.svelte and the unit
 * tests share it.
 *
 * `layer` is the sheet's own direct child of <body> (portal.js); `panel` the
 * role=dialog inside it. Returns `release`, which undoes all of it and hands
 * focus back.
 * @param {HTMLElement} layer
 * @param {HTMLElement} panel
 * @param {{ onescape: () => void, initial?: HTMLElement | null }} options
 * @returns {() => void}
 */
export function holdSheet(layer, panel, { onescape, initial = null }) {
  const doc = panel.ownerDocument;
  const opener = /** @type {HTMLElement | null} */ (doc.activeElement);
  const restoreInert = inertPage(layer);

  /* The first real control in the sheet's body, not the close word in its
     head: a sheet is opened to be used. Falling back to the panel itself
     keeps focus inside a sheet that has nothing to press. */
  const first = initial ?? tabbables(panel).find((el) => !el.hasAttribute("data-sheet-close")) ?? panel;
  first.focus({ preventScroll: true });

  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onescape();
      return;
    }
    trapTab(event, panel);
  };
  /* Focus that escapes anyway (a click on the scrim, a programmatic move) is
     brought back rather than left on an inert page. */
  /** @param {FocusEvent} event */
  const onFocusIn = (event) => {
    if (event.target instanceof Node && !layer.contains(event.target)) panel.focus({ preventScroll: true });
  };
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("focusin", onFocusIn, true);

  return () => {
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    restoreInert();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
  };
}

/**
 * Sheets stand on the on-screen keyboard (§1.4, §1.11): writes the
 * keyboard's height as --p-kb and the visible height as --p-vvh on `layer`,
 * following visualViewport. Without one (old browsers, tests) nothing is
 * written and the CSS falls back to the layout viewport.
 * @param {HTMLElement} layer
 * @returns {() => void}
 */
export function standOnKeyboard(layer) {
  const win = layer.ownerDocument.defaultView;
  const vv = win?.visualViewport;
  if (!win || !vv) return () => {};
  const update = () => {
    const kb = Math.max(0, win.innerHeight - (vv.height + vv.offsetTop));
    layer.style.setProperty("--p-kb", `${Math.round(kb)}px`);
    layer.style.setProperty("--p-vvh", `${Math.round(vv.height)}px`);
  };
  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
  };
}
