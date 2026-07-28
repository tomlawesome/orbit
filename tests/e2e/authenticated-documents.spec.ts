import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const administrator = "Orbit Administrator";
const syntheticPdf = Buffer.from("%PDF-1.7\nissue 42 authenticated browser document\n");

async function signIn(page: Page, identity: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: identity }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
}

interface DisposableWorkspace {
  householdId: string;
  sectionId: string;
  itemId: string;
  householdName: string;
  itemTitle: string;
}

function newDisposableWorkspace(): DisposableWorkspace {
  const suffix = randomUUID().slice(0, 8);
  return {
    householdId: randomUUID(),
    sectionId: randomUUID(),
    itemId: randomUUID(),
    householdName: `Issue 42 documents ${suffix}`,
    itemTitle: `Disposable item ${suffix}`,
  };
}

async function createDisposableWorkspace(page: Page, workspace: DisposableWorkspace) {
  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBeTruthy();
  const session = await sessionResponse.json() as { csrfToken: string };

  const householdResponse = await page.request.post("/api/workspace/commands", {
    headers: { "X-CSRF-Token": session.csrfToken },
    data: {
      type: "household.create",
      household: {
        id: workspace.householdId,
        name: workspace.householdName,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: workspace.sectionId, name: "Documents", icon: "home", accent: "sage", visible: true }],
        items: [],
        activities: [],
        readNotificationIds: [],
        dismissedNotificationIds: [],
      },
    },
  });
  expect(householdResponse.ok()).toBeTruthy();

  const activateResponse = await page.request.post("/api/workspace/commands", {
    headers: { "X-CSRF-Token": session.csrfToken },
    data: { type: "household.activate", householdId: workspace.householdId },
  });
  expect(activateResponse.ok()).toBeTruthy();

  const itemResponse = await page.request.post("/api/workspace/commands", {
    headers: { "X-CSRF-Token": session.csrfToken },
    data: {
      type: "item.upsert",
      householdId: workspace.householdId,
      item: {
        id: workspace.itemId,
        sectionId: workspace.sectionId,
        title: workspace.itemTitle,
        currency: "GBP",
        status: "active",
        version: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  });
  expect(itemResponse.ok()).toBeTruthy();
}

async function cleanupDisposableWorkspace(page: Page, workspace: DisposableWorkspace) {
  const sessionResponse = await page.request.get("/api/auth/session");
  if (!sessionResponse.ok()) throw new Error(`Could not read the authenticated session for cleanup (${sessionResponse.status()})`);
  const session = await sessionResponse.json() as { csrfToken: string };
  const url = `/api/households/${workspace.householdId}/lifecycle`;
  const headers = { "X-CSRF-Token": session.csrfToken };
  const deletionResponse = await page.request.post(url, {
    headers,
    data: { action: "delete", confirmation: workspace.householdName },
  });
  if (deletionResponse.status() === 404) return;
  if (!deletionResponse.ok() && deletionResponse.status() !== 409) {
    throw new Error(`Could not schedule disposable household cleanup (${deletionResponse.status()})`);
  }

  const hardDeleteResponse = await page.request.post(url, {
    headers,
    data: { action: "hard_delete", confirmation: workspace.householdName },
  });
  if (hardDeleteResponse.status() === 404) return;
  if (!hardDeleteResponse.ok()) {
    throw new Error(`Could not permanently remove disposable household (${hardDeleteResponse.status()})`);
  }
}

test.describe("authenticated document lifecycle", () => {
  test.describe.configure({ retries: 0 });

  test("attaches, downloads, removes, restores, and downloads a synthetic document", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The stateful authenticated journey uses one isolated desktop identity.");

    await signIn(page, administrator);
    const workspace = newDisposableWorkspace();
    try {
      await createDisposableWorkspace(page, workspace);
      await page.goto("/");
      await expect(page.getByText(workspace.householdName, { exact: true }).first()).toBeVisible();
      const itemCard = page.locator(".item-card").filter({ hasText: workspace.itemTitle });
      await expect(itemCard.locator(".item-main")).toBeVisible();
      await itemCard.locator(".item-main").click();

      const documentName = "authenticated-browser-document.pdf";
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles({ name: documentName, mimeType: "application/pdf", buffer: syntheticPdf });

      const documentRow = page.getByRole("listitem").filter({ hasText: documentName });
      await expect(documentRow).toBeVisible();
      await expect(documentRow).toContainText("application/pdf");
      await expect(documentRow).toContainText(`${syntheticPdf.length} B`);

      const downloadResponsePromise = page.waitForResponse((response) => (
        response.url().includes("/api/documents/")
        && response.url().endsWith("/download")
        && response.request().method() === "GET"
      ));
      await documentRow.getByRole("link", { name: "Download" }).click();
      const downloadResponse = await downloadResponsePromise;
      expect(downloadResponse.status()).toBe(200);
      expect(await downloadResponse.body()).toEqual(syntheticPdf);

      await documentRow.getByRole("button", { name: "Delete" }).click();
      await expect(documentRow).toContainText("Scheduled for deletion");
      await expect(documentRow.getByRole("link", { name: "Download" })).toHaveCount(0);

      await documentRow.getByRole("button", { name: "Restore" }).click();
      await expect(documentRow.getByRole("link", { name: "Download" })).toBeVisible();

      const restoredResponsePromise = page.waitForResponse((response) => (
        response.url().includes("/api/documents/")
        && response.url().endsWith("/download")
        && response.request().method() === "GET"
      ));
      await documentRow.getByRole("link", { name: "Download" }).click();
      const restoredResponse = await restoredResponsePromise;
      expect(restoredResponse.status()).toBe(200);
      expect(await restoredResponse.body()).toEqual(syntheticPdf);
    } finally {
      await cleanupDisposableWorkspace(page, workspace);
    }
  });
});
