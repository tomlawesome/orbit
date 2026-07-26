import { expect, test, type Page } from "@playwright/test";

const administrator = "Orbit Administrator";
const member = "Orbit Member";

async function signIn(page: Page, identity: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: identity }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
}

test.describe("authenticated household lifecycle", () => {
  test("a first sign-in creates no household until the user chooses one", async ({ page, request, browser, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The disposable identities are shared by the single acceptance stack.");

    await signIn(page, administrator);

    const workspaceBeforeCreation = await request.get("/api/workspace");
    expect(workspaceBeforeCreation.ok()).toBeTruthy();
    await expect(workspaceBeforeCreation.json()).resolves.toMatchObject({
      householdLanding: "choose",
      activeHouseholdId: null,
      households: [],
    });
    await expect(page.getByRole("heading", { name: "Where would you like to begin?" })).toBeVisible();

    await page.getByRole("button", { name: "Create a new household" }).click();
    await page.getByRole("dialog", { name: "Set up your space" }).getByLabel("Household name").fill("Acceptance household");
    await page.getByRole("button", { name: "Create household" }).click();
    await expect(page.getByText("Acceptance household", { exact: true }).first()).toBeVisible();

    const workspaceAfterCreation = await request.get("/api/workspace");
    const createdWorkspace = await workspaceAfterCreation.json() as { activeHouseholdId: string | null; households: Array<{ id: string; name: string }> };
    expect(createdWorkspace).toMatchObject({
      householdLanding: "active",
      households: [{ name: "Acceptance household" }],
    });

    const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const memberPage = await memberContext.newPage();
    try {
      await signIn(memberPage, member);
      await expect(memberPage.getByRole("heading", { name: "Where would you like to begin?" })).toBeVisible();

      await page.getByRole("button", { name: "Open personalisation settings" }).click();
      await page.getByRole("tab", { name: "Members" }).click();
      await expect(page.getByLabel("Registered user").locator("option", { hasText: member })).toHaveCount(1);
      await page.getByLabel("Registered user").selectOption({ label: member });
      await page.getByRole("button", { name: "Add member" }).click();
      await expect(page.getByRole("status")).toContainText("can now access this household");

      await memberPage.reload();
      await expect(memberPage.getByText("Acceptance household", { exact: true }).first()).toBeVisible();
      await memberPage.getByRole("button", { name: "Open personalisation settings" }).click();
      await expect(memberPage.getByRole("tab", { name: "Admin" })).toHaveCount(0);
      await expect(memberPage.getByRole("tab", { name: "Household" })).toHaveCount(0);

      await page.getByRole("tab", { name: "Household" }).click();
      await page.getByLabel(/Type “Acceptance household” to remove this household/).fill("Acceptance household");
      await page.getByRole("button", { name: "Remove household" }).click();
      await expect(page.getByRole("heading", { name: "Where would you like to begin?" })).toBeVisible();
      await memberPage.reload();
      await expect(memberPage.getByRole("heading", { name: "Where would you like to begin?" })).toBeVisible();
      await expect(memberPage.getByText("Acceptance household", { exact: true })).toHaveCount(0);
    } finally {
      await memberContext.close();
    }

    // The first authenticated user is the instance administrator and can use
    // the typed permanent-delete path while a household is recoverable.
    await expect(page.getByRole("button", { name: "Permanently delete" })).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Acceptance household", { exact: true }).first()).toBeVisible();

    const restoredWorkspace = await request.get("/api/workspace");
    await expect(restoredWorkspace.json()).resolves.toMatchObject({
      householdLanding: "active",
      activeHouseholdId: createdWorkspace.activeHouseholdId,
      households: [{ name: "Acceptance household" }],
    });
  });
});
