import { expect, test } from "@playwright/test";

import { APP, onPhone, settle } from "./a11y-support.js";
import { SUGGESTION, rememberMailDecisions } from "./mail-support.js";
import { guardedRoute } from "./workspace-writes.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1398 rework (owner notes 56204 and 56230, spec note 56245): the scanner
 * flagged an attachment while the member added the mail. On the inbox review
 * card, desk and phone:
 *   - under that attachment: The scanner flagged a virus or malware inside
 *     attachment: "{name.filetype}", with no view link and no "scanned clean";
 *   - the two buttons are "Add without it" (several flagged files: "Add without
 *     them") and "Discard everything"; both arm on the first tap and act on the
 *     second, like Add to orbit and Dismiss.
 *
 * The fixture inbox has no scanner, so the test marks the receipt's
 * attachments `scanState: "flagged"` in both reads that name them (the inbox
 * and the review), as the server answers for a flagged file.
 */

test.use({ baseURL: APP, serviceWorkers: "block" });

const SETTLE = 20_000;
const { id: RECEIPT, attachmentName: PAPER } = SUGGESTION;
const SECTIONS = [
  { id: "s-home", name: "Home" }, { id: "s-vehicles", name: "Vehicles" },
  { id: "s-devices", name: "Devices" }, { id: "s-services", name: "Services" },
];
const WORDS = (/** @type {string} */ name) => `The scanner flagged a virus or malware inside attachment: "${name}"`;
/* Both layouts are mounted and CSS shows one; a role query counts only the shown one (as the #1437 spec's BOX does). */
const LINE = (/** @type {Page} */ page, /** @type {string} */ name) => page.getByRole("alert").filter({ hasText: WORDS(name) });

/**
 * Makes the receipt's attachments the named files, all flagged.
 * @param {Page} page
 * @param {string[]} names
 */
async function flag(page, names) {
  const flagged = () => names.map((displayName, at) => ({
    id: `a-flagged-${at}`, ordinal: at + 1, displayName, mediaType: "application/pdf", sizeBytes: 831488, scanState: "flagged",
  }));
  await page.route("**/api/imap-inbox", guardedRoute(async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.receipts = body.receipts.map((/** @type {Record<string, any>} */ one) => (one.id === RECEIPT ? { ...one, attachments: flagged() } : one));
    return route.fulfill({ response, json: body });
  }));
  await page.route("**/api/imap-inbox/*", guardedRoute(async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname.split("/").pop() !== RECEIPT) return route.fallback();
    const list = await (await route.fetch({ url: new URL("/api/imap-inbox", url).href })).json();
    const receipt = list.receipts.find((/** @type {{ id: string }} */ one) => one.id === RECEIPT);
    const { attachments: _, ...rest } = receipt;
    return route.fulfill({
      json: {
        receipt: { ...rest, householdId: url.searchParams.get("householdId") },
        sections: SECTIONS,
        candidates: [],
        attachments: flagged().map((one) => ({ ...one, status: "stored" })),
      },
    });
  }));
}

/** Opens /inbox with the receipt's attachments flagged. @param {Page} page @param {string[]} names */
async function openInbox(page, names) {
  const mail = await rememberMailDecisions(page);
  await flag(page, names);
  await page.goto("/inbox");
  await expect(decisions(page, test.info()).add).toBeVisible({ timeout: SETTLE });
  await settle(page);
  return mail;
}

/** The two decisions, by what they rest on; stable while armed (the desk's `.actions`, the phone's `.rv-acts`).
 *  @param {Page} page @param {import("@playwright/test").TestInfo} info */
const decisions = (page, info) => (onPhone(info)
  ? { add: page.locator(".rv-acts .rv-yes").first(), discard: page.locator(".rv-acts .rv-no").first() }
  : { add: page.locator(".actions button.yes").first(), discard: page.locator(".actions button:not(.yes)").first() });

test("under a flagged attachment the card says so, with no 'scanned clean' and no view link", async ({ page }, testInfo) => {
  await openInbox(page, [PAPER]);
  await expect(LINE(page, PAPER)).toHaveCount(1);
  await expect(page.getByText("scanned clean")).toHaveCount(0);
  await expect(page.getByText(/view →/i)).toHaveCount(0);
  if (onPhone(testInfo)) {
    await expect(page.locator(".rv-paper", { hasText: PAPER })).toBeDisabled();
  } else {
    await expect(page.getByRole("link", { name: new RegExp(PAPER) })).toHaveCount(0);
  }
});

test("one flagged attachment: the buttons are Add without it and Discard everything", async ({ page }, testInfo) => {
  await openInbox(page, [PAPER]);
  const { add, discard } = decisions(page, testInfo);
  await expect(add).toContainText("Add without it");
  await expect(discard).toContainText("Discard everything");
  await expect(page.getByRole("button", { name: /^Add to orbit$|^Dismiss$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add without them/ })).toHaveCount(0);
});

test("several flagged attachments: one line each, and the button is Add without them", async ({ page }, testInfo) => {
  await openInbox(page, [PAPER, "terms.pdf"]);
  await expect(LINE(page, PAPER)).toHaveCount(1);
  await expect(LINE(page, "terms.pdf")).toHaveCount(1);
  const { add, discard } = decisions(page, testInfo);
  await expect(add).toContainText("Add without them");
  await expect(discard).toContainText("Discard everything");
});

test("Add without it asks twice, then adds the mail", async ({ page }, testInfo) => {
  const mail = await openInbox(page, [PAPER]);
  const { add } = decisions(page, testInfo);
  await expect(add).toContainText("Add without it");
  await add.click();
  expect(mail.approvals.length, "one tap only arms").toBe(0);
  await add.click();
  await expect.poll(() => mail.approvals.length, { timeout: SETTLE }).toBe(1);
  expect(mail.approvals[0]).toMatchObject({ source: { receiptId: RECEIPT } });
  expect(mail.removals).toEqual([]);
});

test("Discard everything asks twice, then discards the mail", async ({ page }, testInfo) => {
  const mail = await openInbox(page, [PAPER]);
  const { discard } = decisions(page, testInfo);
  await expect(discard).toContainText("Discard everything");
  await discard.click();
  expect(mail.removals, "one tap only arms").toEqual([]);
  await discard.click();
  await expect.poll(() => mail.removals, { timeout: SETTLE }).toEqual([RECEIPT]);
  expect(mail.approvals).toHaveLength(0);
});
