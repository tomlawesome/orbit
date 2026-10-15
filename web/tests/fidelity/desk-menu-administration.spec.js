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
 */
const DESK = { width: 1600, height: 1000 };

for (const route of ["/settings", "/inbox"]) {
  test(`the desk account menu on ${route} offers no Administration to a non-administrator`, async ({ page }) => {
    await page.setViewportSize(DESK);
    await page.goto(`${APP}${route}`, { waitUntil: "load" });

    await page.locator("button.orb").click();
    const nav = page.locator(".account nav");
    for (const name of ["Inbox", "Settings", "About"]) {
      await expect(nav.locator("a", { hasText: name }).first()).toBeVisible();
    }
    await expect(nav.locator("a", { hasText: "Administration" })).toHaveCount(0);
  });
}
