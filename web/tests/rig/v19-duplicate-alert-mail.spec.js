import { expect, test } from "@playwright/test";

import { APP, onPhone, settle } from "./a11y-support.js";
import { SUGGESTION, rememberMailDecisions } from "./mail-support.js";
import { guardedRoute } from "./workspace-writes.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1437: mail-in review tells a household when an attachment is one it already
 * holds. Specification: owner verdicts 3a, 4a and 5a, and the approved mock-up
 * (design/v19/duplicate-alert/round-1, scenes desk-inbox-renewal,
 * desk-inbox-armed, phone-inbox-renewal).
 *
 *   - the review read marks an attachment with `alreadyHeld`
 *     { documentId, displayName, addedAt, entry: { itemId, title } | null };
 *   - the receipt (desk) / review card (phone) gains a boxed line under the
 *     paper: "Already in your orbit." and the sentence, with an open link
 *     (a row on the phone);
 *   - no new button: "Add to orbit" is the keep-anyway path (owner 5a), still
 *     a two-tap, on the desk and on the phone;
 *   - the renewal line follows the same 30-day / overdue rule (owner 4a).
 *
 * The fixture inbox holds the "Home insurance renewal" receipt with one
 * attachment, policy-schedule.pdf. The fixture server has no hold on any
 * document, so the test marks the attachment itself, in both reads that name it.
 */

test.use({ baseURL: APP, serviceWorkers: "block" });

const SETTLE = 20_000;
const { id: RECEIPT, title: TITLE, attachmentId: ATTACHMENT } = SUGGESTION;
const HELD_MOT = {
  documentId: "d-mot-2025", displayName: "MOT certificate 2025.pdf", addedAt: "2025-08-29T12:00:00.000Z",
  entry: { itemId: "i-mot", title: "Car MOT — Volvo V60" },
};
const HELD_SERVICE = {
  documentId: "d-service-history", displayName: "Service history.pdf", addedAt: "2026-03-03T12:00:00.000Z",
  entry: { itemId: "i-svc", title: "Car full service" },
};
const HELD_OVERDUE = {
  documentId: "d-gutter", displayName: "Gutter quote.pdf", addedAt: "2025-07-28T12:00:00.000Z",
  entry: { itemId: "i-gutter", title: "Gutter clearing" },
};
const SECTIONS = [
  { id: "s-home", name: "Home" }, { id: "s-vehicles", name: "Vehicles" },
  { id: "s-devices", name: "Devices" }, { id: "s-services", name: "Services" },
];

/**
 * Marks the receipt's attachment as already held, in the inbox read and in the
 * review read. Registered after `rememberMailDecisions`, so it answers first.
 * @param {Page} page
 * @param {Record<string, unknown> | null} alreadyHeld
 */
async function markHeld(page, alreadyHeld) {
  /** @param {Record<string, any>[]} attachments */
  const mark = (attachments) => attachments.map((one) => (one.id === ATTACHMENT ? { ...one, alreadyHeld } : one));
  await page.route("**/api/imap-inbox", guardedRoute(async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.receipts = body.receipts.map((/** @type {Record<string, any>} */ one) =>
      one.id === RECEIPT ? { ...one, attachments: mark(one.attachments) } : one);
    return route.fulfill({ response, json: body });
  }));
  await page.route("**/api/imap-inbox/*", guardedRoute(async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname.split("/").pop() !== RECEIPT) return route.fallback();
    const list = await (await route.fetch({ url: new URL("/api/imap-inbox", url).href })).json();
    const receipt = list.receipts.find((/** @type {{ id: string }} */ one) => one.id === RECEIPT);
    const { attachments = [], ...rest } = receipt;
    return route.fulfill({
      json: {
        receipt: { ...rest, householdId: url.searchParams.get("householdId") },
        sections: SECTIONS,
        candidates: [],
        attachments: mark(attachments).map((one) => ({ ...one, status: "stored" })),
      },
    });
  }));
}

/** The approve control, desk or phone. The phone pill's name is "Add <title>
    to your orbit", then "tap again to add ..." once armed (ArmButton), as
    v19-mail-review-unread finds it. @param {Page} page */
const addToOrbit = (page) => (onPhone(test.info())
  ? page.getByRole("button", { name: new RegExp(`add ${TITLE} to your orbit$`, "i") })
  : page.locator(".actions button.yes"));

