import { expect, test, type Page } from "@playwright/test";
import { householdRegister, unrouteAndSweep } from "./support/households";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { seedHouseholdInBrowser, signIn } from "./support/signed-in";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #434: mail-in review on the v19 surfaces. The review tests (the manifest
 * row's two-tap approve, amend-then-accept in home's drawer, the dismissal, a
 * staged paper's page one) moved to the rig in #1610: see
 * web/tests/rig/v19-mail-review.spec.js. What stays is the one test about the
 * stack's own seed (#1316), which the rig has no seed to run against.
 */

/* #730: the test seeds its own proving ground and removes it again, so it is
   not left in the sky a later spec measures.

   The name carries a per-test suffix because tests in this suite run in
   PARALLEL locally (playwright.config.ts sets fullyParallel with workers
   undefined off CI). A shared fixed name meant concurrent creates of the same
   household, and -- once cleanup existed -- one worker hard-deleting the
   household another was still using. Nothing asserts the name; it is only used
   to create and to sweep. */
const HOUSEHOLD_PREFIX = "Mail Proving Ground";
const households = householdRegister();

/* #1219: interceptMail is `page.route`, and Playwright does not route a
   request the service worker handles (its documentation says to block
   service workers wherever routing is relied on). On desktop-webkit the
   `page.goto("/home")` after sign-in loads a page Orbit's worker controls,
   so `/api/imap-inbox` reached the real, empty inbox and the synthetic row
   never drew (pipeline 2131; #1196 measured the same gap). Nothing here is
   about the worker, so on that project it is kept out. Desktop only: the
   phone project's two #1196 `fail` marks below stand until that issue is
   taken up, and Chromium and Firefox already route these requests. */
test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.name === "desktop-webkit" ? "block" : "allow");
  },
});

const signInToHome = (page: Page) => signIn(page);

async function seedHousehold(page: Page): Promise<{ householdId: string; itemId: string }> {
  const seeded = households.track(
    await seedHouseholdInBrowser(page, HOUSEHOLD_PREFIX, { withItem: true, itemTitle: "Reviewed intake landing", dueInDays: null }),
  );
  return { householdId: seeded.id, itemId: seeded.itemId! };
}
/* #1316, then ADR-0044: the engine once refused an item.upsert that named no
   kind (422); an item now has no type, and a dateless one has no schedule. This
   pins the seed itself: the engine accepts it and the server then holds the
   item back, titled, with no kind on it. */
test("the proving ground's landing item is seeded without a kind and the engine accepts it (#1316, ADR-0044)", async ({ page }) => {
  await signInToHome(page);
  const { householdId, itemId } = await seedHousehold(page);

  try {
    const stored = await page.evaluate(async ({ householdId, itemId }) => {
      const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
      const body = (await response.json()) as {
        workspace: { households: { id: string; items?: { id: string; title?: string; kind?: unknown; scheduleKind?: string | null }[] }[] };
      };
      return body.workspace.households.find((one) => one.id === householdId)?.items?.find((one) => one.id === itemId) ?? null;
    }, { householdId, itemId });
    expect(stored, "the landing item was stored").not.toBeNull();
    expect(stored?.title, "the stored item is the one seeded").toBe("Reviewed intake landing");
    expect(stored, "an item carries no kind").not.toHaveProperty("kind");
    expect(stored?.scheduleKind ?? null, "a dateless item has no schedule").toBeNull();
  } finally {
    await unrouteAndSweep(page, households);
  }
});
