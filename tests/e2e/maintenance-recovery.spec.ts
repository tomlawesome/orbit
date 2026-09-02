import { expect, test, type Page } from "@playwright/test";

const administrator = "Orbit Administrator";
const drillMessage = "Upgrading Orbit. Back shortly.";

/**
 * The recovery drill (#524, ADR-0013 decision 4).
 *
 * The claim under test is the one that matters in an emergency: an
 * administrator who closes Orbit can always get back in to reopen it. Signing
 * out and signing back in *while maintenance is active* is what proves it,
 * because the whole return journey runs through the five routes exempt from
 * the maintenance guard. A test that stayed signed in would prove nothing.
 *
 * This drill closes the entire instance to users for the duration, so it must
 * not run beside other journeys. Playwright's serial mode covers this file;
 * across files the acceptance lane's single worker does (`workers: 1` when
 * CI is set). Do not run the suite with more workers against a shared
 * instance.
 */

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: administrator }).click();
  await expect(page).toHaveURL("/workspace");
}

interface MaintenanceReading {
  effectivelyActive: boolean;
  version: number;
}

/* Null means "not signed in", which is a state the drill deliberately passes
   through, not a failure. Anything else unreadable is a real fault. */
async function readMaintenance(page: Page): Promise<MaintenanceReading | null> {
  const response = await page.request.get("/api/admin/maintenance");
  if (response.status() === 401 || response.status() === 403) return null;
  if (!response.ok()) throw new Error(`Could not read maintenance state (${response.status()})`);
  const payload = await response.json() as { maintenance?: MaintenanceReading };
  if (!payload.maintenance) throw new Error("Maintenance state response was invalid");
  return payload.maintenance;
}

/* The instance must never be left closed by a failed drill, so the journey is
   unwound through the API whatever went wrong in the browser.

   This is called from afterEach, never a finally block. A finally runs inside
   the test's own timeout budget, so a drill that times out has nothing left
   and the first cleanup request is aborted mid-call - which is precisely how
   #558 left Orbit closed for every test that followed. An afterEach gets its
   own budget, and its page is still usable. */
async function ensureMaintenanceEnded(page: Page) {
  let state = await readMaintenance(page);
  if (state === null) {
    /* The drill signs out on purpose, so a failure mid-journey can land here
       with no session. Sign-in is one of the routes exempt from the guard. */
    await signIn(page);
    state = await readMaintenance(page);
  }
  if (state === null) throw new Error("Could not read maintenance state even after signing in");
  if (!state.effectivelyActive) return;
  const sessionResponse = await page.request.get("/api/auth/session");
  if (!sessionResponse.ok()) throw new Error(`Could not read the session for cleanup (${sessionResponse.status()})`);
  const session = await sessionResponse.json() as { csrfToken: string };
  const response = await page.request.post("/api/admin/maintenance", {
    headers: { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrfToken },
    data: { action: "end", expectedVersion: state.version },
  });
  if (!response.ok()) throw new Error(`Could not reopen Orbit after the drill (${response.status()})`);
}

test.describe("maintenance recovery drill (#524)", () => {
  /* Not a finally block: see ensureMaintenanceEnded. A drill that times out
     has no budget left for its own cleanup, so the unwind lives here. */
  test.afterEach(async ({ page }) => {
    await ensureMaintenanceEnded(page);
  });

  test("an administrator closes Orbit, signs in again while it is closed, and reopens it", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");

    await signIn(page);
    await page.goto("/admin");
    const maintenance = page.locator(".admin-page #maintenance");
    // exact: true, because Playwright matches an accessible name by substring
    // otherwise and this section now carries a nested "Scheduled maintenance"
    // heading too (#613). Without it the locator resolves to two elements and
    // strict mode fails the drill before it has started.
    await expect(maintenance.getByRole("heading", { name: "Maintenance", exact: true })).toBeVisible();
    await expect(maintenance.getByText("Orbit is open to users.", { exact: true })).toBeVisible();
    await expect(page.locator(".maintenance-banner")).toHaveCount(0);

    await maintenance.getByRole("button", { name: "Start maintenance…" }).click();
    await maintenance.getByLabel("Message shown on the maintenance screen").fill(drillMessage);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Close Orbit to users now?");
      await dialog.accept();
    });
    await maintenance.getByRole("button", { name: "Close Orbit to users" }).click();

    await expect(maintenance.getByText("Maintenance is active.", { exact: true })).toBeVisible();
    await expect(maintenance.getByText("Maintenance is active. Users see the maintenance screen; administrators keep full access.")).toBeVisible();
    /* Published verbatim, never summarised: what an administrator typed is
       what users are about to read. */
    await expect(maintenance.locator(".maintenance-published-message")).toHaveText(drillMessage);

    const banner = page.locator(".maintenance-banner");
    await expect(banner).toBeVisible();
    await expect(banner.getByText("Maintenance is active — Orbit is closed to users.")).toBeVisible();
    await expect(banner.getByRole("link", { name: "Maintenance control" })).toBeVisible();

    /* The instance is now closed. Everything from here is the recovery
       path, and it has to work with no session at all. */
    await page.goto("/workspace");
    await expect(page.locator(".maintenance-banner")).toBeVisible();
    /* The account control is desktop-only below 821px by ratified decision
       (authenticated-accessibility.spec.ts). Mobile signs out through the
       drawer, so the drill must walk the path the administrator actually has,
       not the one the desktop has. */
    if (isMobile) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Personalise" }).click();
      await page.getByRole("button", { name: "Sign out securely" }).click();
    } else {
      await page.getByRole("button", { name: "Open account menu" }).click();
      await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();

    await signIn(page);

    await page.goto("/admin#maintenance");
    await expect(maintenance.getByText("Maintenance is active. Users see the maintenance screen; administrators keep full access.")).toBeVisible();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toBe("End maintenance and reopen Orbit to users?");
      await dialog.accept();
    });
    await maintenance.getByRole("button", { name: "End maintenance" }).click();

    await expect(maintenance.getByText("Maintenance ended.", { exact: true })).toBeVisible();
    await expect(maintenance.getByText("Orbit is open to users.", { exact: true })).toBeVisible();
    await expect(page.locator(".maintenance-banner")).toHaveCount(0);
  });
});
