import { notSavedWords, savePreferences } from "$lib/data/workspace.js";
import { wake } from "$lib/pocket/wake.js";
import { applyTextSize } from "$lib/text-size.js";
import { applyTheme } from "$lib/theme-swatches.js";

/*
 * A pick of theme or text size (#1180): the page changes at once, the cache
 * for the next paint is written, then the choice goes to the server, which is
 * the source of truth. The apply helpers stay DOM-only; the server write is
 * savePreferences. A failed save leaves the pick on this page (the cache
 * still holds it) and says so, in the save vocabulary.
 */

/** @param {{ theme?: string, textSize?: string, labelDays?: number, skyDriver?: "due" | "warning" }} change */
async function save(change) {
  try {
    await savePreferences(change);
  } catch (error) {
    wake(notSavedWords(error), { failure: true });
  }
}

let picks = 0;
/** How many picks this page has seen; a session read that began before one must not overwrite it. */
export const picksMade = () => picks;

/** @param {string} id */
export function chooseTheme(id) {
  picks += 1;
  applyTheme(id);
  return save({ theme: id });
}

/** @param {string} id */
export function chooseTextSize(id) {
  picks += 1;
  applyTextSize(id);
  return save({ textSize: id });
}

/**
 * Planet names within N days (#1461): the page already shows it (the slider's
 * `input` redraws the live sky); this is the release, which saves.
 * @param {number} days
 */
export function chooseLabelDays(days) {
  picks += 1;
  return save({ labelDays: days });
}

/**
 * What sets a planet's distance from the sun (#1462): the due date or the
 * reader's warning date. The page redraws its live sky itself; this saves.
 * @param {"due" | "warning"} skyDriver
 */
export function chooseSkyDriver(skyDriver) {
  picks += 1;
  return save({ skyDriver });
}
