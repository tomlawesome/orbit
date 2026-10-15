import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1440: the desk account menu offered "Administration" to every reader. It
 * is the instance administrator's screen, so the menu offers it only when the
 * root layout says the reader is one (the same fact the phone hatch already
 * uses). The fidelity harness runs on fixtures, where no session exists and so
 * nobody is an administrator: the menu must still offer the ordinary entries
 * and must not offer Administration.
 *
 * /home draws its own menu (a <nav> inside #account) rather than Chrome's, so
 * it is checked beside /settings and /inbox, for the member and for the
 * administrator.
 */
const DESK = { width: 1600, height: 1000 };

/**
 * Make the page's document say the reader is an instance administrator: the
 * root layout's data is inlined in the served HTML (`isAdmin:!1` for the
 * fixtures' sessionless reader), so the document is fetched and that one
 * fact flipped. Throws when the fact is not found, so a change to how the
 * layout data is sent fails here instead of silently testing a member.
 * @param {import("@playwright/test").Page} page
 * @param {string} route
 */
async function readAsAdministrator(page, route) {
  await page.route(`${APP}${route}`, async (request) => {
    if (request.request().resourceType() !== "document") return request.continue();
    const response = await request.fetch();
    const body = await response.text();
    const flipped = body.replace(/isAdmin:\s*(?:!1|false)/, "isAdmin:!0");
    if (flipped === body) throw new Error(`no isAdmin:false in the ${route} document's layout data`);
    await request.fulfill({ response, body: flipped });
  });
}

/** @param {import("@playwright/test").Page} page */
async function openDeskMenu(page) {
  await page.locator("button.orb").click();
  return page.locator("#account nav");
}

for (const route of ["/settings", "/inbox", "/home"]) {
  test(`the desk account menu on ${route} offers no Administration to a non-administrator`, async ({ page }) => {
    await page.setViewportSize(DESK);
    await page.goto(`${APP}${route}`, { waitUntil: "load" });

    const nav = await openDeskMenu(page);
    for (const name of ["Inbox", "Settings", "About"]) {
      await expect(nav.locator("a", { hasText: name }).first()).toBeVisible();
    }
    await expect(nav.locator("a", { hasText: "Administration" })).toHaveCount(0);
  });

  test(`the desk account menu on ${route} offers Administration to an instance administrator`, async ({ page }) => {
    await page.setViewportSize(DESK);
    await readAsAdministrator(page, route);
    await page.goto(`${APP}${route}`, { waitUntil: "load" });

    const nav = await openDeskMenu(page);
    for (const name of ["Inbox", "Settings", "About"]) {
      await expect(nav.locator("a", { hasText: name }).first()).toBeVisible();
    }
    await expect(nav.locator("a", { hasText: "Administration" })).toBeVisible();
  });
}
