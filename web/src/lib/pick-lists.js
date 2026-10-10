/**
 * THE PICK-LISTS: the time zones and currencies a household can be set to
 * (#1338). One list, read by the desk's household screen, the phone's, and
 * the arrival's create card, so no screen keeps a hand-typed copy that can
 * drift (the desk once offered New York with a space in it, a zone the
 * server refuses).
 *
 * Each list is the runtime's full set (`Intl.supportedValuesOf`) with the six
 * favourites first, in the order below, and no value twice. A runtime without
 * `Intl.supportedValuesOf` gets the favourites alone, which is the shortest
 * list that still works. The server validates what is stored (#1333), so
 * these lists are presentation only.
 *
 * `value` is what is stored and sent; `label` is what the reader sees. They
 * differ for a zone (an underscore reads as a space) and for a currency (the
 * code, a dot and its English name).
 */

/** @typedef {{ value: string, label: string }} PickOption */

export const ZONE_FAVOURITES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "America/New_York", "Australia/Sydney", "UTC"];
export const CURRENCY_FAVOURITES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD"];

/** @param {"timeZone" | "currency"} key @returns {string[]} */
function supported(key) {
  try { return Intl.supportedValuesOf?.(key) ?? []; } catch { return []; }
}

/** The favourites first, then everything else the runtime knows, once each.
 *  @param {string[]} favourites @param {string[]} known */
const favouritesFirst = (favourites, known) => [...new Set([...favourites, ...known])];

/** @param {string} zone */
export const zoneLabel = (zone) => zone.replaceAll("_", " ");

/** @returns {PickOption[]} */
export function zoneOptions() {
  return favouritesFirst(ZONE_FAVOURITES, supported("timeZone")).map((value) => ({ value, label: zoneLabel(value) }));
}

/** @returns {PickOption[]} */
export function currencyOptions() {
  /** @type {Intl.DisplayNames | null} */
  let names = null;
  try { names = new Intl.DisplayNames(["en"], { type: "currency" }); } catch { names = null; }
  return favouritesFirst(CURRENCY_FAVOURITES, supported("currency"))
    .map((value) => ({ value, label: `${value} · ${names?.of(value) ?? value}` }));
}
