import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { signInAsWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * Administration is for the instance administrator (#1440). An ordinary member
 * is not offered it in the account menu (the desk's card or the phone's
 * hatch), is not served the page (404, before any render), and is refused the
 * instance-wide reads behind it (403). The administrator keeps all of it.
 * Run once per Playwright project (desktop-chromium, mobile-chromium).
 */

/** The account menu this width draws: the desk's card, or the pocket's hatch. */
async function openMenu(page: Page, phone: boolean) {
  if (!phone) {
    await page.locator("button.orb").click();
    return page.locator("#account");
  }
  await page.locator("button.porb").click();
  const hatch = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(hatch).toHaveClass(/open/);
  return hatch;
}

async function signInAs(page: Page, account: string) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

test("an ordinary member is not offered Administration, is refused the page and its reads", async ({ page, browser, isMobile }) => {
  test.setTimeout(120_000);
  await claimInstanceAsAdministrator(browser);
  await signInAs(page, workerAccount("member"));

  await page.goto("/settings");
  const menu = await openMenu(page, isMobile);
  /* The menu is open and drawn (About is every member's), then the absence means something. */
  await expect(menu.getByRole("link", { name: "About" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Administration" })).toHaveCount(0);

  const response = await page.goto("/administration");
  expect(response?.status()).toBe(404);
  await expect(page).not.toHaveTitle("Orbit — administration");
  await expect(page.getByRole("heading", { level: 1, name: "Administration" })).toHaveCount(0);
  await expect(page.getByText("collection domain")).toHaveCount(0);

  const mailbox = await page.request.get("/api/admin/mailbox");
  expect(mailbox.status()).toBe(403);
});

test("the instance administrator is offered Administration and the page renders", async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  await signInAsWorkerAdministrator(page, "/settings");
  await settleArrival(page);

  await page.goto("/settings");
  const menu = await openMenu(page, isMobile);
  const link = menu.getByRole("link", { name: "Administration" });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/\/administration$/);
  await expect(page).toHaveTitle("Orbit — administration");
  await expect(page.getByRole("heading", { level: 1, name: "Administration" })).toBeVisible();
});

/* #1440: home draws its own account menu (the desk's #account card, written
   in the page rather than by Chrome), so it is checked as its own screen. */
test("home does not offer an ordinary member Administration in the account menu", async ({ page, browser, isMobile }) => {
  test.setTimeout(120_000);
  await claimInstanceAsAdministrator(browser);
  await signInAs(page, workerAccount("member"));

  await page.goto("/home");
  const menu = await openMenu(page, isMobile);
  /* The menu is open and drawn (About is every member's), then the absence means something. */
  await expect(menu.getByRole("link", { name: "About" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Administration" })).toHaveCount(0);
});

test("home offers the instance administrator Administration in the account menu", async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  await signInAsWorkerAdministrator(page, "/home");
  await settleArrival(page);

  await page.goto("/home");
  const menu = await openMenu(page, isMobile);
  await expect(menu.getByRole("link", { name: "Administration" })).toBeVisible();
});
