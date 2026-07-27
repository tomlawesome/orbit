import { expect, test, type Page } from "@playwright/test";

const administrator = "Orbit Administrator";
const member = "Orbit Member";

async function signIn(page: Page, identity: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: identity }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
}

async function readWorkspace(page: Page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForLoadState("domcontentloaded");
      return await page.evaluate(async () => {
        const response = await fetch("/api/workspace", { credentials: "same-origin" });
        const payload = (await response.json()) as { workspace?: unknown };
        return { ok: response.ok, workspace: payload.workspace ?? payload };
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Execution context was destroyed") || attempt === 2) throw error;
    }
  }
  throw new Error("Workspace read did not run");
}

test.describe("authenticated household lifecycle", () => {
  // This test intentionally mutates the one disposable acceptance database.
  // Retrying it would start from a different household state and hide the
  // original failure with a misleading first-sign-in assertion.
  test.describe.configure({ retries: 0 });

  test("a first sign-in creates no household until the user chooses one", async ({ page, browser, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The disposable identities are shared by the single acceptance stack.");

    await signIn(page, administrator);

    const workspaceBeforeCreation = await readWorkspace(page);
    expect(workspaceBeforeCreation.ok).toBeTruthy();
    expect(workspaceBeforeCreation.workspace).toMatchObject({
      householdLanding: "choose",
      activeHouseholdId: null,
      households: [],
    });
    await expect(page.getByRole("heading", { name: "Where would you like to begin?" })).toBeVisible();

    await page.getByRole("button", { name: "Create a new household" }).click();
    await page.getByRole("dialog", { name: "Set up your space" }).getByLabel("Household name").fill("Acceptance household");
    await page.getByRole("button", { name: "Create household" }).click();
    await expect(page.getByText("Acceptance household", { exact: true }).first()).toBeVisible();

    const workspaceAfterCreation = await readWorkspace(page);
    const createdWorkspace = workspaceAfterCreation.workspace as { activeHouseholdId: string | null; households: Array<{ id: string; name: string }> };
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
      await expect(page.getByText(`${member} can now access this household.`, { exact: true })).toBeVisible();

      await memberPage.reload();
      await expect(memberPage.getByText("Acceptance household", { exact: true }).first()).toBeVisible();
      await memberPage.getByRole("button", { name: "Open personalisation settings" }).click();
      await expect(memberPage.getByRole("tab", { name: "Admin" })).toHaveCount(0);
      await expect(memberPage.getByRole("tab", { name: "Household" })).toHaveCount(0);

      await page.getByRole("tab", { name: "Admin" }).click();
      await expect(page.getByRole("heading", { name: "Instance administrators" })).toBeVisible();
      const memberAdminRow = page.locator(".admin-list article").filter({ hasText: member });
      await expect(memberAdminRow).toHaveCount(1);
      page.once("dialog", (dialog) => dialog.accept());
      await memberAdminRow.getByRole("button", { name: "Disable account" }).click();
      await expect(page.getByText(`${member}'s account is now disabled.`, { exact: true })).toBeVisible();

      await memberPage.reload();
      await expect(memberPage.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
      await expect(memberPage.getByText("Your household information is private")).toBeVisible();
      await expect(memberPage.getByText("Acceptance household", { exact: true })).toHaveCount(0);
      await memberPage.getByRole("link", { name: "Sign in securely" }).click();
      await memberPage.getByRole("link", { name: member }).click();
      await expect(memberPage).toHaveURL(/\/auth\/error\?code=account_disabled/);
      await expect(memberPage.getByText("This Orbit account has been disabled by an administrator.")).toBeVisible();

      await page.getByRole("tab", { name: "Admin" }).click();
      const disabledMemberRow = page.locator(".admin-list article").filter({ hasText: member });
      await expect(disabledMemberRow.getByRole("button", { name: "Enable account" })).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await disabledMemberRow.getByRole("button", { name: "Enable account" }).click();
      await expect(page.getByText(`${member}'s account is now enabled.`, { exact: true })).toBeVisible();

      await memberPage.goto("/");
      await expect(memberPage.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
      await expect(memberPage.getByText("Acceptance household", { exact: true })).toHaveCount(0);
      await signIn(memberPage, member);
      await expect(memberPage.getByText("Acceptance household", { exact: true }).first()).toBeVisible();

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

    await page.getByRole("button", { name: "Create a new household" }).click();
    await page.getByRole("dialog", { name: "Set up your space" }).getByLabel("Household name").fill("Acceptance household");
    await page.getByRole("button", { name: "Create household" }).click();
    await expect(page.getByRole("heading", { name: "Where would you like to begin?" })).toBeVisible();

    // The first authenticated user is the instance administrator and can use
    // the typed permanent-delete path while a household is recoverable.
    await expect(page.getByRole("button", { name: "Permanently delete" })).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    // Restore reloads the browser asynchronously. The recovery list contains
    // the household name before that reload, so wait for the server's durable
    // active-household state rather than merely seeing stale page text.
    await expect.poll(async () => {
      const workspace = (await readWorkspace(page)).workspace as { activeHouseholdId?: string | null };
      return workspace.activeHouseholdId;
    }, { timeout: 10_000 }).toBe(createdWorkspace.activeHouseholdId);

    const restoredWorkspace = await readWorkspace(page);
    expect(restoredWorkspace.workspace).toMatchObject({
      householdLanding: "active",
      activeHouseholdId: createdWorkspace.activeHouseholdId,
      households: [{ name: "Acceptance household" }],
    });
  });
});
