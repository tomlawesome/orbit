import { expect, test, type Dialog, type Page } from "@playwright/test";

const administrator = "Orbit Administrator";
const member = "Orbit Member";

async function signIn(page: Page, identity: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: identity }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
}

async function clickWithConfirmation(page: Page, click: () => Promise<void>) {
  let accepted: Promise<void> | undefined;
  const handleDialog = (dialog: Dialog) => {
    accepted = dialog.accept();
  };
  page.once("dialog", handleDialog);
  try {
    await click();
    if (!accepted) throw new Error("Expected a confirmation dialog for the authenticated action");
    await accepted;
  } finally {
    page.off("dialog", handleDialog);
  }
}

type AuthenticatedBrowserSession = { userId: string; displayName: string; csrfToken: string };

async function readAuthenticatedSession(page: Page, label: string): Promise<AuthenticatedBrowserSession> {
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json() as {
      authenticated?: unknown;
      user?: { id?: unknown; displayName?: unknown };
      csrfToken?: unknown;
    };
    return {
      status: response.status,
      authenticated: payload.authenticated === true,
      userId: typeof payload.user?.id === "string" ? payload.user.id : null,
      displayName: typeof payload.user?.displayName === "string" ? payload.user.displayName : null,
      csrfToken: typeof payload.csrfToken === "string" && payload.csrfToken.length > 0 ? payload.csrfToken : null,
    };
  });
  if (session.status !== 200 || !session.authenticated || !session.userId || !session.displayName || !session.csrfToken) {
    throw new Error(`${label} session response was not an authenticated session (status ${session.status})`);
  }
  return { userId: session.userId, displayName: session.displayName, csrfToken: session.csrfToken };
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

type DurableWorkspaceItem = { id: string; title: string };
type DurableWorkspaceHousehold = { id: string; name: string; items: DurableWorkspaceItem[] };
type DurableWorkspace = { activeHouseholdId: string | null; households: DurableWorkspaceHousehold[] };

function isDurableWorkspace(workspace: unknown): workspace is DurableWorkspace {
  if (!workspace || typeof workspace !== "object") return false;
  const candidate = workspace as Record<string, unknown>;
  if ((candidate.activeHouseholdId !== null && typeof candidate.activeHouseholdId !== "string") || !Array.isArray(candidate.households)) return false;
  return candidate.households.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const household = entry as Record<string, unknown>;
    if (typeof household.id !== "string" || typeof household.name !== "string" || !Array.isArray(household.items)) return false;
    return household.items.every((item) => {
      if (!item || typeof item !== "object") return false;
      const candidateItem = item as Record<string, unknown>;
      return typeof candidateItem.id === "string" && typeof candidateItem.title === "string";
    });
  });
}

async function waitForWorkspace(
  page: Page,
  condition: (workspace: DurableWorkspace) => boolean,
  message: string,
): Promise<DurableWorkspace> {
  let workspace: DurableWorkspace | undefined;
  await expect.poll(async () => {
    const response = await readWorkspace(page);
    if (!response.ok || !isDurableWorkspace(response.workspace)) return false;
    workspace = response.workspace;
    return condition(workspace);
  }, { timeout: 15_000, message }).toBe(true);
  if (!workspace) throw new Error(`Workspace condition completed without a durable response: ${message}`);
  return workspace;
}

async function waitForDurableWorkspace(page: Page): Promise<DurableWorkspace> {
  return waitForWorkspace(page, () => true, "Expected a durable authenticated workspace response");
}

async function waitForActiveHousehold(page: Page, name: string): Promise<DurableWorkspace> {
  return waitForWorkspace(
    page,
    (workspace) => workspace.households.some((household) => household.id === workspace.activeHouseholdId && household.name === name),
    `Expected household "${name}" to become the durable active household`,
  );
}

async function openMobileNavigationIfNeeded(page: Page) {
  const closeNavigation = page.getByRole("button", { name: "Close navigation" });
  if (await closeNavigation.isVisible()) return;
  const openNavigation = page.getByRole("button", { name: "Open navigation" });
  if (await openNavigation.isVisible()) await openNavigation.click();
}

