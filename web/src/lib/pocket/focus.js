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
 * Makes everything on the page except `keep` inert, and returns the undo:
 * at every level from `keep` up to <body>, the siblings of `keep` and of
 * each element holding it go inert (the standard modal pattern, as the
 * `aria-hidden` "hide others" helpers do it), so a sheet seated inside the
 * page (home's chooser and preview sheets) is modal as surely as one
 * portalled to <body> (sheet.js). Elements that were already inert are left
 * alone on restore. Anything marked `data-pocket-above` (the wake, §1.13,
 * which sits above any sheet) stays live too.
 * @param {HTMLElement} keep
 * @returns {() => void}
 */
export function inertPage(keep) {
  const body = keep.ownerDocument.body;
  /** @type {HTMLElement[]} */
  const changed = [];
  for (let node = keep; node !== body && node.parentElement; node = node.parentElement) {
    for (const sibling of /** @type {HTMLElement[]} */ (Array.from(node.parentElement.children))) {
      if (sibling === node || sibling.hasAttribute("inert") || sibling.hasAttribute("data-pocket-above")) continue;
      if (["SCRIPT", "STYLE", "TEMPLATE"].includes(sibling.tagName)) continue;
      sibling.setAttribute("inert", "");
      changed.push(sibling);
    }
  }
  return () => {
    for (const el of changed) el.removeAttribute("inert");
  };
}
