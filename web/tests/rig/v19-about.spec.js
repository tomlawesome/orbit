import { expect, test } from "@playwright/test";

import { CREDITS } from "../../src/lib/about/credits.js";
import { APP, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * ABOUT (#1256), moved to the rig (ADR-0039, #1611) from
 * tests/e2e/v19-about.spec.ts.
 *
 * Any signed-in member reaches it from the account menu -- no admin gate,
 * because the credits must reach everyone who uses what they credit. The member
 * starts on the fixture's /settings, opens the menu and follows About.
 *
 * Gone from here: a signed-out visitor is not served /about or its API (owner,
 * answer 7: no About on the sign-in door). The redirect is
 * tests/unit/hooks-server-signed-out.test.mjs:86, the API's refusal
 * tests/unit/about-route.test.mjs:59. The card's rows are the fixture's here,
 * not the running stack's, so "PostgreSQL has a version number" is read off the
 * fixture's answer; the real read is the about route's own test.
 */
test.use({ baseURL: APP });

/**
 * The account menu this width draws: the desk's card, or the pocket's hatch.
 * @param {Page} page @param {boolean} phone
 */
async function openMenu(page, phone) {
  if (!phone) {
    await page.locator("button.orb").click();
    return page.locator("#account");
  }
  await page.locator("button.porb").click();
  const hatch = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(hatch).toHaveClass(/open/);
  return hatch;
}

test("a member opens About from the menu and sees the three cards", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await signedIn("/settings", "any-dialect")(page);

  const about = (await openMenu(page, phone)).getByRole("link", { name: "About" });
  await expect(about).toBeVisible();
  await about.click();

  await expect(page).toHaveURL(/\/about$/);
  await expect(page).toHaveTitle("Orbit — about");
  const screen = page.locator(".about-page");
  for (const card of ["This Orbit", "Credits", "Licences"]) {
    await expect(screen.getByRole("heading", { level: 2, name: card })).toBeVisible();
  }

  /* Card 1: every row has a value. */
  const orbit = screen.locator("section.orbit");
  await expect(orbit.locator(".kv")).toHaveCount(7);
  await expect(orbit.locator(".kv", { hasText: "PostgreSQL" }).locator("b")).toHaveText(/^\d+(\.\d+)*$/);
  await expect(orbit).not.toContainText("not shown");

  /* Card 2's index and the pictures it must credit; card 3 lists each licence once. */
  const index = screen.getByRole("navigation", { name: "Credits index" });
  await expect(index.getByRole("link")).toHaveText([new RegExp(`^Pictures · ${CREDITS.length}$`), /^Fonts · 3$/, /^Libraries · (\d+|—)$/, /^Sidecar images · 4$/]);
  const licences = await screen.locator("section.licences .kv b").allTextContents();
  expect(new Set(licences).size).toBe(licences.length);

  /* The menu's own row lights on this page. */
  await expect((await openMenu(page, phone)).getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
});