async function selectHouseholdByName(page: Page, name: string): Promise<DurableWorkspace> {
  const workspace = await waitForDurableWorkspace(page);
  const target = workspace.households.find((household) => household.name === name);
  if (!target) throw new Error(`Expected household "${name}" to be available for selection`);

  await openMobileNavigationIfNeeded(page);
  const householdPicker = page.locator("button.household-picker");
  await expect(householdPicker, `Expected the household picker before selecting "${name}"`).toBeVisible({ timeout: 15_000 });
  await householdPicker.click();
  const householdMenu = page.getByRole("menu");
  await expect(householdMenu).toBeVisible({ timeout: 15_000 });
  const targetItem = householdMenu.getByRole("menuitem").filter({ hasText: name });
  await expect(targetItem, `Expected exactly one household menu item for "${name}"`).toHaveCount(1, { timeout: 15_000 });
  await targetItem.click();
  return waitForActiveHousehold(page, name);
}

async function waitForActiveHouseholdItem(page: Page, title: string): Promise<DurableWorkspace> {
  return waitForWorkspace(
    page,
    (workspace) => workspace.households.some((household) => household.id === workspace.activeHouseholdId && household.items.some((item) => item.title === title)),
    `Expected active household to durably contain item "${title}"`,
  );
}

async function openItemRow(page: Page, title: string) {
  const row = page.locator("article.item-card").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
  await expect(row, `Expected exactly one item-list row for "${title}"`).toHaveCount(1, { timeout: 15_000 });
  const openButton = row.getByRole("button", { name: `Open ${title}`, exact: true });
  await expect(openButton, `Expected the scoped open action for "${title}"`).toBeVisible({ timeout: 15_000 });
  await openButton.click();
}

async function reopenItemFromList(page: Page, title: string, list: "home" | "archive") {
  await page.reload();
  await waitForActiveHouseholdItem(page, title);
  const listButton = list === "archive"
    ? page.getByRole("button", { name: /^Archive(?:\s|$)/ })
    : page.getByRole("button", { name: /^Home(?:\s|$)/ });
  await expect(listButton, `Expected the ${list} item list to be available`).toBeVisible({ timeout: 15_000 });
  await listButton.click();
  await openItemRow(page, title);
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail, `Expected reopened details for "${title}"`).toBeVisible({ timeout: 15_000 });
  return detail;
}

