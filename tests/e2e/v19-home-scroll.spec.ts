import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { gotoCreate, settled } from "./support/keyboard";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";

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
  await page.locator("#f-date").fill(householdDateFromToday(20));
  await page.locator(".btn-primary").click();
  await expect(page).toHaveURL(/\/home(\?item=[^&]+)?$/);
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

/* #1319 (owner-decisions §34): was "after a save, the item's way back
   returns to a sky that scrolls", which walked to the belt and took its
   "← YOUR SKY". The belt is gone: its address now answers with home and
   the item's drawer open, and the item's way back is putting that drawer
   away. Both are walked here, as a bookmark to the old address would. */
test("after a save, the item's old address and its drawer's way back return to a sky that scrolls", async ({ page }) => {
  await signIn(page);
  await addItem(page, "Scroll via item");
  /* the save lands with the new row already open (`/home?item=`) */
  const id = new URL(page.url()).searchParams.get("item");
  expect(id, "the save did not land on the new item's address").toBeTruthy();
  await page.goto(`/item/${id}`);
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${id}$`));
  const drawer = page.locator(`[id="${id}-view"]`);
  await expect(drawer).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
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
