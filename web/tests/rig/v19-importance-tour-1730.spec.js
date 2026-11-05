import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS, signedIn } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";

/*
 * #1730: the one-time importance pill ("N items have no importance yet", #1463)
 * is not drawn while the first-run tour runs, on desk or pocket; outside the
 * tour the same fixture (Harlow Home, one unset item) still shows it. End
 * states only. Runs under both rig projects.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });
test.describe.configure({ timeout: RIG_TEST_MS });

const SETTLE = 30_000;

/** @param {import("@playwright/test").Page} page */
const pill = (page) => page.getByRole("status").filter({ hasText: /no importance yet/ });

test("no importance pill while the tour runs", async ({ page }) => {
  await signedIn("/home", "film-rest")(page);
  await expect(page.locator("#orbit-tour-transport")).toBeVisible({ timeout: SETTLE });
  await expect(page.locator("#orbit-tour-veil")).toBeAttached({ timeout: RIG_EXPECT_MS });
  await page.locator("body[data-home-ready]").waitFor({ state: "attached", timeout: SETTLE });
  await expect(pill(page), "#1730: the importance pill is drawn over the tour").toHaveCount(0, { timeout: RIG_EXPECT_MS });
  await expect(page.getByRole("button", { name: "set them now" })).toHaveCount(0);
});

test("the importance pill is still shown outside the tour, same fixture", async ({ page }) => {
  await useFixtureScenes(page, "keep-saves");
  await page.goto(`${APP}/home`);
  await page.locator("body[data-home-ready]").waitFor({ state: "attached", timeout: SETTLE });
  await expect(page.locator("#orbit-tour-transport")).toHaveCount(0);
  await expect(pill(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(pill(page)).toHaveText(/^\s*1 item has no importance yet/);
});