async function createManualHousehold(page: Page, isMobile: boolean, name: string) {
  const recoveryHeading = page.getByRole("heading", { name: "Where would you like to begin?" });
  const householdPicker = page.locator("button.household-picker");
  const workspace = await waitForDurableWorkspace(page);
  if (workspace.activeHouseholdId && workspace.households.length > 0) {
    if (isMobile) {
      const navigation = page.getByRole("button", { name: "Open navigation" });
      await expect(navigation).toBeVisible({ timeout: 15_000 });
      await navigation.click();
    }
    await expect(householdPicker).toBeVisible({ timeout: 15_000 });
    await householdPicker.click();
    const addHousehold = page.getByRole("button", { name: "Add a household" });
    await expect(addHousehold).toBeVisible({ timeout: 15_000 });
    await addHousehold.click();
  } else {
    await expect(recoveryHeading).toBeVisible({ timeout: 15_000 });
    const createHousehold = page.getByRole("button", { name: "Create a new household" });
    await expect(createHousehold).toBeVisible({ timeout: 15_000 });
    await createHousehold.click();
  }
  const dialog = page.getByRole("dialog", { name: "Set up your space" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel("Household name").fill(name);
  await dialog.getByRole("button", { name: "Create household" }).click();
  await waitForActiveHousehold(page, name);
  await page.reload();
  await waitForActiveHousehold(page, name);
  await expect(page.getByPlaceholder(`Search ${name.toLowerCase()}…`)).toBeVisible();
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
    await memberPage.reload();
    await waitForActiveHousehold(memberPage, "Acceptance household");
    await expect(memberPage.getByText("Acceptance household", { exact: true }).first()).toBeVisible();
  } finally {
    await memberContext.close();
  }
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
    await waitForActiveHouseholdItem(page, title);
    await waitForSynced(page);
    expect(inspectionRequests).toEqual([]);

    await page.reload();
    await waitForActiveHouseholdItem(page, title);
    await openItemRow(page, title);
    let detail = page.getByRole("dialog", { name: title });
    await expect(detail).toContainText("Reminders 30 days, 7 days beforehand");
    await detail.getByRole("button", { name: "Edit details" }).click();
    editor = page.getByRole("dialog", { name: "Edit item" });
    await editor.getByLabel("What do you want to keep track of?").fill(updatedTitle);
    await editor.getByLabel("Provider").fill("Updated Cover");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} updated`);
    await waitForSynced(page);
    await waitForActiveHouseholdItem(page, updatedTitle);

    detail = await reopenItemFromList(page, updatedTitle, "home");
    await detail.getByRole("button", { name: "Complete renewal" }).click();
    await detail.getByLabel("Completed on").fill("2030-12-20");
    await detail.getByLabel("Next scheduled date").fill("2031-12-20");
    await detail.getByRole("button", { name: "Save completion" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} renewal completed`);
    await waitForSynced(page);
    detail = await reopenItemFromList(page, updatedTitle, "home");

    await detail.getByRole("button", { name: "Reschedule" }).click();
    const reschedulePanel = detail.locator("form.detail-action-panel");
    await reschedulePanel.getByLabel("New due date").fill("2031-11-20");
    await reschedulePanel.getByRole("button", { name: "Reschedule", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} rescheduled`);
    await waitForSynced(page);
    detail = await reopenItemFromList(page, updatedTitle, "home");

    await detail.getByRole("button", { name: "Snooze" }).click();
    const snoozePanel = detail.locator("form.detail-action-panel");
    await snoozePanel.getByLabel("Resume reminders").fill("2031-11-25");
    await snoozePanel.getByRole("button", { name: "Snooze", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Reminders snoozed until");
    await waitForSynced(page);
    detail = await reopenItemFromList(page, updatedTitle, "home");

    await detail.getByRole("button", { name: "Cancel item" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} cancelled`);
    await waitForSynced(page);
    detail = await reopenItemFromList(page, updatedTitle, "archive");
    await detail.getByRole("button", { name: "Restore item" }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} restored`);
    await waitForSynced(page);
    detail = await reopenItemFromList(page, updatedTitle, "home");
    await detail.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`${updatedTitle} archived`);
    await waitForSynced(page);

    detail = await reopenItemFromList(page, updatedTitle, "archive");
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
    await expect(page.locator("article.item-card").filter({ has: page.getByRole("heading", { name: updatedTitle, exact: true }) })).toHaveCount(1, { timeout: 15_000 });
  });

  test("proves member leave, owner/admin removal and ownership transfer journeys", async ({ page, browser, isMobile }, testInfo) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");

    await signIn(page, administrator);
    // Desktop and mobile projects share the disposable OIDC identities and
    // database, so give each project a distinct durable household scenario.
    const projectPartition = testInfo.project.name.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").toLowerCase();
    const householdName = `Issue 94 membership ${projectPartition} ${Date.now()}`;
    await createManualHousehold(page, isMobile, householdName);
    const createdWorkspace = await waitForActiveHousehold(page, householdName);
    const householdId = createdWorkspace.activeHouseholdId;
    if (!householdId) throw new Error(`Expected household "${householdName}" to have a durable id`);
    const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const memberPage = await memberContext.newPage();
    try {
      await signIn(memberPage, member);
      const memberSession = await readAuthenticatedSession(memberPage, "Member");

      const openMembers = async (targetPage: Page) => {
        const personalisation = targetPage.getByRole("dialog", { name: "Personalise Orbit", exact: true });
        if (!(await personalisation.isVisible())) {
          const openNavigation = targetPage.getByRole("button", { name: "Open navigation" });
          if (await openNavigation.isVisible()) {
            await openMobileNavigationIfNeeded(targetPage);
            await targetPage.getByRole("button", { name: "Personalise", exact: true }).click();
          } else {
            await targetPage.getByRole("button", { name: "Open personalisation settings" }).click();
          }
        }
        await expect(personalisation).toBeVisible({ timeout: 15_000 });
        await personalisation.getByRole("tab", { name: "Members" }).click();
      };
      const addMember = async () => {
        const administratorSession = await readAuthenticatedSession(page, "Administrator");
        const setupResponse = await page.evaluate(async ({ csrfToken, householdId, userId }) => {
          const response = await fetch(`/api/households/${householdId}/members`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
            body: JSON.stringify({ userId }),
          });
          const payload = await response.json() as {
            members?: unknown;
            error?: { code?: unknown };
          };
          const members = Array.isArray(payload.members)
            ? payload.members.flatMap((entry) => {
              if (!entry || typeof entry !== "object") return [];
              const candidate = entry as { id?: unknown; displayName?: unknown };
              return typeof candidate.id === "string" && typeof candidate.displayName === "string"
                ? [{ id: candidate.id, displayName: candidate.displayName }]
                : [];
            })
            : null;
          return {
            status: response.status,
            ok: response.ok,
            members,
            errorCode: payload.error && typeof payload.error.code === "string" ? payload.error.code : null,
          };
        }, { csrfToken: administratorSession.csrfToken, householdId, userId: memberSession.userId });
        if (!setupResponse.ok || setupResponse.status !== 200) {
          const errorDetail = setupResponse.errorCode ? `, error ${setupResponse.errorCode}` : "";
          throw new Error(`Membership setup failed for household "${householdName}" with status ${setupResponse.status}${errorDetail}`);
        }
        if (!setupResponse.members?.some((entry) => entry.id === memberSession.userId && entry.displayName === memberSession.displayName)) {
          throw new Error("Membership setup response did not contain the expected member");
        }
        await page.reload();
        await selectHouseholdByName(page, householdName);
        await openMembers(page);
        const memberRow = page.locator(".member-list article").filter({
          has: page.getByText(memberSession.displayName, { exact: true }),
        });
        await expect(memberRow, "Expected the exact setup member row before continuing").toHaveCount(1, { timeout: 15_000 });
      };
      const waitForMemberHousehold = async () => {
        await memberPage.reload();
        const selectedWorkspace = await selectHouseholdByName(memberPage, householdName);
        expect(selectedWorkspace.households.some((household) => household.id === selectedWorkspace.activeHouseholdId && household.name === householdName)).toBe(true);
      };
      const expectMemberRemoved = async () => {
        await memberPage.reload();
        const removedWorkspace = await waitForWorkspace(
          memberPage,
          (workspace) => !workspace.households.some((household) => household.id === householdId || household.name === householdName),
          `Expected member access to household "${householdName}" to be removed`,
        );
        expect(removedWorkspace.activeHouseholdId).not.toBe(householdId);
        expect(removedWorkspace.households).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: householdId, name: householdName }),
        ]));
        const inaccessible = await memberPage.evaluate(async (id) => {
          const response = await fetch(`/api/households/${id}/members`, { credentials: "same-origin", cache: "no-store" });
          return { status: response.status, body: await response.json() };
        }, householdId);
        expect(inaccessible).toEqual({
          status: 404,
          body: { error: { code: "household_not_found", message: "That household is not available" } },
        });
      };

      await addMember();
      await waitForMemberHousehold();
      await openMembers(memberPage);
      const leaveRow = memberPage.locator(".member-list article").filter({ hasText: member });
      await expect(leaveRow.getByRole("button", { name: "Leave household" })).toBeVisible();
      await clickWithConfirmation(memberPage, () => leaveRow.getByRole("button", { name: "Leave household" }).click());
      await expectMemberRemoved();

      await addMember();
      await waitForMemberHousehold();
      await openMembers(page);
      const ownerRemovalRow = page.locator(".member-list article").filter({ hasText: member });
      await ownerRemovalRow.getByRole("button", { name: "Remove" }).click();
      await expect(page.getByRole("status")).toContainText(`${member} was removed from this household.`);
      await expectMemberRemoved();

      await addMember();
      await waitForMemberHousehold();
      await openMembers(page);
      const transferRow = page.locator(".member-list article").filter({ hasText: member });
      await clickWithConfirmation(page, () => transferRow.getByRole("button", { name: "Make owner" }).click());
      await expect(page.getByRole("status")).toContainText(`${member} is now the household owner.`);
      await waitForActiveHousehold(page, householdName);
      await waitForMemberHousehold();
      await openMembers(memberPage);
      await expect(memberPage.getByText("Household owner", { exact: true })).toBeVisible();
      await expect(memberPage.getByRole("button", { name: "Add member" })).toBeVisible();
    } finally {
      await memberContext.close();
    }
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
    await waitForActiveHouseholdItem(page, title);
    await waitForSynced(page);
    expect(inspectionRequests).toEqual([]);

    await page.reload();
    await waitForActiveHouseholdItem(page, title);
    await openItemRow(page, title);
    await page.getByRole("dialog", { name: title }).getByRole("button", { name: "Edit details" }).click();
    const edit = page.getByRole("dialog", { name: "Edit item" });
    await edit.getByLabel("What do you want to keep track of?").fill(updatedTitle);
    const save = edit.getByRole("button", { name: "Save changes" });
    await save.focus();
    await page.keyboard.press("Enter");
    await waitForActiveHouseholdItem(page, updatedTitle);
    await waitForSynced(page);
    expect(inspectionRequests).toEqual([]);
    await page.reload();
    await openItemRow(page, updatedTitle);
  });
});