/** Opens /inbox with the attachment marked. @param {Page} page @param {Record<string, unknown> | null} alreadyHeld */
async function openInbox(page, alreadyHeld) {
  const mail = await rememberMailDecisions(page);
  await markHeld(page, alreadyHeld);
  await page.goto("/inbox");
  await expect(addToOrbit(page).first()).toBeVisible({ timeout: SETTLE });
  await settle(page);
  return mail;
}

const BOX = (/** @type {Page} */ page) => page.getByRole("status").filter({ hasText: "Already in your orbit." });

test("the boxed line names the existing entry, with the open link", async ({ page }, testInfo) => {
  await openInbox(page, HELD_SERVICE);
  const box = BOX(page);
  await expect(box).toHaveCount(1);
  await expect(box).toContainText("byte for byte");
  await expect(box).toContainText("Service history.pdf");
  await expect(box).toContainText("Car full service");
  await expect(box).toContainText("3 Mar 2026");
  await expect(box).toContainText("Add to orbit keeps it as a second copy");
  /* The desk's row says it in quiet lower-case mono, the phone in its sentence (mock-up). */
  await expect(box).toContainText(/dismiss drops the mail, not the one you hold/i);
  if (onPhone(testInfo)) {
    await expect(box.getByRole("button", { name: "open Service history.pdf on Car full service" })).toBeVisible();
  } else {
    await expect(box.getByRole("link", { name: "open Service history.pdf →" })).toHaveAttribute("href", /item=i-svc/);
  }
});

test("Add to orbit keeps it as a second copy: it asks twice, then approves with the attachment, and no keep button exists (owner 5a)", async ({ page }, testInfo) => {
  const mail = await openInbox(page, HELD_SERVICE);
  await expect(page.getByRole("button", { name: /keep (it )?anyway/i })).toHaveCount(0);
  await addToOrbit(page).first().click();
  expect(mail.approvals.length, "one tap only arms").toBe(0);
  /* Both dialects ask twice (v19-feedback-recovery): the desk relabels the button, the phone keeps its label. */
  if (!onPhone(testInfo)) await expect(page.getByRole("button", { name: "tap again to approve" })).toBeVisible();
  await addToOrbit(page).first().click();
  await expect.poll(() => mail.approvals.length, { timeout: SETTLE }).toBe(1);
  expect(mail.approvals[0]).toMatchObject({ source: { receiptId: RECEIPT }, attachmentIds: [ATTACHMENT] });
});

test("the phone's review card gets no extra button for it (owner 5a)", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "the phone's review card");
  await openInbox(page, HELD_SERVICE);
  const card = page.locator("article", { has: BOX(page) });
  /* An ArmButton's text holds its resting and its armed words; the resting one is `.rest`. */
  await expect(card.getByRole("button").filter({ has: page.locator(".rest", { hasText: /^(Add to orbit|Dismiss)$/ }) })).toHaveCount(2);
  await expect(card.getByRole("button", { name: /keep/i })).toHaveCount(0);
});

test.describe("the renewal line", () => {
  const RENEWAL = /If this was meant to be the new certificate, it is last year.s file\./;

  test("shows when the holding entry is due within 30 days", async ({ page }) => {
    await openInbox(page, HELD_MOT);
    const box = BOX(page);
    await expect(box).toContainText("Car MOT — Volvo V60 is due in 16 days.");
    await expect(box).toContainText(RENEWAL);
  });

  test("is not shown when the holding entry is due later", async ({ page }) => {
    await openInbox(page, HELD_SERVICE);
    const box = BOX(page);
    await expect(box).toHaveCount(1);
    await expect(box).not.toContainText(RENEWAL);
    await expect(box).not.toContainText("last year");
  });

  test("shows when the holding entry is overdue", async ({ page }) => {
    await openInbox(page, HELD_OVERDUE);
    const box = BOX(page);
    await expect(box).toContainText("Gutter clearing is ");
    await expect(box).toContainText(RENEWAL);
  });
});

test("an attachment the household does not hold draws no line", async ({ page }) => {
  await openInbox(page, null);
  await expect(page.getByText("Already in your orbit.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^open .* →$/ })).toHaveCount(0);
  await expect(addToOrbit(page).first()).toBeVisible();
});
