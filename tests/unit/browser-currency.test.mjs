import { afterEach, describe, expect, it, vi } from "vitest";

import { browserCurrency } from "../../web/src/lib/arrival/stage.js";

/*
 * #1316: the newcomer's create form starts its currency from the browser's
 * language region. browserCurrency() answers the currency of the region in
 * `navigator.language`, or null when there is no region, the region is not
 * one the lists know, or the locale cannot be read. These pin that behaviour.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** @param {string} language */
function browserLanguage(language) {
  vi.spyOn(navigator, "language", "get").mockReturnValue(language);
}

describe("browserCurrency", () => {
  it.each([
    ["en-GB", "GBP"],
    ["en-IE", "EUR"],
    ["fr-FR", "EUR"],
    ["de-DE", "EUR"],
    ["en-US", "USD"],
    ["en-CA", "CAD"],
    ["en-AU", "AUD"],
    ["en-NZ", "NZD"],
  ])("%s gives %s", (language, currency) => {
    browserLanguage(language);
    expect(browserCurrency()).toBe(currency);
  });

  it.each([
    ["en", "no region"],
    ["de-AT", "a region the lists do not cover"],
  ])("%s gives null (%s)", (language) => {
    browserLanguage(language);
    expect(browserCurrency()).toBeNull();
  });

  it("gives null when Intl.Locale throws", () => {
    browserLanguage("en-GB");
    vi.spyOn(Intl, "Locale").mockImplementation(() => { throw new RangeError("bad locale"); });
    expect(browserCurrency()).toBeNull();
  });
});
