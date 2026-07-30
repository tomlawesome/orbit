import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
}

async function seedLegacyWorkspaceCache(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("orbit-workspace", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("snapshots");
        request.result.createObjectStore("commands", { keyPath: "id", autoIncrement: true });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(["snapshots", "commands"], "readwrite");
        transaction.objectStore("snapshots").put(
          { households: [{ id: "legacy-private-household", name: "Legacy private household" }] },
          "user:legacy-preview-user",
        );
        transaction.objectStore("commands").add({
          userId: "legacy-preview-user",
          command: { type: "household.activate", householdId: "legacy-private-household" },
          createdAt: new Date().toISOString(),
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
}

async function legacyWorkspaceCacheExists(page: Page) {
  return page.evaluate(async () => (await indexedDB.databases()).some((database) => database.name === "orbit-workspace"));
}

async function activeHouseholdName(page: Page): Promise<string> {
  const response = await page.request.get("/api/workspace");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as {
    workspace: {
      activeHouseholdId: string | null;
      households: Array<{ id: string; name: string }>;
    };
  };
  const existing = payload.workspace.households.find((household) => household.id === payload.workspace.activeHouseholdId)
    ?? payload.workspace.households[0];
  if (existing) return existing.name;

  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBeTruthy();
  const { csrfToken } = await sessionResponse.json() as { csrfToken: string };
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const householdName = `Online workspace ${householdId.slice(0, 8)}`;
  const createResponse = await page.request.post("/api/workspace/commands", {
    headers: {
      Origin: new URL(page.url()).origin,
      "X-CSRF-Token": csrfToken,
    },
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
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
        activities: [],
        readNotificationIds: [],
        dismissedNotificationIds: [],
      },
    },
  });
  expect(createResponse.ok()).toBeTruthy();
  await page.reload();
  return householdName;
}

test.describe("online-only private workspace policy", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test("purges preview-build private storage at authenticated startup and before logout", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "One browser profile proves the storage boundary.");

    await page.goto("/");
    await seedLegacyWorkspaceCache(page);
    expect(await legacyWorkspaceCacheExists(page)).toBe(true);

    await page.getByRole("link", { name: "Sign in securely" }).click();
    await page.getByRole("link", { name: "Orbit Administrator" }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
    await expect.poll(() => legacyWorkspaceCacheExists(page)).toBe(false);

    const householdName = await activeHouseholdName(page);
    await seedLegacyWorkspaceCache(page);
    expect(await legacyWorkspaceCacheExists(page)).toBe(true);

    await page.getByRole("button", { name: "Open personalisation settings" }).click();
    await page.getByRole("button", { name: "Sign out securely" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
    await expect.poll(() => legacyWorkspaceCacheExists(page)).toBe(false);
    await expect(page.getByText(householdName, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Legacy private household", { exact: true })).toHaveCount(0);
  });

  test("does not retain a failed workspace command across reload", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The responsive command surface is covered by the authenticated UX slice.");

    await signIn(page);
    const originalName = await activeHouseholdName(page);
    const rejectedName = `${originalName} disconnected`;
    await page.route("**/api/workspace/commands", async (route) => {
      if (route.request().method() === "POST") {
        await route.abort("internetdisconnected");
        return;
      }
      await route.continue();
    });

    await page.getByRole("button", { name: "Open personalisation settings" }).click();
    await page.getByRole("tab", { name: "Household" }).click();
    const settings = page.getByRole("dialog", { name: "Personalise Orbit" });
    await settings.getByLabel("Household name").fill(rejectedName);
    await settings.getByRole("button", { name: "Save household" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "could not save" })).toBeVisible();
    expect(await legacyWorkspaceCacheExists(page)).toBe(false);

    await page.unroute("**/api/workspace/commands");
    await page.reload();
    await expect(page.getByText(originalName, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(rejectedName, { exact: true })).toHaveCount(0);
    expect(await legacyWorkspaceCacheExists(page)).toBe(false);
  });
});
