/*
 * #1509: what the relay's unit tests share now that the relay is a tab of the
 * Settings screen, not a page of its own. Not a test.
 *
 * The tests compile the real Settings page and mount it in happy-dom over a
 * stubbed server. Settings draws both dialects at once (CSS picks one), so a
 * test names the layout it reads and the other is taken out of the document,
 * as the old page drew only the one `isPocket()` chose.
 */

const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * The answers Settings' own reads need beyond the relay's: the workspace (one
 * household-less reader) and the inbox (whose failed receipts the relay
 * panel lists). Everything else Settings reads degrades on a 503, as it does
 * for a reader with nothing set up. Null for any other address.
 * @param {string} href
 * @param {{ receipts?: object[] }} [options]
 */
export function settingsAnswer(href, { receipts = [] } = {}) {
  if (href.endsWith("/api/workspace")) return json({ workspace: { households: [], activeHouseholdId: null } });
  if (href.endsWith("/api/imap-inbox")) return json({ receipts, filed: [] });
  return null;
}

/**
 * Lands the window where the sender check's email lands (`?sender=`, no
 * hash) or where a link to the relay lands (`#mail`).
 * @param {string} [search]
 */
export function landOnSettings(search = "") {
  window.history.replaceState({}, "", `/settings${search}${search ? "" : "#mail"}`);
}

/**
 * Takes the other dialect's markup out of the document, so a row or a button
 * is found once. `.st-pocket` is the phone's root; `.helm-page .page` the desk's.
 * @param {boolean} pocket
 */
export function showOnly(pocket) {
  for (const element of document.querySelectorAll(pocket ? ".helm-page .page" : ".st-pocket")) element.remove();
}
