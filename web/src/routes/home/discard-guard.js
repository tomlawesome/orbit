import { createArm } from "$lib/pocket/arm.js";

/**
 * A LIGHT GUARD ON UNSAVED ROWS (#1319 stage 3b; the coordinator's ruling,
 * 2026-10-08, on the belt's discard guard). While the drawer's rows hold
 * changes -- an edit, an amended suggestion, a completion being asked for --
 * cancel does not discard at once, and nor does Escape or anything that
 * would close the row or the drawer: the cancel pill becomes "discard
 * changes?", and a second press within the arm's hold discards. Otherwise
 * the rows stay open. Rows with nothing changed close at the first press.
 *
 * The shape is the retire pill's own two-press arm (arm.js, ARM_MS), not a
 * browser confirm(). Plain JS, so the mode logic is unit-tested
 * (DrawerModes in drawer-modes.svelte.js holds one of these).
 *
 * @param {{ ms?: number, onchange?: (armed: boolean) => void }} [options]
 */
export function createDiscardGuard(options = {}) {
  const arm = createArm(options);
  return {
    get armed() { return arm.armed; },
    /**
     * A press that would throw the rows away. True when they may go now:
     * nothing changed, or this is the second press inside the hold.
     * @param {boolean} changed
     */
    ask(changed) {
      if (!changed) { arm.disarm(); return true; }
      return arm.tap();
    },
    disarm: arm.disarm,
  };
}

/**
 * Whether the rows differ from what they opened with.
 * @param {unknown} start  the rows as opened
 * @param {unknown} now    the rows as they stand
 */
export const rowsChanged = (start, now) => JSON.stringify(start) !== JSON.stringify(now);
