/**
 * Focus handling for the pocket's dialogs (#1120, proposal §1.4, §1.12):
 * a sheet traps Tab, and while it is open the page behind it is `inert`.
 *
 * Plain DOM so the Sheet component and its tests share one version.
 */

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]", "summary",
].join(",");

/**
 * The elements Tab can reach inside `root`, in document order. tabindex=-1
 * (the row acts' hidden path, §1.5) is reachable by a screen reader but not
 * by Tab, so it is left out here.
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
export function tabbables(root) {
  return /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(FOCUSABLE))).filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert],[hidden]") && visible(el),
  );
}

/** @param {HTMLElement} el */
function visible(el) {
  /* checkVisibility is the real answer in a browser; a DOM without layout
     (the unit tests) has no such notion, so everything counts as visible. */
  return typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : true;
}

/**
 * Keeps Tab inside `root`: from the last tabbable Tab wraps to the first,
 * Shift-Tab from the first wraps to the last, and focus that has somehow
 * left the root is pulled back in. Returns true when it moved focus.
 * @param {KeyboardEvent} event
 * @param {HTMLElement} root
 */
export function trapTab(event, root) {
  if (event.key !== "Tab") return false;
  const list = tabbables(root);
  if (list.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = /** @type {Element | null} */ (root.ownerDocument.activeElement);
  const inside = active !== null && root.contains(active);
  if (event.shiftKey && (!inside || active === first || active === root)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Makes everything in <body> except `keep` inert, and returns the undo.
 * Elements that were already inert are left alone on restore. Anything
 * marked `data-pocket-above` (the wake, §1.13, which sits above any sheet)
 * stays live too.
 * @param {HTMLElement} keep - a direct child of <body>
 * @returns {() => void}
 */
export function inertPage(keep) {
  const body = keep.ownerDocument.body;
  /** @type {HTMLElement[]} */
  const changed = [];
  for (const child of /** @type {HTMLElement[]} */ (Array.from(body.children))) {
    if (child === keep || child.hasAttribute("inert") || child.hasAttribute("data-pocket-above")) continue;
    if (["SCRIPT", "STYLE", "TEMPLATE"].includes(child.tagName)) continue;
    child.setAttribute("inert", "");
    changed.push(child);
  }
  return () => {
    for (const el of changed) el.removeAttribute("inert");
  };
}
