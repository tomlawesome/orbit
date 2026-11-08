import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";

/*
 * #1437: the Add form tells a household when the file it just picked is one it
 * already holds. Specification: the owner's verdicts 3a, 4a and 5a on the
 * issue, and the approved mock-up (design/v19/duplicate-alert/round-1, scenes
 * desk-add-duplicate, desk-add-renewal, desk-add-kept, phone-add-*), which
 * holds the words.
 *
 *   - the upload answer carries `document.alreadyHeld`
 *     { documentId, displayName, addedAt, entry: { itemId, title } | null };
 *   - the alert is a state of the reading card (desk lane / phone card): the
 *     head "Already in your orbit", "You already hold this document.", one
 *     sentence naming the file, the entry and the day, an open link, then
 *     "keep it anyway" and "not this one";
 *   - the read waits for the answer;
 *   - "keep it anyway" returns the card to "Page one" with the quiet line
 *     "kept as a second copy · the first is on <entry>";
 *   - the renewal line shows only when the holding entry is due within 30 days
 *     or is overdue (owner 4a). The fixture's today is 2026-08-13: Car MOT is
 *     due in 16 days, Car full service in 161, Gutter clearing 16 days ago.
 *
 * The fixture app has no route for staging a document, so the test answers
 * the stage itself, as v19-create.spec.js does.
 */

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

const SETTLE = 20_000;
const DOCUMENT = "MOT certificate 2026.pdf";
const DOCUMENT_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 32), Buffer.from("%%EOF\n")]);
const pdf = () => ({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
const onPhone = () => test.info().project.name.includes("phone");

/** What the stage answers when the household already holds the file. */
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

/**
 * Answers the stage with a stored document and the given `alreadyHeld`, and
 * counts the reads of the file (the inspection), which wait for the answer.
 * @param {import("@playwright/test").Page} page
 * @param {Record<string, unknown> | null} alreadyHeld
 */
async function stageAnswered(page, alreadyHeld) {
  const reads = { count: 0 };
  await page.route("**/item-document-inspection", (route) => {
    reads.count += 1;
    return route.fallback();
  });
  await page.route(/\/api\/households\/[^/]+\/documents$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const documentId = request.headers()["x-orbit-document-id"];
    return route.fulfill({
      status: 201,
      json: {
        document: {
          id: documentId, itemId: request.headers()["x-orbit-item-id"], displayName: DOCUMENT, mediaType: "application/pdf", sizeBytes: 2062,
          lifecycle: "stored", scanStatus: "clean", availableAt: new Date().toISOString(), deleteAfter: null, ready: true,
          failureCode: null, recoverable: false, recoveryExpiresAt: null, recoveryStatus: null,
          alreadyHeld,
        },
      },
      headers: { "cache-control": "no-store" },
    });
  });
  return reads;
}

/** Opens Add and picks the file; returns the card the alert lives in. @param {import("@playwright/test").Page} page */
async function pickFile(page) {
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  if (onPhone()) {
    const form = page.getByRole("form", { name: "New entry" });
    await form.locator('input[type="file"]').setInputFiles(pdf());
    return page.locator("main");
  }
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE });
  await page.locator('#card input[type="file"]').setInputFiles(pdf());
  return page.locator("#readcard");
}

const ALERT_HEAD = /already in your orbit/i;
const sentence = (/** @type {{ displayName: string, entry: { title: string } }} */ held, /** @type {string} */ added) =>
  `It is the same file, byte for byte, as ${held.displayName} on ${held.entry.title}, added ${added}.`;

