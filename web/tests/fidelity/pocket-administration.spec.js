import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * ADMINISTRATION ON A PHONE (#1123, proposal §2.12 and §2.11; owner decisions
 * §25 and §19), in a real browser at 390x844 with touch on. The fixture
 * harness answers people, systems and the mockup's machinery rows; the
 * states it cannot reach (a system on the clock, document jobs, alerts) are
 * given here as the routes would answer them.
 *   · row acts are revealed only by a swipe, and are real named buttons
 *   · a system on the clock keeps `restore` on show; `delete now` is behind
 *     the swipe and wakes only for the name typed exactly
 *   · a failed document job says why, and offers retry, with no interaction
 *   · alerts stand first; the jump strip is plain links, not tabs
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const at = (/** @type {number} */ minutes) => new Date(NOW - minutes * 60000).toISOString();
const ahead = (/** @type {number} */ days) => new Date(NOW + days * 86400000).toISOString();
const JOBS = [
  { id: "f1", kind: "scan", status: "failed", attempts: 5, lastErrorCode: "scanner_unavailable", nextAttemptAt: null, createdAt: at(40), updatedAt: at(6) },
  { id: "d1", kind: "encrypt", status: "completed", attempts: 1, lastErrorCode: null, nextAttemptAt: null, createdAt: at(90), updatedAt: at(88) },
];

/**
 * @param {import("@playwright/test").Page} page
 * @param {{ alerts?: boolean }} [options]
 */
async function open(page, { alerts = false } = {}) {
  await page.route(`${APP}/api/admin/operations`, (route) =>
    route.fulfill({ json: { operations: { documentJobs: JOBS, documentJobCounts: {} } } }));
  await page.route(`${APP}/api/workspace`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.workspace.recoverableHouseholds = [{ id: "hh-gone-1", name: "Aunt May’s Cottage", deleteAfter: ahead(13) }];
    await route.fulfill({ response, json: body });
  });
  if (alerts) {
    await page.route(`${APP}/api/admin/recovery-bundle`, (route) =>
      route.fulfill({ json: { recoveryBundle: { exported: false, exportedAt: null } } }));
  }
  await page.goto(`${APP}/administration`, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");
  await page.waitForSelector(".ad-pocket [data-ad=people] .p-row");
  await page.evaluate(() => document.fonts.ready);
}

/**
 * A real touch swipe (Chromium's touch pipeline, so touch-action applies).
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} row
 * @param {number} dx
 */
async function swipe(page, row, dx) {
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await row.boundingBox());
  const from = { x: box.x + box.width - 60, y: box.y + Math.min(box.height / 2, 28) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (dx * i) / 8, y: from.y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Every act button a finger could hit at its centre right now. @param {import("@playwright/test").Page} page */
const hittableActs = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".ad-pocket [data-row-acts] button")].filter((b) => {
    const r = b.getBoundingClientRect();
    if (r.width <= 1 || r.bottom < 0 || r.top > innerHeight) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(hit && b.contains(hit));
  }).map((b) => b.getAttribute("aria-label")));

test("people's acts are behind a swipe, named with their object", async ({ page }) => {
  await open(page);
  expect(await hittableActs(page)).toEqual([]);
  const emma = page.locator(".ad-pocket [data-ad=people] .p-row").filter({ hasText: "Emma Lawson" });
  await swipe(page, emma, -200);
  await page.waitForTimeout(300);
  expect(await hittableActs(page)).toEqual([
    "Place Emma Lawson in a system", "Send Emma Lawson a new setup link", "Disable Emma Lawson",
  ]);
  /* Your own row has none. */
  await expect(page.locator(".ad-pocket [data-ad=people] .p-row").filter({ hasText: "· you" })
    .locator("[data-row-acts]")).toHaveCount(0);
});

