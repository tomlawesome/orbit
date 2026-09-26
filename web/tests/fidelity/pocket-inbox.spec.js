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
 */
async function answerApproval(page) {
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
    await route.fulfill({ json: { outcome: "approved", itemId: "i-new" } });
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