test.describe("the card says the file is already held", () => {
  test("names the existing entry, in the mock-up's words", async ({ page }) => {
    await stageAnswered(page, HELD_SERVICE);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    await expect(card).toContainText("You already hold this document.");
    await expect(card).toContainText(sentence(HELD_SERVICE, "3 Mar 2026"));
    await expect(card).toContainText("nothing has been read from it yet");
    await expect(card.getByRole("button", { name: "keep it anyway" })).toBeVisible();
    await expect(card.getByRole("button", { name: "not this one" })).toBeVisible();
  });

  test("the open link leads to the entry that holds the file", async ({ page }) => {
    await stageAnswered(page, HELD_SERVICE);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    if (onPhone()) {
      const row = card.getByRole("button", { name: "open Service history.pdf on Car full service" });
      await expect(row).toBeVisible();
      await expect(row).toBeEnabled();
      await row.click();
    } else {
      const link = card.getByRole("link", { name: "open Service history.pdf →" });
      await expect(link).toHaveAttribute("href", /item=i-svc/);
      await link.click();
    }
    await expect(page).toHaveURL(/item=i-svc/, { timeout: SETTLE });
  });

  test("the read waits for the answer: nothing is read until the person keeps the file", async ({ page }) => {
    const reads = await stageAnswered(page, HELD_SERVICE);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    await page.waitForTimeout(500);
    expect(reads.count, "no read while the alert is up").toBe(0);
    await card.getByRole("button", { name: "keep it anyway" }).click();
    await expect.poll(() => reads.count, { timeout: SETTLE }).toBeGreaterThan(0);
  });

  test("keep it anyway returns the card to page one with a quiet kept line", async ({ page }) => {
    await stageAnswered(page, HELD_MOT);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    await card.getByRole("button", { name: "keep it anyway" }).click();
    await expect(card.getByRole("heading", { name: "Page one" })).toBeVisible({ timeout: SETTLE });
    await expect(card).toContainText("kept as a second copy · the first is on Car MOT — Volvo V60");
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "keep it anyway" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "not this one" })).toBeVisible();
  });

  test("not this one drops the file and the alert with it", async ({ page }) => {
    await stageAnswered(page, HELD_SERVICE);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    await card.getByRole("button", { name: "not this one" }).click();
    await expect(page.getByText("You already hold this document.")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: ALERT_HEAD })).toHaveCount(0);
    await expect(page.getByText(/kept as a second copy/)).toHaveCount(0);
    await expect(page.getByText(DOCUMENT)).toHaveCount(0);
  });
});

test.describe("the renewal line (owner 4a: due within 30 days, or overdue)", () => {
  const RENEWAL = /If you meant to add this year.s certificate, this is last year.s file\./;

  test("shows when the holding entry is due inside the 30-day window", async ({ page }) => {
    await stageAnswered(page, HELD_MOT);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    await expect(card).toContainText("Car MOT — Volvo V60 is due in 16 days.");
    await expect(card).toContainText(RENEWAL);
  });

  test("is not shown when the holding entry is due later than that", async ({ page }) => {
    await stageAnswered(page, HELD_SERVICE);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    await expect(card).not.toContainText(RENEWAL);
    await expect(card).not.toContainText("is due in 161 days");
    await expect(card).not.toContainText("last year");
  });

  test("shows when the holding entry is overdue", async ({ page }) => {
    await stageAnswered(page, HELD_OVERDUE);
    const card = await pickFile(page);
    await expect(card.getByRole("heading", { name: ALERT_HEAD })).toBeVisible({ timeout: SETTLE });
    await expect(card).toContainText(/Gutter clearing is /);
    await expect(card).toContainText(RENEWAL);
  });
});

test("a file the household does not hold shows no alert at all", async ({ page }) => {
  const reads = await stageAnswered(page, null);
  const card = await pickFile(page);
  await expect.poll(() => reads.count, { timeout: SETTLE }).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: ALERT_HEAD })).toHaveCount(0);
  await expect(page.getByText("You already hold this document.")).toHaveCount(0);
  await expect(page.getByText(/kept as a second copy/)).toHaveCount(0);
  await expect(card.getByRole("button", { name: "keep it anyway" })).toHaveCount(0);
});
