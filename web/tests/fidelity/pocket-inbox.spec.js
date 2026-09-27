import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE INBOX ON A PHONE (#1120, proposal §2.6): what the review card and the
 * lanes do, not how they look (pocket-measure.spec.js holds the floors).
 * The fixture API answers reads only, so the writes an act makes are
 * answered here and read back: that is the assertion.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

/**
 * Answers the three calls approveReceipt makes and records the approval.
 * @param {import("@playwright/test").Page} page
 * @param {string} [itemId]  what the approval answers as the new item's id
 */
async function answerApproval(page, itemId = "i-new") {
  /** @type {{ approvals: any[], discards: string[] }} */
  const seen = { approvals: [], discards: [] };
  await page.route("**/api/imap-inbox/r-*", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (request.method() === "DELETE") {
      seen.discards.push(id);
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      json: {
        receipt: { id, draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
      },
    });
  });
  await page.route("**/api/reviewed-intake/approve", async (route) => {
    seen.approvals.push(route.request().postDataJSON());
    await route.fulfill({ json: { outcome: "approved", itemId } });
  });
  return seen;
}

test("Add to orbit arms on the first tap and approves as proposed on the second", async ({ page }) => {
  const seen = await answerApproval(page);
  await page.goto(`${APP}/inbox`, { waitUntil: "networkidle" });
  const yes = page.getByRole("button", { name: "Add Home insurance renewal to your orbit" });
  await yes.click();
  await expect(page.getByRole("button", { name: "tap again to add Home insurance renewal to your orbit" })).toBeVisible();
  expect(seen.approvals).toHaveLength(0);
  await page.getByRole("button", { name: "tap again to add Home insurance renewal to your orbit" }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  expect(seen.approvals[0]).toMatchObject({
    sectionId: "s-home", action: "create_separate", attachmentIds: ["a-1"],
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
  });
});

test("review & amend opens create's form pre-filled, and approves the amended values into the chosen section", async ({ page }) => {
  const seen = await answerApproval(page);
  await page.goto(`${APP}/inbox`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "review & amend →" }).click();
  const sheet = page.getByRole("dialog", { name: "Review & amend" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "name", exact: true })).toHaveValue("Home insurance renewal");
  await expect(sheet.getByRole("textbox", { name: "provider", exact: true })).toHaveValue("Harbour Mutual");
  await expect(sheet.getByRole("button", { name: "renewal", exact: true })).toHaveAttribute("aria-pressed", "true");
  /* The section has no default (#1058): nothing is sent until one is chosen. */
  const go = sheet.getByRole("button", { name: "add to orbit" });
  await expect(go).toBeDisabled();
  await expect(sheet.getByText("not yet — choose a section")).toBeVisible();
  await sheet.getByRole("button", { name: "Dates & renewals" }).click();
  await sheet.getByRole("textbox", { name: "provider", exact: true }).fill("Harbour Mutual plc");
  await go.click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  expect(seen.approvals[0].sectionId).toBe("s-dates");
  expect(seen.approvals[0].item).toMatchObject({
    title: "Home insurance renewal", provider: "Harbour Mutual plc", costMinor: 40000, currency: "GBP",
    dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12, subtype: "renewal", reminderDays: [21, 7],
  });
  await expect(sheet).toBeHidden();
});

test("a failed arrival the server lets go opens on a tap to remove; one it keeps has none", async ({ page }) => {
  const seen = await answerApproval(page);
  await page.route("**/api/imap-inbox", (route) => route.fulfill({
    json: {
      receipts: [
        { id: "r-gone", receivedAt: "2026-08-09T16:02:00.000Z", classification: "cleanup", canApprove: false,
          canDiscard: true, message: "It carried no document Orbit can read." },
        { id: "r-kept", receivedAt: "2026-08-06T08:41:00.000Z", classification: "unavailable", canApprove: false,
          canDiscard: false, message: "Its document could not be prepared." },
      ],
      filed: [],
    },
  }));
  await page.goto(`${APP}/inbox`, { waitUntil: "networkidle" });
  /* Real buttons in the accessible tree (review round §1.1), out of the
     page until their row opens. */
  await expect(page.getByRole("button", { name: "Remove the message from 09 Aug" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove the message from 06 Aug" })).toHaveCount(0);
  const gone = page.locator(".p-row", { hasText: "A message from 09 Aug" });
  await gone.locator("[data-row-face]").click();
  await expect(gone).toHaveAttribute("data-open", "");
  const remove = page.getByRole("button", { name: "Remove the message from 09 Aug" });
  await expect(remove).toBeVisible();
  await remove.click();
  await page.getByRole("button", { name: "tap again to remove the message from 09 Aug" }).click();
  await expect.poll(() => seen.discards).toEqual(["r-gone"]);
});

/* THE SUGGESTION IN THE BELT ON A PHONE (#1145; round 3 §4's receipt page
   merged into the belt): `/item/<receiptId>` is the belt under the top
   chrome, the suggestion seated at the apex as its card, with the two
   decisions and `review & amend →`. The desk half is belt-suggestion.spec.js. */
test("the receipt address is the belt, wearing the top chrome, with the suggestion's card at the apex", async ({ page }) => {
  await page.goto(`${APP}/item/r-insurance`, { waitUntil: "networkidle" });
  const chrome = page.locator(".p-chrome:visible");
  await expect(chrome.locator(".back")).toHaveAttribute("href", "/home");
  await expect(chrome.locator(".porb")).toBeVisible();
  const card = page.locator(".item-card.sug-card");
  await expect(card.getByRole("heading", { level: 2 })).toHaveText("Home insurance renewal");
  await expect(card.locator(".sub")).toContainText("1 forwarded document · burns up in 43d");
  await expect(card.getByRole("button", { name: "Add Home insurance renewal to your orbit" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Dismiss Home insurance renewal" })).toBeVisible();
  await expect(card.locator(".ip-docs")).toContainText("1 forwarded document");
  /* The old page's own lines are gone with it (round 3 §4, owner's 10b). */
  await expect(page.getByText("back to your orbit")).toHaveCount(0);
  await expect(page.getByText("nothing is created without your acceptance")).toHaveCount(0);
  /* The belt is real: the seat list holds the household and the visitor. */
  await expect(page.locator(".ip-count")).toHaveText("6 items · 1 suggested · sooner to later");
});

test("the suggestion adds to orbit from the belt and becomes the new item's seat", async ({ page }) => {
  const seen = await answerApproval(page, "i-chimney");
  await page.goto(`${APP}/item/r-insurance`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Add Home insurance renewal to your orbit" }).click();
  await page.getByRole("button", { name: "tap again to add Home insurance renewal to your orbit" }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  expect(seen.approvals[0]).toMatchObject({ source: { kind: "mailbox_draft", receiptId: "r-insurance" } });
  /* Accepted, it is an item with a seat of its own: the belt re-reads with
     that item at the apex (the fixture stands in with a real item's id). */
  await expect(page).toHaveURL(/\/item\/i-chimney$/);
  await expect(page.locator(".item-card h2")).toHaveText("Chimney sweep");
  await expect(page.locator(".item-card.sug-card")).toHaveCount(0);
});

test("the receipt page raises the same review sheet", async ({ page }) => {
  await page.goto(`${APP}/item/r-insurance`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "review & amend →" }).click();
  const sheet = page.getByRole("dialog", { name: "Review & amend" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "provider", exact: true })).toHaveValue("Harbour Mutual");
});
