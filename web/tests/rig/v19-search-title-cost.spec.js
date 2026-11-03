import { expect, test } from "@playwright/test";

import { APP, onPhone, RIG_EXPECT_MS, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1438, moved to the rig (ADR-0039, #1611) from tests/e2e/v19-search-title-cost.spec.ts:
 * a home-search result is the item's title and its cost, nothing else. Before,
 * each match drew three lines ("Insurance" / "T-1d · 16 Oct · £300.00" /
 * "◆ Your policy documents-1.pdf"). The owner's decision (2026-10-15): no
 * document names, no date, no T- countdown, on the desk and on the phone.
 * Documents stay searchable: a document-name match still finds its item, it is
 * only not shown under it.
 *
 * Desk: the results are `#explore-results` (a listbox of options, the strip's
 * accessible read) and the strip itself is `#strip`. Phone: the search sheet
 * raised by `.msearch`, its field `.pk-field` and its list
 * `.pk-results [data-row-face]`.
 *
 * The stack suite seeded two items and uploaded a document; here the items are
 * the fixture workspace's Harlow Home (state `/home` / `rest`, nothing written):
 *   - i-mot  "Car MOT — Volvo V60", 54.85 GBP, papers "MOT certificate 2025"
 *            and "Service history";
 *   - i-svc  "Car full service", 300.00 GBP, papers service-invoice-2026.pdf
 *            and service-checklist.pdf.
 */
test.use({ baseURL: APP });

const TITLE = "Car MOT — Volvo V60";
const COST_SHOWN = "£54.85";
const OTHER_TITLE = "Boiler service";
const DOC_ITEM_TITLE = "Car full service";
const DOC_ITEM_COST = "£300.00";
/* the paper service-checklist.pdf on i-svc: searched by a word of its name */
const DOCUMENT_WORD = "checklist";

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
/** Any "T-1d" / "T−12d" / "T+3d" countdown, in either minus sign. */
const COUNTDOWN = /\bT\s?[−\-+–]\s?\d+\s?d/u;
/** Any "16 Oct" / "Oct 16" style day-and-month. */
const DAY_MONTH = new RegExp(`\\b\\d{1,2}\\s(${MONTHS})\\b|\\b(${MONTHS})\\s\\d{1,2}\\b`, "u");

/** Goes to /home and types the query into the layout's own search. Returns the
 *  locator holding the results and the locator of one item's result.
 * @param {Page} page @param {string} query */
async function search(page, query) {
  await signedIn("/home", "rest")(page);
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  if (onPhone(test.info())) {
    await page.locator(".msearch").click();
    await page.locator(".p-sheet-layer.open .pk-field").fill(query);
    const results = page.locator(".p-sheet-layer.open .pk-results");
    return { results, one: (/** @type {string} */ title) => results.locator("[data-row-face]").filter({ hasText: title }) };
  }
  await page.locator("#explore").fill(query);
  const results = page.locator("#explore-results");
  return { results, one: (/** @type {string} */ title) => results.getByRole("option").filter({ hasText: title }) };
}

/** @param {Locator} locator */
const readable = async (locator) => ((await locator.textContent()) ?? "").replace(/\s+/gu, " ").trim();

/** The result is the title and the cost, and not a word more.
 * @param {Locator} result @param {string} title @param {string} cost */
async function expectTitleAndCostOnly(result, title, cost) {
  await expect(result).toHaveCount(1);
  const text = await readable(result);
  const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  expect(text).toMatch(new RegExp(`^${escape(title)}[\\s,;:·–—\\-]*${escape(cost)}$`, "u"));
  expect(text).not.toMatch(COUNTDOWN);
  expect(text).not.toMatch(DAY_MONTH);
  expect(text).not.toContain("◆");
  expect(text.toLowerCase()).not.toContain(DOCUMENT_WORD);
  expect(text).not.toContain(".pdf");
}

/** The whole result list names no document, date or countdown.
 * @param {Locator} results */
async function expectNothingElseAnywhere(results) {
  const text = await readable(results);
  expect(text).not.toMatch(COUNTDOWN);
  expect(text).not.toMatch(DAY_MONTH);
  expect(text).not.toContain("◆");
  expect(text.toLowerCase()).not.toContain(DOCUMENT_WORD);
  expect(text).not.toContain(".pdf");
  expect(text).not.toContain("MOT certificate");
  expect(text).not.toContain("Service history");
}

test("a search result shows the item's title and cost, with no document, date or T- figure", async ({ page }) => {
  const { results, one } = await search(page, "car mot");
  // Positive first: the item is listed, with its title and its cost.
  const result = one(TITLE);
  await expect(result).toHaveCount(1, { timeout: RIG_EXPECT_MS });
  await expect(result).toContainText(TITLE);
  await expect(result).toContainText(COST_SHOWN);
  await expectTitleAndCostOnly(result, TITLE, COST_SHOWN);
  await expectNothingElseAnywhere(results);
  await expect(one(OTHER_TITLE)).toHaveCount(0);

  if (!onPhone(test.info())) {
    // The strip's own drawn text too: one mark, and it carries no date or countdown.
    await expect(page.locator("#strip .match")).toHaveCount(1);
    const strip = await readable(page.locator("#strip"));
    expect(strip).not.toMatch(COUNTDOWN);
    expect(strip).not.toMatch(DAY_MONTH);
    expect(strip.toLowerCase()).not.toContain(DOCUMENT_WORD);
  }
});

test("a search for a document's name still lists its item, by title and cost only", async ({ page }) => {
  const { results, one } = await search(page, DOCUMENT_WORD);
  // The document-name match finds the item (the index is still fed)...
  const result = one(DOC_ITEM_TITLE);
  await expect(result).toHaveCount(1, { timeout: RIG_EXPECT_MS });
  await expect(result).toContainText(DOC_ITEM_COST);
  // ...but not an item whose papers do not match, and the document's name is drawn nowhere.
  await expect(one(OTHER_TITLE)).toHaveCount(0);
  await expect(one(TITLE)).toHaveCount(0);
  await expectTitleAndCostOnly(result, DOC_ITEM_TITLE, DOC_ITEM_COST);
  await expectNothingElseAnywhere(results);
});
