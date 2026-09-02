import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";

/**
 * #434: mail-in review on the v19 surfaces — the manifest row's two-tap
 * approve (idempotent under retry), amend-then-accept in the item view, and
 * arrived-but-unreadable mail visible on the relay. Synthetic receipts ride
 * route interception exactly as the Next inbox spec does, so approval
 * payloads are asserted without pre-approval mutation.
 */
const receiptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const sectionId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const attachmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";

/* #730: every test here seeds its own proving ground and removes it again,
   so none of the three is left in the sky a later spec measures.

   The name carries a per-test suffix because these three tests run in
   PARALLEL locally (playwright.config.ts sets fullyParallel with workers
   undefined off CI, so one worker per core). A shared fixed name meant three
   concurrent creates of the same household, and -- once cleanup existed -- one
   worker hard-deleting the household another was still using. CI never showed
   it because CI pins workers to 1. Nothing asserts the name; it is only used
   to create and to sweep. */
const HOUSEHOLD_PREFIX = "Mail Proving Ground";
const households = householdRegister();

async function signInToHome(page: Page) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function seedHousehold(page: Page): Promise<{ householdId: string; itemId: string }> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const command = async (payload: unknown) => {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    };
    const householdId = crypto.randomUUID();
    const homeSection = crypto.randomUUID();
    await command({
      type: "household.create",
      household: {
        id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: homeSection, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    await command({
      type: "item.upsert",
      householdId,
      item: { id: itemId, sectionId: homeSection, title: "Reviewed intake landing", currency: "GBP", status: "active" },
      activity: { id: crypto.randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { householdId, itemId };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

function readyReceipt(householdId: string) {
  return {
    id: receiptId,
    status: "pending_review",
    householdId,
    draftVersion: 3,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    receivedAt: new Date().toISOString(),
    attachmentCount: 1,
    classification: "ready",
    canApprove: true,
    canDiscard: true,
    cleanupOnly: false,
    message: "Ready for your review.",
    proposal: { title: "Reviewed intake 1786823446152", provider: "Reviewed Cover", costMinor: 12550, currency: "GBP", dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12 },
    fieldEvidence: { title: { source: "parser", confidence: "medium" }, costMinor: { source: "parser", confidence: "low" } },
  };
}

async function interceptMail(page: Page, householdId: string, approvals: Record<string, unknown>[], options: { firstPartial?: boolean } = {}) {
  let approved = false;
  const receipt = readyReceipt(householdId);
  await page.route("**/api/imap-inbox", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipts: approved ? [] : [receipt], households: [{ id: householdId, name: "Mail Proving Ground", currency: "GBP" }] }) });
  });
  await page.route(`**/api/imap-inbox/${receiptId}*`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        receipt,
        sections: [{ id: sectionId, name: "Documents" }],
        candidates: [],
        attachments: [{ id: attachmentId, ordinal: 1, mediaType: "application/pdf", sizeBytes: 128 }],
      }),
    });
  });
  await page.route("**/api/reviewed-intake/approve", async (route) => {
    approvals.push(route.request().postDataJSON() as Record<string, unknown>);
    if (options.firstPartial && approvals.length === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "partial_success", itemId: null }) });
      return;
    }
    approved = true;
    const body = route.request().postDataJSON() as { itemId?: string };
    void body;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "approved", itemId: (options as { approvedItemId?: string }).approvedItemId ?? null }) });
  });
}

