import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";

/**
 * #456: the create form, proven against the real engine — the wiring was
 * built before any API was reachable and has never carried a real save.
 */

/* #730: this proving ground is removed at the end of the test that makes it,
   so it is not still in the sky when a later spec measures one. */
const HOUSEHOLD = "Creation Proving Ground";
const households = householdRegister();

async function seedHousehold(page: Page): Promise<{ id: string; name: string }> {
  return await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId,
          name: householdName,
          timezone: "Europe/London",
          currency: "GBP",
          memberCount: 1,
          canManage: true,
          onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status} ${await response.text()}`);
    return { id: householdId, name: householdName };
  }, HOUSEHOLD);
}

test("the create form saves a real item into the orbit", async ({ page }) => {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/\/home$/);
  households.track(await seedHousehold(page));

  try {
    await page.goto("/create");
    await page.locator("#f-name").fill("Gutter clearing proving");
    await page.locator('#types button[data-type="service"]').click();
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await page.locator("#f-date").fill(dueDate);
    await page.locator(".btn-primary").click();

    // Saved and returned to the orbit, where the new item needs attention.
    await expect(page).toHaveURL(/\/home$/);
    if (test.info().project.name.startsWith("mobile")) {
      await expect(page.locator(".mitem", { hasText: "Gutter clearing proving" })).toBeVisible();
    } else {
      const row = page.locator(".item", { hasText: "Gutter clearing proving" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("T−20d");
    }
  } finally {
    await households.sweep(page);
  }
});
