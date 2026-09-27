import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #1057 (desk half): `#explore` and its palette (POL-9, design/v19/home.html).
 * The pure filter (name/section/provider/document text, top match) is
 * pocket-search.js's own `searchPocket` and is proved directly in
 * tests/unit/pocket-home.test.mjs; this spec proves the desk wires it up —
 * typing filters the palette's rows and Enter opens the top match — the same
 * way v19-item-actions.spec.ts proves a row's own actions against a real
 * stack rather than a stub. Desk-only: the phone half is a different surface
 * (pocket-search's own sheet, ratified round 1 B) and is out of scope here.
 */

const HOUSEHOLD_PREFIX = "Explore Proving Ground";
const households = householdRegister();

async function signInAsAdmin(page: Page) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  /* #1080: the sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
}

/**
 * Two items far enough out to sit in the manifest's "later" group (>30 days),
 * so they draw a row on the desk to open, with a section and a provider each
 * matcher can hit on its own.
 */
async function seedHouseholdWithTwoItems(page: Page): Promise<{
  householdId: string;
  matchId: string;
  matchTitle: string;
  otherId: string;
  otherTitle: string;
}> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async (householdName) => {
    const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const command = async (payload: unknown) => {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    };
    const householdId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await command({
      type: "household.create",
      household: {
        id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: sectionId, name: "Kayak Garage", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const matchId = crypto.randomUUID();
    const matchTitle = "Kwik-Fit MOT proving";
    const matchDue = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      item: {
        id: matchId, sectionId, title: matchTitle, currency: "GBP", scheduleKind: "service",
        provider: "Kwik-Fit", dueDate: matchDue, recurrenceMonths: 12, status: "active",
      },
      activity: { id: crypto.randomUUID(), itemId: matchId, kind: "created", occurredAt: new Date().toISOString() },
    });
    const otherId = crypto.randomUUID();
    const otherTitle = "Boiler service proving";
    const otherDue = new Date(Date.now() + 95 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      item: {
        id: otherId, sectionId, title: otherTitle, currency: "GBP", scheduleKind: "service",
        dueDate: otherDue, recurrenceMonths: 12, status: "active",
      },
      activity: { id: crypto.randomUUID(), itemId: otherId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { householdId, matchId, matchTitle, otherId, otherTitle };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

test("typing in #explore filters the palette by title, section and provider", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "#explore's palette is the desk half; the phone has its own sheet");

  await signInAsAdmin(page);
  const { matchTitle, otherTitle } = await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    const explore = page.locator("#explore");
    const palette = page.locator("#palette");

    // Title.
    await explore.fill("kwik-fit");
    await expect(palette).toContainText(matchTitle);
    await expect(palette).not.toContainText(otherTitle);

    // Section (accent-folded: the household's own section carries the query).
    await explore.fill("kayak garage");
    await expect(palette).toContainText(matchTitle);
    await expect(palette).toContainText(otherTitle);

    // Provider, and a query nothing answers.
    await explore.fill("kwik-fit");
    await expect(palette.locator("b", { hasText: matchTitle })).toBeVisible();
    await explore.fill("no such orbit thing zzz");
    await expect(palette).toContainText(`nothing in your orbit is called "no such orbit thing zzz"`);
  } finally {
    await households.sweep(page);
  }
});

test("Enter in #explore opens the top matched item", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "#explore's palette is the desk half; the phone has its own sheet");

  await signInAsAdmin(page);
  const { matchId, matchTitle } = await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    const explore = page.locator("#explore");
    await explore.fill("kwik-fit");
    await explore.press("Enter");

    await expect(page).toHaveURL(new RegExp(`item=${matchId}`));
    await expect(page.locator(`[id="${matchId}"]`)).toBeVisible();
    await expect(page.locator(`[id="${matchId}"]`)).toContainText(matchTitle);
  } finally {
    await households.sweep(page);
  }
});
