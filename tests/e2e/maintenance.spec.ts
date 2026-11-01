import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { sessionHeaders } from "./support/households";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/*
 * The maintenance page people actually see (#526; ADR-0013 decisions 2, 3, 4
 * and 8).
 *
 * One window is opened for the whole file by the instance administrator and
 * ended again at the end, whatever happened in between: these specs share one
 * instance, and a window left open would close every screen for every spec
 * that runs after this one. Serial, so the shared window's state is the one
 * each test expects.
 */
test.describe.configure({ mode: "serial" });

const STARTED = "We are moving Orbit to new storage. Documents and mail are paused while everything copies across.";
const HALFWAY = "The copy is about halfway. Still on track for the time below.";
const VERIFYING = "Verifying the copied documents before we reopen.";

async function signInAs(page: Page, account: string) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  /* Not a fixed destination: #840 sends a session with no household of its
     own to the arrival at `/` instead of /home, and this file's very first
     sign-in is the instance's first-ever administrator on what may still be
     a genuinely empty database -- exactly that reader. Every caller here
     only needs an authenticated session (the API calls below carry it
     regardless of which page is showing); the maintenance-screen assertions
     that DO care what is on screen check for their own heading, not a URL. */
  const session = await page.request.get("/api/auth/session");
  expect(session.ok(), `sign-in as ${account} did not establish a session`).toBe(true);
}

type MaintenanceState = { version: number; effectivelyActive: boolean };

async function readState(page: Page): Promise<MaintenanceState> {
  const response = await page.request.get("/api/admin/maintenance");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { maintenance: MaintenanceState }).maintenance;
}

async function command(page: Page, body: Record<string, unknown>) {
  const { version } = await readState(page);
  const response = await page.request.post("/api/admin/maintenance", {
    headers: await sessionHeaders(page),
    data: { ...body, expectedVersion: version },
  });
  expect(response.status(), await response.text()).toBe(200);
}

let admin: BrowserContext;
let adminPage: Page;

async function openWindow(browser: Browser) {
  admin = await browser.newContext({ ignoreHTTPSErrors: true });
  adminPage = await admin.newPage();
  await signInAs(adminPage, workerAccount("administrator"));
  /* #1080: the maintenance commands are an instance-admin power. */
  await ensureWorkerAdministrator(adminPage);
  if ((await readState(adminPage)).effectivelyActive) {
    await command(adminPage, { action: "end" });
  }
  await command(adminPage, {
    action: "activate",
    message: STARTED,
    expectedEndAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  });
}

test.beforeAll(async ({ browser }) => {
  await openWindow(browser);
});

test.afterAll(async () => {
  if ((await readState(adminPage)).effectivelyActive) {
    await command(adminPage, { action: "end" });
  }
  await admin.close();
});

/* #1612 (ADR-0039): what the server answers while the window is open -- the
   screen at the asked-for URL with 503 and no-store, the arrival closed,
   /login and /logout open, /maintenance itself, the administrator passing, a
   member shown the screen, the instance reopening at the same URL once the
   window ends -- moved to tests/unit/hooks-server-maintenance-screens.test.mjs.
   The API's own 503 envelope was already proved in
   tests/integration/maintenance-guard.test.ts. What stays is what a person
   sees on the screen. */

test("one entry reads well on its own: no arrow, no drawer", async ({ page }) => {
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "maintenance — back soon" })).toBeVisible();
  await expect(page.getByText(STARTED)).toBeVisible();
  await expect(page.getByText("back by")).toBeVisible();
  await expect(page.locator("details")).toHaveCount(0);
});

test("newest first, and the earlier entries open from the keyboard", async ({ page }) => {
  await command(adminPage, { action: "publish_update", message: HALFWAY });
  await command(adminPage, { action: "publish_update", message: VERIFYING });

  await page.goto("/home");
  await expect(page.getByText(VERIFYING)).toBeVisible();
  await expect(page.getByText(STARTED)).toBeHidden();

  const arrow = page.getByRole("group").locator("summary");
  await expect(arrow).toHaveAccessibleName("Earlier updates");
  await arrow.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(HALFWAY)).toBeVisible();
  await expect(page.getByText(STARTED)).toBeVisible();

  const bodies = await page.locator(".body").allTextContents();
  expect(bodies).toEqual([VERIFYING, HALFWAY, STARTED]);
});

test("the screen has no automated WCAG A or AA violations, drawer open", async ({ page }) => {
  await page.goto("/home");
  await page.locator("summary").click();
  await expect(page.getByText(STARTED)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

test("the screen fits the mobile viewport, drawer open", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile viewport check");
  await page.goto("/home");
  await page.locator("summary").click();
  await expect(page.getByText(STARTED)).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
});
