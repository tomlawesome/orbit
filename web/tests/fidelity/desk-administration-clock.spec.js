import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1584 web-admin-1: the desk's "delete now" on a system on the clock. The
 * command lands and only the re-read after it fails (/api/workspace aborted
 * once the first load is in). The row is gone whatever the read did, so its
 * replacement line says so and tells the reader the screen was not
 * refreshed; the confirm is closed and nothing says "not deleted".
 *
 * The fixture harness answers people and systems; the system on the clock is
 * given here as the workspace route would answer it.
 */
const DESK = { width: 1600, height: 1000 };
const AHEAD = new Date(Date.parse("2026-08-13T12:00:00.000Z") + 13 * 86400000).toISOString();

test("a delete-now whose re-read fails replaces the row with a line that says done", async ({ page }) => {
  await page.setViewportSize(DESK);
  await page.route(`${APP}/api/households/hh-gone-1/lifecycle`, (route) => route.fulfill({ json: { ok: true } }));
  await page.route(`${APP}/api/workspace`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.workspace.recoverableHouseholds = [{ id: "hh-gone-1", name: "Aunt May’s Cottage", deleteAfter: AHEAD }];
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${APP}/administration`, { waitUntil: "load" });
  const doomed = page.locator(".system.doomed", { hasText: "Aunt May" });
  await expect(doomed).toBeVisible();
  /* Registered later, so it runs before the handler above: the re-read fails. */
  await page.route(`${APP}/api/workspace`, (route) => route.abort("failed"));

  await doomed.getByRole("button", { name: "delete now →" }).click();
  await page.locator("#doomname-hh-gone-1").fill("Aunt May’s Cottage");
  await doomed.getByRole("button", { name: "delete now", exact: true }).click();
  await doomed.getByRole("button", { name: "tap again to delete for good" }).click();

  const gone = page.locator(".adminproblem.gone");
  await expect(gone).toContainText("Aunt May’s Cottage is gone for good");
  await expect(gone).toContainText("reload");
  await expect(page.locator(".system.doomed", { hasText: "Aunt May" })).toHaveCount(0);
  await expect(page.locator(".confirm:visible")).toHaveCount(0);
  await expect(page.getByText("not deleted")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
