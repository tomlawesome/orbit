import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";

/* #730: the household this spec seeds (when the account has none) is removed
   again at the end of the test, so it is not left in a later spec's sky. */
const households = householdRegister();

const syntheticReceiptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const syntheticHouseholdId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const syntheticSectionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const syntheticItemId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const syntheticAttachmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL("/workspace");
}

async function readWorkspace(page: Page) {
  const response = await page.request.get("/api/workspace");
  return await response.json() as { workspace?: { households?: Array<{ items?: unknown[] }> } };
}

async function openInbox(page: Page) {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Incoming documents" })).toBeVisible();
}

async function ensureHousehold(page: Page) {
  const current = await readWorkspace(page);
  if (current.workspace?.households?.length) return;
  const session = await page.request.get("/api/auth/session");
  const { csrfToken } = await session.json() as { csrfToken: string };
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const householdName = `Mailbox review ${householdId.slice(0, 8)}`;
  const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": csrfToken };
  const create = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: { id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP", memberCount: 1, canManage: true, onboardingComplete: true, sections: [{ id: sectionId, name: "Documents", icon: "home", accent: "sage", visible: true }], items: [], activities: [], readNotificationIds: [], dismissedNotificationIds: [],
      },
    },
  });
  expect(create.ok()).toBeTruthy();
  households.track({ id: householdId, name: householdName });
  await page.reload();
}

test.describe("authenticated mailbox review", () => {
  test("reviews synthetic receipt on desktop and mobile without pre-approval mutation", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    await signIn(page);
    await ensureHousehold(page);
    try {
      const before = await readWorkspace(page);
      let approved = false;
      const approvalBodies: Record<string, unknown>[] = [];
      const household = { id: syntheticHouseholdId, name: "Synthetic private household", currency: "GBP" };
      const receipt = {
        id: syntheticReceiptId,
        status: "pending_review",
        householdId: syntheticHouseholdId,
        draftVersion: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        receivedAt: new Date().toISOString(),
        attachmentCount: 1,
        classification: "ready",
        canApprove: true,
        canDiscard: true,
        message: "Ready for your review.",
        proposal: { title: "Untrusted suggested title", provider: "Suggested provider", reference: "SUGGESTED-123", currency: "GBP" },
        fieldEvidence: { title: { source: "parser", confidence: "medium" } },
      };
      await page.route("**/api/imap-inbox", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipts: approved ? [] : [receipt], households: [household] }) });
      });
      await page.route("**/api/imap-inbox/*", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            receipt,
            sections: [{ id: syntheticSectionId, name: "Documents" }],
            candidates: [{ itemId: syntheticItemId, title: "Existing household item", reason: "matching provider" }],
            attachments: [{ id: syntheticAttachmentId, ordinal: 1, mediaType: "application/pdf", sizeBytes: 128 }],
          }),
        });
      });
      await page.route("**/api/reviewed-intake/approve", async (route) => {
        approvalBodies.push(route.request().postDataJSON() as Record<string, unknown>);
        if (approvalBodies.length === 1) {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "partial_success", itemId: "ffffffff-ffff-4fff-8fff-ffffffffffff", approvalResultId: "99999999-9999-4999-8999-999999999999", attachmentState: "pending", attachedAttachmentIds: [], pendingAttachmentIds: [syntheticAttachmentId] }) });
          return;
        }
        approved = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "approved", itemId: "ffffffff-ffff-4fff-8fff-ffffffffffff", approvalResultId: "99999999-9999-4999-8999-999999999999", attachmentState: "attached", attachedAttachmentIds: [syntheticAttachmentId], pendingAttachmentIds: [] }) });
      });

      await openInbox(page);
      await expect(page.getByText("Ready for your review.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Review", exact: true }).click();
      const review = page.getByRole("region", { name: "Check every value before saving" });
      await expect(review).toBeVisible();
      await expect(review.getByLabel("Title")).toHaveValue("Untrusted suggested title");
      await expect(review).not.toContainText(/sender|filename|storageKey|contentSha256/i);
      await review.getByLabel("Title").fill("Corrected reviewed title");
      await review.getByLabel("Type").fill("Insurance");
      await review.getByRole("textbox", { name: "Provider" }).fill("Corrected provider");
      await review.getByLabel("Reference").fill("");
      await review.getByLabel("Cost").fill("125.50");
      await review.getByLabel("Currency").fill("GBP");
      await review.getByLabel("Schedule").selectOption("renewal");
      await review.getByLabel("Renewal date").fill("2031-01-10");
      await review.getByLabel("Repeats every").selectOption("12");
      await review.getByLabel("Notes").fill("Reviewed notes");
      await review.getByLabel("Section").selectOption(syntheticSectionId);
      if (isMobile) {
        await review.getByRole("radio", { name: /Existing household item/ }).check();
        await expect(review.getByRole("button", { name: "Attach selected documents" })).toBeVisible();
      }
      const beforeApproval = await readWorkspace(page);
      expect(beforeApproval).toEqual(before);
      const submit = review.getByRole("button", { name: isMobile ? "Attach selected documents" : "Create separate item" });
      await submit.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => approvalBodies.length).toBe(1);
      expect(approvalBodies[0]).toMatchObject({
        source: { kind: "mailbox_draft", receiptId: syntheticReceiptId, draftVersion: 1 },
        householdId: syntheticHouseholdId,
        sectionId: syntheticSectionId,
        item: { title: "Corrected reviewed title", subtype: "Insurance", provider: "Corrected provider", costMinor: 12550, currency: "GBP", dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12, notes: "Reviewed notes" },
        attachmentIds: [syntheticAttachmentId],
      });
      expect((approvalBodies[0].item as Record<string, unknown>).reference).toBeUndefined();
      if (isMobile) expect(approvalBodies[0].action).toBe("attach_existing");
      else expect(approvalBodies[0].action).toBe("create_separate");
      await expect(review.getByRole("button", { name: "Retry approval" })).toBeVisible();
      await expect(review.getByLabel("Title")).toBeDisabled();
      await review.getByRole("button", { name: "Retry approval" }).click();
      await expect.poll(() => approvalBodies.length).toBe(2);
      expect(approvalBodies[1]).toEqual(approvalBodies[0]);
      await expect(page.getByText("No incoming documents waiting for review.", { exact: true })).toBeVisible();
    } finally {
      await households.sweep(page);
    }
  });
});
