import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { signInAsWorkerAdministrator } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { settleArrival } from "./support/arrival";
import { SETTLE } from "./support/settle";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * The DESK administration screen's own surfaces (§13/§15), both built
 * against `web/src/routes/administration/pocket.svelte` as the working
 * reference for behaviour and server calls, and both run once per
 * Playwright project (desktop-chromium, mobile-chromium) by
 * `playwright.config.ts`'s own default -- no per-project wiring here beyond
 * branching a selector where the two dialects genuinely differ.
 *
 * #1001: household recovery on the Systems card, ratified
 * design/v19/household-recovery/round-1/b-the-row-on-the-clock.html. Walks
 * restore (the safe, one-tap act on desk; ArmButton's own two taps on the
 * phone, unchanged there) and the two-tap hard delete, on both dialects.
 *
 * #1071: that the server remembers the last relay-test answer so it survives a
 * reload moved lower (#1612, ADR-0039): tests/integration/admin-operations-evidence.test.ts.
 */

const households = householdRegister();

/**
 * A household the current session owns outright, through the real command.
 *
 * #1448: through the browser context's own request channel, not an in-page
 * `fetch`. A fetch belongs to the document that issued it, and the arrival at
 * `/` (an administrator with no household of their own lands there, #840) is
 * still deciding when a spec signs in: the first household made here turns
 * its decision ONWARD, it calls `location.replace("/home")`, and WebKit
 * answers the unfinished fetch of the document being left with `TypeError:
 * Load failed` (CI jobs 40519, 40540, 41285). A request made through
 * `page.request` shares the page's cookies but not its document, so no
 * navigation can cancel it. Callers still `settleArrival` first: that is what
 * makes `sessionHeaders` read the app's origin rather than the provider's, and
 * what stops the later `goto` being aborted by the same redirect.
 */
async function createHousehold(page: Page, name: string) {
  const householdId = crypto.randomUUID();
  const response = await page.request.post("/api/workspace/commands", {
    headers: await sessionHeaders(page),
    data: {
      type: "household.create",
      household: {
        id: householdId, name, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    },
  });
  expect(response.ok(), `household.create for "${name}" (${response.status()})`).toBeTruthy();
  const created = { id: householdId, name };
  households.track(created);
  return created;
}

/** A name no other worker's copy of this test can share. The administration
 * roster lists every household on the instance, so two workers that read
 * `Date.now()` in the same millisecond (`--repeat-each` starts them together)
 * would otherwise own two rows of one name and make a row locator ambiguous. */
function uniqueName(prefix: string) {
  return `${prefix} w${process.env.TEST_PARALLEL_INDEX ?? "x"} ${Date.now()}`;
}

/** Schedules a household's deletion through the real lifecycle endpoint
 * (the same call `src/routes/household/[id]/+page.svelte`'s own danger line
 * makes) -- an instance administrator may call it on any household
 * (`requireScheduleAuthority`), not only one they own. */
async function scheduleDeletion(page: Page, household: { id: string; name: string }) {
  const response = await page.request.post(`/api/households/${household.id}/lifecycle`, {
    headers: await sessionHeaders(page),
    data: { action: "delete", confirmation: household.name },
  });
  expect(response.ok(), `scheduling deletion of "${household.name}" (${response.status()})`).toBeTruthy();
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

test.describe("household recovery on the clock (#1001)", () => {
  test("restores a household within its window, then hard-deletes another by the two-tap protocol", async ({ page }, testInfo) => {
    const mobile = testInfo.project.name.startsWith("mobile");
    await signInAsWorkerAdministrator(page, "/administration");
    await settleArrival(page, SETTLE, "/administration");

    const toRestore = await createHousehold(page, uniqueName("Recovery restore"));
    const toDelete = await createHousehold(page, uniqueName("Recovery delete"));
    await scheduleDeletion(page, toRestore);
    await scheduleDeletion(page, toDelete);

    await page.goto("/administration");

    // ---- restore (the safe act, one accent tap on desk) ------------------
    if (mobile) {
      // The recovery row's `restore` is always on show (never behind the
      // row's own open/close), an ArmButton like every other dangerous-ish
      // phone act: first tap arms, second fires.
      const restoreButton = page.getByRole("button", { name: `Restore ${toRestore.name}` });
      await restoreButton.click();
      await page.getByRole("button", { name: `tap again to restore ${toRestore.name}` }).click();
    } else {
      const row = page.locator(".system.doomed").filter({ hasText: toRestore.name });
      await row.getByRole("button", { name: "restore" }).click();
    }

    // The row returns to normal -- no longer on the clock, on either dialect.
    if (mobile) {
      await expect(page.getByRole("button", { name: `Restore ${toRestore.name}` })).toHaveCount(0);
    } else {
      await expect(page.locator(".system.doomed").filter({ hasText: toRestore.name })).toHaveCount(0);
    }

    // ---- hard delete (the household page's own danger protocol) ----------
    if (mobile) {
      // Opens the row in place (§1.1), arms and fires the row's own
      // `delete now` act, which opens the confirm sheet.
      await page.locator("[data-row-face]").filter({ hasText: toDelete.name }).click();
      const deleteNowAct = page.getByRole("button", { name: `Delete ${toDelete.name} now, for good` });
      await deleteNowAct.click();
      await page.getByRole("button", { name: `tap again to delete ${toDelete.name} now, for good` }).click();

      await page.getByLabel("type the system’s name exactly to wake the button").fill(toDelete.name);
      await page.getByRole("button", { name: "delete for good" }).click();
      await page.getByRole("button", { name: "tap again to delete for good" }).click();

      await expect(page.getByText(`deleted · ${toDelete.name} is gone for good · its members keep their accounts`))
        .toBeVisible();
    } else {
      const row = page.locator(".system.doomed").filter({ hasText: toDelete.name });
      await row.getByRole("button", { name: "delete now →" }).click();
      await row.getByLabel("type the system’s name exactly to wake the button").fill(toDelete.name);

      const armButton = row.getByRole("button", { name: "delete now", exact: true });
      await expect(armButton).toBeEnabled();
      await armButton.click();
      await row.getByRole("button", { name: "tap again to delete for good" }).click();

      await expect(page.getByText(`deleted · ${toDelete.name} is gone for good · its members keep their accounts`))
        .toBeVisible();
    }

    // Gone for good: the members route the household page relies on 404s
    // for a caller who can no longer see it (households.ts's own contract).
    const membersAfter = await page.request.get(`/api/households/${toDelete.id}/members`);
    expect(membersAfter.status()).toBe(404);
  });
});
