/**
 * THE RING CLOSES WHILE YOU TYPE (#1127 round 1, proposal §2.13, §1.11).
 *
 * On a phone the keyboard takes the lower half of the screen, so while a
 * field on the door's card has focus the ring closes to its small form and
 * the card rises under it; when focus leaves the card it opens again.
 *
 * These only raise and drop one body class, `typing`. What it looks like is
 * door-phone.css's, inside the pocket's media query, so the desk -- which has
 * no on-screen keyboard to make room for -- never changes.
 *
 * Focus moving between two controls of the same card (field to field, field
 * to the reveal control) does not open and re-close the ring: the class is
 * dropped only when focus leaves the card altogether.
 *
 * Wired as the card form's `onfocusin` / `onfocusout`; the host drops the
 * class when the card goes (`ringOpens`).
 */

/** @param {FocusEvent} event */
export function ringFocusIn(event) {
  const target = /** @type {Element | null} */ (event.target);
  if (target?.matches?.("input, select, textarea")) document.body.classList.add("typing");
}

/** @param {FocusEvent} event */
export function ringFocusOut(event) {
  const card = /** @type {Node | null} */ (event.currentTarget);
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (card && next && card.contains(next)) return;
  ringOpens();
}

/** Open the ring again, whatever has focus. */
export function ringOpens() {
  if (typeof document !== "undefined") document.body.classList.remove("typing");
}
