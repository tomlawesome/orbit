import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";

/*
 * #1757: the one-time importance pill ("N items have no importance yet", #1463)
 * is not drawn while the What's new sheet (#1618) is open on home, on desk or
 * pocket; once the sheet is closed it shows again while an item is still unset.
 * With no notice it shows at once. Same fixture as #1730 (Harlow Home, one
 * unset item). End states only. Runs under both rig projects.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });
test.describe.configure({ timeout: RIG_TEST_MS });

const SETTLE = 30_000;

/* The notice GET /api/whats-new answers for a member (as fidelity/screens.spec.js). */
const NOTICE = {
  version: "v0.3.4",
  releases: [{ version: "v0.3.4", forEveryone: [{ lead: "Items now have an importance.", text: "Your existing items say “not set” until you give them one." }] }],
};

/** @param {import("@playwright/test").Page} page */
const pill = (page) => page.getByRole("status").filter({ hasText: /no importance yet/ });

/** @param {import("@playwright/test").Page} page @param {boolean} withNotice */
async function openHome(page, withNotice) {
  await useFixtureScenes(page, "keep-saves");
  if (withNotice) {
    await page.route("**/api/whats-new", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(NOTICE) })
        : route.fallback(),
    );
  }
  await page.goto(`${APP}/home`);
  await page.locator("body[data-home-ready]").waitFor({ state: "attached", timeout: SETTLE });
}

test("no importance pill while the What's new sheet is open; back once it is closed", async ({ page }) => {
  await openHome(page, true);
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(page.getByRole("button", { name: "Got it" })).toBeVisible();
  await expect(pill(page), "#1757: the importance pill is drawn behind the What's new sheet").toHaveCount(0, { timeout: RIG_EXPECT_MS });

  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: RIG_EXPECT_MS });
  await expect(pill(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(pill(page)).toHaveText(/^\s*1 item has no importance yet/);
});

test("the importance pill shows at once when there is no notice, same fixture", async ({ page }) => {
  await openHome(page, false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(pill(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(pill(page)).toHaveText(/^\s*1 item has no importance yet/);
});
