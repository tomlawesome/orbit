import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";

/*
 * #1440: Administration is for the instance administrator. An ordinary member
 * is not offered it in the account menu (the desk's card or the phone's
 * hatch); the administrator keeps all of it. Moved from tests/e2e (ADR-0039,
 * #1611): the states are the fixture reader (never an administrator) and the
 * same reader read as one (`administrator`).
 *
 * That the member is not served the page (404) and is refused the instance-wide
 * reads behind it (403) is lower: tests/unit/administration-page-gate.test.mjs:24,28
 * and tests/integration/authorization-matrix.test.ts:474,496,498.
 */

const SETTLE = 20_000;

/** The account menu this width draws: the desk's card, or the pocket's hatch. @param {import("@playwright/test").Page} page */
async function openMenu(page) {
  if (!test.info().project.name.includes("phone")) {
    await page.locator("button.orb").click();
    return page.locator("#account");
  }
  await page.locator("button.porb").click();
  const hatch = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(hatch).toHaveClass(/open/);
  return hatch;
}

for (const route of ["/settings", "/home"]) {
  test(`${route} does not offer an ordinary member Administration in the account menu`, async ({ page }) => {
    await signedIn(route, route === "/home" ? "rest" : "any-dialect")(page);
    const menu = await openMenu(page);
    /* The menu is open and drawn (About is every member's), then the absence means something. */
    await expect(menu.getByRole("link", { name: "About" })).toBeVisible({ timeout: SETTLE });
    await expect(menu.getByRole("link", { name: "Administration" })).toHaveCount(0);
  });
}

test("home offers the instance administrator Administration in the account menu", async ({ page }) => {
  await signedIn("/home", "administrator")(page);
  const menu = await openMenu(page);
  await expect(menu.getByRole("link", { name: "Administration" })).toBeVisible({ timeout: SETTLE });
});

test("the instance administrator is offered Administration and the page renders", async ({ page }) => {
  await signedIn("/settings", "administrator")(page);
  const menu = await openMenu(page);
  const link = menu.getByRole("link", { name: "Administration" });
  await expect(link).toBeVisible({ timeout: SETTLE });
  /* The link itself is followed, as the reader does: the administrator's session
     stays the one the state gave this page. */
  await link.click();

  await expect(page).toHaveURL(/\/administration$/);
  await expect(page).toHaveTitle("Orbit — administration");
  await expect(page.getByRole("heading", { level: 1, name: "Administration" })).toBeVisible({ timeout: SETTLE });
});
