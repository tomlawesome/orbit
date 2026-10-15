import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

resetDatabaseBetweenSpecFiles();

/**
 * WEB6 (#1316): another household's name is drawn in the home sky as text,
 * never as markup. The household is named with an image tag whose onerror
 * would set window.__xss; none of it may become an element or run, on the
 * desk sky or in the phone's "Other skies" list.
 */

const NAME = "<img src=x onerror=window.__xss=1>";
const households = householdRegister();
let seeded = false;

async function signInAs(page: Page, account: string) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

async function createHousehold(page: Page, name: string) {
  const created = await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status}`);
    return { id: householdId, name: householdName };
  }, name);
  households.track(created);
  seeded = true;
  return created;
}

/* The payload household first, a plain one second: the most recently created
   household is the active one, so the payload one is drawn as another sky. */
async function arriveWithPayloadSky(page: Page) {
  await signInAs(page, workerAccount("member"));
  await createHousehold(page, NAME);
  await createHousehold(page, `Plain House ${Date.now()}`);
  await page.goto("/home");
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signInAs(page, workerAccount("administrator"));
    await ensureWorkerAdministrator(page);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("desk: the name is label text in the sky, not an element", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the desk dialect; the pocket has its own check below");
  await arriveWithPayloadSky(page);

  await expect(page.locator(".minisys", { hasText: NAME.toUpperCase() })).toBeVisible();
  await expect(page.locator("#hero img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
});

test("phone: the name is listed as text under other skies", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "the pocket dialect; the desk has its own check above");
  await arriveWithPayloadSky(page);

  await expect(page.getByRole("region", { name: "Other skies" })).toContainText(NAME);
  await expect(page.locator("img[src='x']")).toHaveCount(0);
});
