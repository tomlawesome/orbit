import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { sessionHeaders } from "./support/households";

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
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await expect(page).toHaveURL(/\/home$/);
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
  await signInAs(adminPage, "Orbit Administrator");
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

test("a signed-out reader gets the maintenance screen at the URL they asked for", async ({ request }) => {
  // Decision 2: the page, status 503, never cached, and when to come back.
  // At /home rather than redirected to /maintenance, so a reload after the
  // window closes lands them where they were.
  const response = await request.get("/home", { maxRedirects: 0 });
  expect(response.status()).toBe(503);
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("no-store");
  expect(Number(headers["retry-after"])).toBeGreaterThan(0);
  expect(headers["etag"]).toBeUndefined();
  const body = await response.text();
  expect(body).toContain("maintenance — back soon");
  expect(body).toContain(STARTED);
});

test("the arrival is closed too: a stranger is not an administrator", async ({ request }) => {
  const response = await request.get("/", { maxRedirects: 0 });
  expect(response.status()).toBe(503);
});

for (const path of ["/login", "/logout"]) {
  test(`${path} stays open during a window`, async ({ request }) => {
    // Decision 3: the door and the way out, so an administrator can get in
    // to end the window and anyone can leave cleanly.
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });
}

test("/maintenance itself answers 503 with the same screen", async ({ request }) => {
  const response = await request.get("/maintenance", { maxRedirects: 0 });
  expect(response.status()).toBe(503);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.text()).toContain(STARTED);
});

test("the API keeps its own guard and its own envelope", async ({ request }) => {
  // The screen gate does not reach into /api/*; the read wrapper's own
  // maintenance check answers there, as JSON, before any session question.
  const response = await request.get("/api/workspace");
  expect(response.status()).toBe(503);
  expect(response.headers()["content-type"]).toContain("application/json");
});

test("the administrator passes; an ordinary member is shown the screen", async ({ browser }) => {
  const passed = await adminPage.request.get("/home", { maxRedirects: 0 });
  expect(passed.status()).toBe(200);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    // The sign-in itself is exempt; what it lands on afterwards is not.
    await signInAs(page, "Orbit Member");
    await expect(page.getByRole("heading", { name: "maintenance — back soon" })).toBeVisible();
    const response = await page.request.get("/home", { maxRedirects: 0 });
    expect(response.status()).toBe(503);
  } finally {
    await context.close();
  }
});

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

test("ending the window reopens the instance at the same URL", async ({ request }) => {
  await command(adminPage, { action: "end", message: "Back." });
  const response = await request.get("/home", { maxRedirects: 0 });
  // Signed out, so the ordinary gate takes over: the door, not the eclipse.
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/login?returnTo=%2Fhome");
});
