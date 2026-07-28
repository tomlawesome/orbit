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

async function createDisposableWorkspace(page: Page) {
  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBeTruthy();
  const session = await sessionResponse.json() as { csrfToken: string };
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const itemId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const householdName = `Issue 42 documents ${suffix}`;
  const itemTitle = `Disposable item ${suffix}`;

  const householdResponse = await page.request.post("/api/workspace/commands", {
    headers: { "X-CSRF-Token": session.csrfToken },
    data: {
      type: "household.create",
      household: {
        id: householdId,
        name: householdName,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Documents", icon: "home", accent: "sage", visible: true }],
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
    data: { type: "household.activate", householdId },
  });
  expect(activateResponse.ok()).toBeTruthy();

  const itemResponse = await page.request.post("/api/workspace/commands", {
    headers: { "X-CSRF-Token": session.csrfToken },
    data: {
      type: "item.upsert",
      householdId,
      item: {
        id: itemId,
        sectionId,
        title: itemTitle,
        currency: "GBP",
        status: "active",
        version: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  });
  expect(itemResponse.ok()).toBeTruthy();

  return { householdName, itemTitle };
}

test.describe("authenticated document lifecycle", () => {
  test.describe.configure({ retries: 0 });

  test("attaches, downloads, removes, restores, and downloads a synthetic document", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The stateful authenticated journey uses one isolated desktop identity.");

    await signIn(page, administrator);
    const { householdName, itemTitle } = await createDisposableWorkspace(page);
    await page.goto("/");
    await expect(page.getByText(householdName, { exact: true }).first()).toBeVisible();
    const itemCard = page.locator(".item-card").filter({ hasText: itemTitle });
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
  });
});
