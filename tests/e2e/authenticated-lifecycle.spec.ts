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

async function createManualHousehold(page: Page, isMobile: boolean, name: string) {
  const recoveryHeading = page.getByRole("heading", { name: "Where would you like to begin?" });
  const householdPicker = page.locator("button.household-picker");
  await expect(recoveryHeading.or(householdPicker).first()).toBeVisible({ timeout: 15_000 });
  if (await recoveryHeading.isVisible()) {
    await page.getByRole("button", { name: "Create a new household" }).click();
  } else {
    if (isMobile && !(await householdPicker.isVisible())) {
      await page.getByRole("button", { name: "Open navigation" }).click();
    }
    await householdPicker.click();
    await page.getByRole("button", { name: "Add a household" }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Set up your space" });
  await dialog.getByLabel("Household name").fill(name);
  await dialog.getByRole("button", { name: "Create household" }).click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
}

async function waitForSynced(page: Page) {
  await expect(page.locator(".sync-state")).toHaveText("Synced", { timeout: 15_000 });
}

test.describe("authenticated household lifecycle", () => {
  // This test intentionally mutates the one disposable acceptance database.
  // Retrying it would start from a different household state and hide the
  // original failure with a misleading first-sign-in assertion.
  test.describe.configure({ mode: "serial", retries: 0 });

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

  test("proves the authenticated manual item journey without a document", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The complete stateful journey is exercised on desktop; mobile has its own deterministic scenario below.");

    await signIn(page, administrator);
    const suffix = Date.now();
    await createManualHousehold(page, false, `Issue 40 desktop ${suffix}`);
    const title = `Manual item ${suffix}`;
    const updatedTitle = `${title} updated`;
    const inspectionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/item-document-inspection")) inspectionRequests.push(request.url());
    });

    await page.getByRole("button", { name: "Add item", exact: true }).first().click();
    let editor = page.getByRole("dialog", { name: "Add an item" });
    await editor.getByLabel("What do you want to keep track of?").fill(title);
    await editor.getByLabel("Type").fill("Insurance");
    await editor.getByLabel("Provider").fill("Orbit Cover");
    await editor.getByLabel("Reference").fill("ISSUE-40");
    await editor.getByLabel("Cost (GBP)").fill("125.00");
    await editor.getByLabel("Renewal date").fill("2030-12-20");
    await editor.getByLabel("Repeats").selectOption("12");
    await editor.getByRole("button", { name: "Add item", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`${title} added`);
    await waitForSynced(page);
    expect(inspectionRequests).toEqual([]);

    await page.reload();
    await expect(page.getByRole("button", { name: `Open ${title}` })).toBeVisible();
    await page.getByRole("button", { name: `Open ${title}` }).click();
    let detail = page.getByRole("dialog", { name: title });
    await expect(detail).toContainText("Reminders 30 days, 7 days beforehand");
    await detail.getByRole("button", { name: "Edit details" }).click();
    editor = page.getByRole("dialog", { name: "Edit item" });
    await editor.getByLabel("What do you want to keep track of?").fill(updatedTitle);
    await editor.getByLabel("Provider").fill("Updated Cover");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} updated`);
    await waitForSynced(page);

    await page.reload();
    await expect(page.getByRole("button", { name: `Open ${updatedTitle}` })).toBeVisible();
    await page.getByRole("button", { name: `Open ${updatedTitle}` }).click();
    detail = page.getByRole("dialog", { name: updatedTitle });
    await detail.getByRole("button", { name: "Complete renewal" }).click();
    await detail.getByLabel("Completed on").fill("2030-12-20");
    await detail.getByLabel("Next scheduled date").fill("2031-12-20");
    await detail.getByRole("button", { name: "Save completion" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} renewal completed`);
    await waitForSynced(page);

    await detail.getByRole("button", { name: "Reschedule" }).click();
    const reschedulePanel = detail.locator("form.detail-action-panel");
    await reschedulePanel.getByLabel("New due date").fill("2031-11-20");
    await reschedulePanel.getByRole("button", { name: "Reschedule", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} rescheduled`);
    await waitForSynced(page);

    await detail.getByRole("button", { name: "Snooze" }).click();
    const snoozePanel = detail.locator("form.detail-action-panel");
    await snoozePanel.getByLabel("Resume reminders").fill("2031-11-25");
    await snoozePanel.getByRole("button", { name: "Snooze", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Reminders snoozed until");
    await waitForSynced(page);

    await detail.getByRole("button", { name: "Cancel item" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} cancelled`);
    await waitForSynced(page);
    await page.getByRole("button", { name: /^Archive/ }).click();
    await page.getByRole("button", { name: `Open ${updatedTitle}` }).click();
    detail = page.getByRole("dialog", { name: updatedTitle });
    await detail.getByRole("button", { name: "Restore item" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} restored`);
    await waitForSynced(page);
    await detail.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} archived`);
    await waitForSynced(page);

    await page.getByRole("button", { name: `Open ${updatedTitle}` }).click();
    detail = page.getByRole("dialog", { name: updatedTitle });
    await expect(detail.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(detail).toContainText("Item added");
    await expect(detail).toContainText("Details updated");
    await expect(detail).toContainText("Renewal completed");
    await expect(detail).toContainText("Date rescheduled");
    await expect(detail).toContainText("Reminder snoozed");
    await expect(detail).toContainText("Item cancelled");
    await expect(detail).toContainText("Item restored");
    await expect(detail).toContainText("Item archived");

    const finalWorkspace = (await readWorkspace(page)).workspace as { households: Array<{ items: Array<Record<string, unknown>> }> };
    const finalItem = finalWorkspace.households.flatMap((household) => household.items).find((item) => item.title === updatedTitle);
    expect(finalItem).toMatchObject({ status: "archived", version: 8, dueDate: "2031-11-20", snoozedUntil: "2031-11-25" });
    expect(inspectionRequests).toEqual([]);
    await page.reload();
    await page.getByRole("button", { name: /^Archive/ }).click();
    await expect(page.getByRole("button", { name: `Open ${updatedTitle}` })).toBeVisible();
  });

  test("keeps mobile manual item entry keyboard-operable without document inspection", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(!isMobile, "This is the representative mobile keyboard scenario.");

    await signIn(page, administrator);
    const suffix = Date.now();
    await createManualHousehold(page, true, `Issue 40 mobile ${suffix}`);
    const title = `Mobile item ${suffix}`;
    const updatedTitle = `${title} edited`;
    const inspectionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/item-document-inspection")) inspectionRequests.push(request.url());
    });

    const addButton = page.locator("button.mobile-add");
    await expect(addButton).toBeVisible();
    await addButton.focus();
    await page.keyboard.press("Enter");
    const editor = page.getByRole("dialog", { name: "Add an item" });
    await editor.getByLabel("What do you want to keep track of?").fill(title);
    await editor.getByRole("button", { name: "No schedule" }).click();
    const submit = editor.getByRole("button", { name: "Add item", exact: true });
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText(`${title} added`);
    await waitForSynced(page);
    expect(inspectionRequests).toEqual([]);

    await page.getByRole("button", { name: `Open ${title}` }).click();
    await page.getByRole("dialog", { name: title }).getByRole("button", { name: "Edit details" }).click();
    const edit = page.getByRole("dialog", { name: "Edit item" });
    await edit.getByLabel("What do you want to keep track of?").fill(updatedTitle);
    const save = edit.getByRole("button", { name: "Save changes" });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} updated`);
    await waitForSynced(page);
    expect(inspectionRequests).toEqual([]);
    await page.reload();
    await expect(page.getByRole("button", { name: `Open ${updatedTitle}` })).toBeVisible();
  });
});
