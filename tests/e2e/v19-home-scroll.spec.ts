import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { gotoCreate, settled } from "./support/keyboard";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

resetDatabaseBetweenSpecFiles();

/**
 * #1249: after adding an item, "← YOUR SKY" brought the owner back to a sky
 * that would not scroll down to the manifest (Firefox, desktop). Every way
 * back to home after a save is walked here, and each ends the same way: the
 * reader turns the wheel and the manifest arrives.
 */

const HOUSEHOLD = "Scroll Proving Ground";
const households = householdRegister();

test.skip(({ isMobile }) => isMobile, "the desk's sky and manifest; the pocket scrolls its own sheet");

async function seedHousehold(page: Page): Promise<{ id: string; name: string }> {
  return await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId,
          name: householdName,
          timezone: "Europe/London",
          currency: "GBP",
          memberCount: 1,
          canManage: true,
          onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status} ${await response.text()}`);
    return { id: householdId, name: householdName };
  }, HOUSEHOLD);
}

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));
}

/** Adds an item through the desk's create form; the save lands on /home. */
async function addItem(page: Page, name: string) {
  await gotoCreate(page);
  await page.locator("#f-name").fill(name);
  await page.locator('#types button[data-type="service"]').click();
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await page.locator("#f-date").fill(new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10));
  await page.locator(".btn-primary").click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator(".item", { hasText: name })).toBeVisible();
}

/** The owner's gesture: the wheel over the sky, until the manifest is in view. */
async function wheelToManifest(page: Page) {
  await settled(page);
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 1280) / 2, (viewport?.height ?? 800) / 2);
  const manifest = page.locator("#manifest-top");
  await expect(async () => {
    await page.mouse.wheel(0, 600);
    await expect(manifest).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

test("after a save, the sky scrolls down to the manifest", async ({ page }) => {
  await signIn(page);
  await addItem(page, "Scroll after save");
  await wheelToManifest(page);
});

test("after a save, the item's way back returns to a sky that scrolls", async ({ page }) => {
  await signIn(page);
  await addItem(page, "Scroll via item");
  await page.locator(".item", { hasText: "Scroll via item" }).click();
  await page.getByRole("link", { name: "manage this item →" }).click();
  await expect(page).toHaveURL(/\/item\/[0-9a-f-]{36}$/);
  await page.getByRole("link", { name: "← YOUR SKY" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await wheelToManifest(page);
});

test("after a save, the create page's way back returns to a sky that scrolls", async ({ page }) => {
  await signIn(page);
  await addItem(page, "Scroll via create");
  await gotoCreate(page);
  await page.getByRole("link", { name: "← YOUR SKY" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await wheelToManifest(page);
});
