import { expect, test, type Page } from "@playwright/test";

const administrator = "Orbit Administrator";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: administrator }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
}

async function ensureSyntheticHousehold(page: Page) {
  const recoveryHeading = page.getByRole("heading", { name: "Where would you like to begin?" });
  const desktopSettings = page.getByRole("button", { name: "Open personalisation settings" });
  const mobileNavigation = page.getByRole("button", { name: "Open navigation" });
  await expect(page.locator(".sync-state")).toHaveText("Synced", { timeout: 15_000 });
  await expect.poll(async () => {
    const [recoveryVisible, desktopSettingsVisible, mobileNavigationVisible] = await Promise.all([
      recoveryHeading.isVisible(),
      desktopSettings.isVisible(),
      mobileNavigation.isVisible(),
    ]);
    return recoveryVisible || desktopSettingsVisible || mobileNavigationVisible;
  }, { timeout: 15_000 }).toBe(true);
  if (!await recoveryHeading.isVisible()) return;

  const projectName = test.info().project.name.replace(/[^a-z0-9]+/gi, "-");
  const householdName = `Operations ${projectName}`;
  await page.getByRole("button", { name: "Create a new household" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up your space" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel("Household name").fill(householdName);
  await dialog.getByRole("button", { name: "Create household" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => {
    const [desktopSettingsVisible, mobileNavigationVisible] = await Promise.all([
      desktopSettings.isVisible(),
      mobileNavigation.isVisible(),
    ]);
    return desktopSettingsVisible || mobileNavigationVisible;
  }, { timeout: 15_000 }).toBe(true);
}

function operationsPayload(audit: Array<Record<string, unknown>>, nextCursor: string | null, deliveries: Array<Record<string, unknown>> = []) {
  return {
    operations: {
      notificationWorker: { started: true, running: false, lastSuccessAt: new Date().toISOString(), lastErrorAt: null, lastErrorCode: null },
      providers: { smtp: "configured", push: "configured" },
      mailboxIngestion: {
        enabled: true,
        configured: true,
        status: "provider_unavailable",
        smtp: "provider_unavailable",
        imap: "available",
        worker: { started: true, running: false, lastSuccessAt: null, lastErrorAt: new Date().toISOString(), lastErrorCode: "provider_unavailable" },
      },
      deliveryCounts: { failed: 1 },
      documentJobCounts: { failed: 1 },
      mailboxNotifications: { status: "exhausted" },
      deliveries,
      documentJobs: [],
      audit,
      nextCursor,
    },
  };
}

test.describe("administrator operations evidence", () => {
  test("shows degraded safe diagnostics and loads older audit history on desktop and mobile", async ({ page }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");

    const now = new Date().toISOString();
    let correctionAccepted = false;
    const firstAudit = Array.from({ length: 25 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      actorName: "Orbit Administrator",
      householdName: "Synthetic household",
      actionLabel: "Household ownership transferred",
      createdAt: now,
    }));
    const olderAudit = [{
      id: "00000000-0000-4000-8000-000000000026",
      actorName: "Orbit Administrator",
      householdName: "Synthetic household",
      actionLabel: "Account disabled",
      createdAt: now,
    }];

    await page.route("**/api/admin/users", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users: [{ id: "admin", displayName: administrator, email: "admin@example.invalid", isInstanceAdmin: true, disabledAt: null }] }) });
    });
    await page.route("**/api/admin/documents/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ health: {
          overall: "degraded",
          encryption: { status: "ready" },
          storage: { status: "ready" },
          scanner: { status: "disabled", mode: "disabled" },
          quota: { usedBytes: 128, limitBytes: 1024 },
          worker: { started: false, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: "synthetic-secret-must-not-render", lastReconciliationAt: null },
        } }),
      });
    });
    await page.route("**/api/admin/operations**", async (route) => {
      const url = new URL(route.request().url());
      const payload = url.searchParams.has("auditCursor")
        ? operationsPayload(olderAudit, null)
        : operationsPayload(firstAudit, "synthetic-cursor", correctionAccepted ? [] : [{
          id: "00000000-0000-4000-8000-000000000099",
          channel: "email",
          status: "failed",
          attempts: 5,
          scheduledFor: now,
          lastErrorCode: "smtp_unavailable",
          updatedAt: now,
        }]);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.route("**/api/admin/operations/deliveries/*", async (route) => {
      if (route.request().method() === "POST") {
        correctionAccepted = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.continue();
    });

    await signIn(page);
    await ensureSyntheticHousehold(page);
    const mobileNavigation = page.getByRole("button", { name: "Open navigation" });
    if (await mobileNavigation.isVisible()) {
      await mobileNavigation.click();
      await page.getByRole("button", { name: "Personalise", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Open personalisation settings" }).click();
    }
    const settings = page.getByRole("dialog", { name: "Personalise Orbit" });
    await expect(settings).toBeVisible();
    await settings.getByRole("tab", { name: "Admin" }).click();
    await expect(settings.getByRole("heading", { name: "Operations" })).toBeVisible();
    await expect(settings.getByText("provider_unavailable", { exact: true })).toBeVisible();
    await expect(settings.getByText("Household ownership transferred", { exact: true })).toBeVisible();
    await expect(settings.getByText("synthetic-secret-must-not-render", { exact: true })).toHaveCount(0);
    await expect(settings.getByText("synthetic-key-id", { exact: true })).toHaveCount(0);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("duplicate");
      await dialog.accept();
    });
    await settings.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Job queued for retry.", { exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("synthetic-secret-must-not-render");
    await expect(page.locator("body")).not.toContainText("synthetic-key-id");

    await settings.getByRole("button", { name: "Load older history" }).click();
    await expect(settings.getByText("Account disabled", { exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Load older history" })).toHaveCount(0);
  });
});