test("the manifest row approves in two taps, idempotently under partial success", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket dialect has no suggestion rows yet (#434 follow-up)");
  await signInToHome(page);
  const { householdId } = await seedHousehold(page);

  try {
    const approvals: Record<string, unknown>[] = [];
    await interceptMail(page, householdId, approvals, { firstPartial: true });

    await page.reload();
    const row = page.locator(".item.suggest", { hasText: "Reviewed intake 1786823446152" });
    await expect(row.first()).toBeVisible();
    const approve = row.first().getByRole("button", { name: "Add to orbit" });

    // One stray click does nothing but arm.
    await approve.click();
    await expect(row.first().getByRole("button", { name: "tap again to approve" })).toBeVisible();
    expect(approvals.length).toBe(0);

    // The second tap fires; the first answer is partial, so the row says so.
    await row.first().getByRole("button", { name: "tap again to approve" }).click();
    await expect.poll(() => approvals.length).toBe(1);
    await expect(row.first().locator(".mail-problem")).toContainText("another try");

    // The retry carries the SAME operation id and the SAME body: one item, ever.
    await row.first().getByRole("button", { name: "tap again to approve" }).click();
    await expect.poll(() => approvals.length).toBe(2);
    expect(approvals[1]).toEqual(approvals[0]);
    expect(approvals[0]).toMatchObject({
      source: { kind: "mailbox_draft", receiptId, draftVersion: 3 },
      householdId,
      sectionId,
      action: "create_separate",
      item: { title: "Reviewed intake 1786823446152", provider: "Reviewed Cover", costMinor: 12550, currency: "GBP", dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12 },
      attachmentIds: [attachmentId],
    });
    // Approved: the suggestion leaves the manifest.
    await expect(page.locator(".item.suggest", { hasText: "Reviewed intake" })).toHaveCount(0);
  } finally {
    await households.sweep(page);
  }
});

test("amend then accept from the item view", async ({ page }) => {
  await signInToHome(page);
  const { householdId, itemId } = await seedHousehold(page);

  try {
    const approvals: Record<string, unknown>[] = [];
    await interceptMail(page, householdId, approvals, { approvedItemId: itemId } as { firstPartial?: boolean });

    await page.goto(`/item/${receiptId}`);
    const title = page.locator(".name-title");
    await expect(title).toHaveValue("Reviewed intake 1786823446152");
    // Extraction-read fields carry the from-document mark.
    await expect(title).toHaveClass(/sugg/);

    await title.fill("Home insurance, corrected");
    await page.locator("#s-cost").fill("199.99");
    await page.getByRole("button", { name: "accept into orbit" }).click();

    await expect.poll(() => approvals.length).toBe(1);
    expect(approvals[0]).toMatchObject({
      source: { kind: "mailbox_draft", receiptId, draftVersion: 3 },
      action: "create_separate",
      item: { title: "Home insurance, corrected", costMinor: 19999, currency: "GBP", dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12 },
      attachmentIds: [attachmentId],
    });
    // Acceptance lands on the created item.
    await expect(page).toHaveURL(new RegExp(`/item/${itemId}$`));
    await expect(page.getByRole("heading", { name: "Reviewed intake landing" })).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

test("a dismissal takes two taps and mail that failed is visible on the relay", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket dialect has no suggestion rows yet (#434 follow-up)");
  await signInToHome(page);
  const { householdId } = await seedHousehold(page);

  try {
    let dismissed = false;
    await page.route("**/api/imap-inbox", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          receipts: [
            ...(dismissed ? [] : [readyReceipt(householdId)]),
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", status: "failed", householdId, draftVersion: 1,
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(), receivedAt: "2026-08-14T08:00:00.000Z",
              attachmentCount: 0, classification: "unavailable", canApprove: false, canDiscard: false,
              cleanupOnly: false, message: "This incoming document is no longer available for review.",
              proposal: {}, fieldEvidence: {},
            },
          ],
          households: [{ id: householdId, name: "Mail Proving Ground", currency: "GBP" }],
        }),
      });
    });
    await page.route(`**/api/imap-inbox/${receiptId}*`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      dismissed = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.reload();
    const row = page.locator(".item.suggest", { hasText: "Reviewed intake 1786823446152" }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Dismiss" }).click();
    await expect(row.getByRole("button", { name: "tap again to dismiss" })).toBeVisible();
    await row.getByRole("button", { name: "tap again to dismiss" }).click();
    await expect(page.locator(".item.suggest", { hasText: "Reviewed intake" })).toHaveCount(0);

    // The failed message is on the relay, dated, in the server's own words.
    await page.goto("/settings/mail");
    await expect(page.locator(".failures")).toContainText("arrived, but could not be read");
    await expect(page.locator(".failures")).toContainText("no longer available for review");
    await expect(page.locator(".failures")).toContainText("14 Aug");
  } finally {
    await households.sweep(page);
  }
});
