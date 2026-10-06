import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { sessionHeaders } from "./support/households";
import { seedHousehold } from "./support/signed-in";
import { answerPushWithoutAService } from "./support/webkit-push";
import { workerAccount } from "./support/worker-identity";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * About (#1256): any signed-in member reaches it from the account menu --
 * no admin gate, because the credits must reach everyone who uses what they
 * credit -- and a signed-out visitor is not served it at all (owner, answer
 * 7: no About on the sign-in door).
 */

async function signInAs(page: Page, account: string) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

/**
 * household.create makes the member its owner, never an instance
 * administrator, so the hard delete support/households.ts's cleanup ends
 * with is refused (403). Scheduling the deletion is the half an owner may
 * do, as settings-notification-history.spec.ts does.
 */
async function scheduleHouseholdDeletion(page: Page, householdId: string, name: string) {
  const response = await page.request.post(`/api/households/${householdId}/lifecycle`, {
    headers: await sessionHeaders(page),
    data: { action: "delete", confirmation: name },
  });
  if (response.status() === 404 || response.status() === 409) return;
  if (!response.ok()) throw new Error(`#1256: could not schedule cleanup of "${name}" (${response.status()})`);
}

test("a member opens About from the menu and sees the three cards", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await claimInstanceAsAdministrator(browser);
  await signInAs(page, workerAccount("member"));
  const household = await seedHousehold(page, "About");
  try {
    await page.goto("/settings");
    await expect(page.locator(".helm-page .cards")).toBeVisible({ timeout: 30_000 });

    await page.locator("button.orb").click();
    const about = page.locator("#account").getByRole("link", { name: "About" });
    await expect(about).toBeVisible();
    await about.click();

    await expect(page).toHaveURL(/\/about$/);
    await expect(page).toHaveTitle("Orbit — about");
    const screen = page.locator(".about-page");
    for (const card of ["This Orbit", "Credits", "Licences"]) {
      await expect(screen.getByRole("heading", { level: 2, name: card })).toBeVisible();
    }

    /* Card 1 answered from the running stack: every row has a value. */
    const orbit = screen.locator("section.orbit");
    await expect(orbit.locator(".kv")).toHaveCount(7, { timeout: 30_000 });
    await expect(orbit.locator(".kv", { hasText: "PostgreSQL" }).locator("b")).toHaveText(/^\d+(\.\d+)*$/);
    await expect(orbit).not.toContainText("not shown");

    /* Card 2's index and the pictures it must credit; card 3 lists each licence once. */
    const index = screen.getByRole("navigation", { name: "Credits index" });
    await expect(index.getByRole("link")).toHaveText([/^Pictures · 3$/, /^Fonts · 3$/, /^Libraries · (\d+|—)$/, /^Sidecar images · 4$/]);
    await expect(screen.locator("#credit-the-milky-way-behind-the-flight")).toContainText("changed: Reduced in size");
    const licences = await screen.locator("section.licences .kv b").allTextContents();
    expect(new Set(licences).size).toBe(licences.length);

    /* The menu's own row lights on this page. */
    await page.locator("button.orb").click();
    await expect(page.locator("#account").getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
  } finally {
    await scheduleHouseholdDeletion(page, household.id, household.name);
  }
});

test("a signed-out visitor is not served /about or its API", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/about");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fabout$/);
    await expect(page.locator(".about-page")).toHaveCount(0);

    const api = await context.request.get("/api/about");
    expect(api.status()).toBe(401);
    expect(await api.text()).not.toMatch(/sha256|postgres|tika|clamav|ollama/i);
  } finally {
    await context.close();
  }
});
