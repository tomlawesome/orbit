import { expect, test } from "@playwright/test";

import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, onPhone } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1433, design note §2.6 line 21 (e2e, the preview spec's desk and phone
 * viewports): "A 3-page document opens with "1 of 3" and both arrows visible
 * at once (count from the summary), and a page turn completes within 1 s."
 *
 * Shape and helpers copied from v19-document-preview.spec.js (the paper is
 * pressed in its item's home drawer, the open row on a phone). "At once" is
 * proved by holding the first page's picture back (page.route) while the card
 * opens: the count can then only come from the document summary's
 * `pageCount` (#1436 D8), not from the preview's X-Orbit-Page-Count, so the
 * fixture app's THREE_PAGE_PAPER summary must carry `pageCount: 3`.
 *
 * "Within 1 s" is each turn's own expectation timeout, from the press to the
 * label, the pager and the drawn picture all showing the new page.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });

const THREE_PAGE_PAPER = { item: "i-svc", itemTitle: "Car full service", file: "three-page-proving.pdf" };
const ESCAPED_FILE = THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.");
const TURN_MS = 1_000;

/** @typedef {{ item: string, itemTitle: string, file: string }} Paper */

/** The words a page-turner's number shows, without its .sr-only "page " (#1300).
 * @param {Locator} locator */
async function shownText(locator) {
  return locator.evaluate((el) => {
    const copy = /** @type {HTMLElement} */ (el.cloneNode(true));
    for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
    return (copy.textContent ?? "").trim();
  });
}

/** The picture is drawn: complete and with a width.
 * @param {Locator} picture @param {number} timeout */
const drawn = (picture, timeout) =>
  expect.poll(() => picture.evaluate((/** @type {HTMLImageElement} */ img) => (img.complete ? img.naturalWidth : 0)), { timeout })
    .toBeGreaterThan(0);

/** An item's home drawer, opened by its address (#1319).
 * @param {Page} page @param {string} itemId @param {import("@playwright/test").TestInfo} info */
async function openDrawer(page, itemId, info) {
  await page.goto(`/home?item=${itemId}`);
  if (onPhone(info)) {
    const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    return row;
  }
  const drawer = page.locator(`[id="${itemId}-view"]`);
  await expect(drawer).toBeVisible({ timeout: SETTLE });
  return drawer;
}

/** The preview card a paper opens, named for the file and its page.
 * @param {Page} page */
const previewOf = (page) => page.getByRole("dialog", { name: new RegExp(`^${ESCAPED_FILE}(, page \\d+ of \\d+)?$`) });

/** The reader's dialog, named for the file and its item.
 * @param {Page} page */
const readerOf = (page) => page.getByRole("dialog", { name: `${THREE_PAGE_PAPER.file}, ${THREE_PAGE_PAPER.itemTitle}` });

/** Holds every preview picture request until `release()` is called.
 * @param {Page} page */
async function holdPreviews(page) {
  /** @type {() => void} */
  let release = () => undefined;
  const released = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await page.route(/\/api\/documents\/[^/]+\/preview(\?|$)/, async (route) => {
    await released;
    await route.continue();
  });
  return { release };
}

test("a 3-page document opens with \"1 of 3\" and a Next arrow, no Previous arrow on page 1, before its first picture arrives", async ({ page }, testInfo) => {
  const held = await holdPreviews(page);
  const drawer = await openDrawer(page, THREE_PAGE_PAPER.item, testInfo);
  const pressed = drawer.getByRole("button", { name: `Open ${THREE_PAGE_PAPER.file}` });
  await expect(pressed).toBeVisible({ timeout: SETTLE });
  await pressed.click();

  const card = previewOf(page);
  await expect(card).toBeVisible();
  /* The picture is still held: the count and the Next arrow come from the summary; page 1 offers no Previous arrow (not in the accessibility tree). */
  await expect.poll(() => shownText(card.locator(".pager .pgn")), { timeout: SETTLE }).toBe("1 of 3");
  await expect(card.getByRole("button", { name: "Previous page" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Next page" })).toBeVisible();
  const picture = card.getByRole("img", { name: new RegExp(`^Page (1|one) of ${ESCAPED_FILE}$`) });
  const drawnWidth = (await picture.count()) === 0 ? 0 : await picture.first().evaluate((/** @type {HTMLImageElement} */ img) => (img.complete ? img.naturalWidth : 0));
  expect(drawnWidth).toBe(0);

  held.release();
  await drawn(picture, SETTLE);
  await expect.poll(() => shownText(card.locator(".pager .pgn"))).toBe("1 of 3");
});

test("each page turn in the reader of a kept 3-page document completes within 1 s", async ({ page }, testInfo) => {
  const drawer = await openDrawer(page, THREE_PAGE_PAPER.item, testInfo);
  const pressed = drawer.getByRole("button", { name: `Open ${THREE_PAGE_PAPER.file}` });
  await expect(pressed).toBeVisible({ timeout: SETTLE });
  await pressed.click();
  await expect(previewOf(page)).toBeVisible();
  const pageButton = page.getByRole("button", { name: `Read ${THREE_PAGE_PAPER.file}` });
  await expect(pageButton).toBeEnabled({ timeout: SETTLE });
  await pageButton.click();
  const reader = readerOf(page);
  await expect(reader).toBeVisible();
  const picture = reader.getByRole("img", { name: new RegExp(ESCAPED_FILE) });

  /** @param {number} n @param {number} timeout */
  const shown = async (n, timeout) => {
    await expect(reader.locator(".rd-name .rd-of")).toHaveText(`· page ${n} of 3`, { timeout });
    await expect(picture).toHaveAccessibleName(`Page ${n} of ${THREE_PAGE_PAPER.file}`, { timeout });
    await drawn(picture, timeout);
  };
  await shown(1, SETTLE);

  /** @param {number} to @param {() => Promise<void>} press */
  const turn = async (to, press) => {
    const started = Date.now();
    await press();
    await shown(to, TURN_MS);
    expect(Date.now() - started, `turning to page ${to}`).toBeLessThanOrEqual(TURN_MS);
  };
  await turn(2, () => reader.getByRole("button", { name: "Next page" }).click());
  await turn(3, () => reader.getByRole("button", { name: "Next page" }).click());
  await turn(2, () => reader.getByRole("button", { name: "Previous page" }).click());
});