test("a system on the clock keeps restore on show and delete now behind the swipe", async ({ page }) => {
  await open(page);
  const clock = page.locator(".ad-pocket [data-ad=systems] .p-row").filter({ hasText: "Aunt May" });
  await expect(clock).toContainText("on the clock · 13 days left · gone for good 26 Aug");
  await expect(page.getByRole("button", { name: "Restore Aunt May’s Cottage" })).toBeVisible();
  expect(await hittableActs(page)).toEqual([]);

  await swipe(page, clock, -160);
  await page.waitForTimeout(300);
  expect(await hittableActs(page)).toEqual(["Delete Aunt May’s Cottage now, for good"]);
  const act = page.getByRole("button", { name: "Delete Aunt May’s Cottage now, for good" });
  await act.click();
  await act.click();
  const sheet = page.getByRole("dialog", { name: /Delete Aunt May’s Cottage now/ });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Nothing comes back after this");
  await expect(sheet.getByRole("button", { name: "delete for good" })).toBeDisabled();
  await sheet.getByLabel(/type the system’s name exactly/i).fill("Aunt May’s Cottage");
  await expect(sheet.getByRole("button", { name: "delete for good" })).toBeEnabled();
});

test("a failed document job says why and offers retry, with no interaction", async ({ page }) => {
  await open(page);
  const card = page.locator(".ad-pocket [data-ad=documents]");
  const failed = card.locator(".p-row").filter({ hasText: "FAILED" });
  await expect(failed).toContainText("Virus scan");
  await expect(failed).toContainText("couldn’t reach the virus scanner · 5 tries · last tried 6m ago");
  await expect(page.getByRole("button", { name: "Retry the virus scan" })).toBeVisible();
  /* Kind only, never a document's name (owner, 2026-09-19); one retry, on the failed row only. */
  await expect(card.getByRole("button", { name: /^Retry/ })).toHaveCount(1);
  /* And it is told at the top of the page. */
  await expect(page.locator(".ad-pocket .ad-tells a", { hasText: "1 job failed" })).toHaveAttribute("href", "#ad-documents");
});

test("alerts stand first, and the jump strip is links, not tabs", async ({ page }) => {
  await open(page, { alerts: true });
  const first = page.locator(".ad-pocket main > section, .ad-pocket main > .ad-alerts").first();
  await expect(first).toHaveAttribute("data-ad", "alerts");
  await expect(first).toContainText("No recovery bundle exported");
  await first.getByRole("button", { name: "what to do" }).click();
  await expect(page.getByRole("dialog", { name: "No recovery bundle exported" })).toContainText("orbit export-recovery-bundle");

  const strip = page.getByRole("navigation", { name: "Jump to a card" });
  await expect(strip.getByRole("tab")).toHaveCount(0);
  for (const [word, id] of [["people", "ad-people"], ["systems", "ad-systems"], ["documents", "ad-documents"]]) {
    await expect(strip.getByRole("link", { name: word })).toHaveAttribute("href", `#${id}`);
  }
});

test("invite someone is a sheet, and never shows a link", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "invite someone" }).click();
  const sheet = page.getByRole("dialog", { name: "Invite someone" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("email")).toBeVisible();
  await expect(sheet.getByLabel("display name")).toBeVisible();
  await sheet.getByRole("button", { name: "One day more" }).click();
  await expect(sheet.locator("output")).toHaveText("8 days");
  await expect(sheet).toContainText("The link is never shown here.");
  await expect(sheet.locator("a[href*='setup']")).toHaveCount(0);
});

/* The tray is tightest at 360: three acts must still sit wholly off the row
   at rest, and wholly on it once revealed. */
test.describe("at 360", () => {
  test.use({ viewport: { width: 360, height: 780 } });
  test("people's three acts fit the tray", async ({ page }) => {
    await open(page);
    expect(await hittableActs(page)).toEqual([]);
    const emma = page.locator(".ad-pocket [data-ad=people] .p-row").filter({ hasText: "Emma Lawson" });
    await swipe(page, emma, -200);
    await page.waitForTimeout(300);
    expect(await hittableActs(page)).toEqual([
      "Place Emma Lawson in a system", "Send Emma Lawson a new setup link", "Disable Emma Lawson",
    ]);
    const spill = await emma.locator("[data-row-acts]").evaluate((tray) =>
      [...tray.querySelectorAll("button")].some((b) => b.getBoundingClientRect().left < tray.getBoundingClientRect().left - 0.5));
    expect(spill).toBe(false);
  });
});
