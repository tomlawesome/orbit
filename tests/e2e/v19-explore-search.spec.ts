import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #1161, "C · unrolled" (design/v19/search/round-1/BUILD.md): `#explore` and
 * the strip that draws above it, replacing POL-9's command palette. The pure
 * filter (name/section/provider/document text, top match) is still
 * pocket-search.js's own `searchPocket` and is proved directly in
 * tests/unit/pocket-home.test.mjs; this spec proves the desk wires it up —
 * typing filters the strip's matches, arrow keys and hover move the
 * selection, and Enter opens the selected entry — the same way
 * v19-item-actions.spec.ts proves a row's own actions against a real stack
 * rather than a stub. Desk-only: the phone half is a different surface
 * (pocket-search's own sheet, ratified round 1 B) and is out of scope here.
 *
 * `#strip` is the SVG's own wrapper (aria-hidden; decoration), `#strip-note`
 * is the note line under it, and `#explore-results` is the accessible read
 * of the same results (a `role="listbox"` of `role="option"` `li`s) — the
 * ids BUILD.md §4 names.
 */

const HOUSEHOLD_PREFIX = "Explore Proving Ground";
const households = householdRegister();

async function signInAsAdmin(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  /* #1080: the sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
}

/**
 * Two items far enough out to sit in the manifest's "later" group (>30 days),
 * so they draw a row on the desk to open, with a section and a provider each
 * matcher can hit on its own. `matchTitle` also carries "MOT", so a bare
 * "mo" query hits it without hitting `otherTitle`.
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
      kind: "service",
      item: {
        id: matchId, sectionId, title: matchTitle, currency: "GBP",
        provider: "Kwik-Fit", dueDate: matchDue, recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId: matchId, kind: "created", occurredAt: new Date().toISOString() },
    });
    const otherId = crypto.randomUUID();
    const otherTitle = "Boiler service proving";
    const otherDue = new Date(Date.now() + 95 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      kind: "service",
      item: {
        id: otherId, sectionId, title: otherTitle, currency: "GBP",
        dueDate: otherDue, recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId: otherId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { householdId, matchId, matchTitle, otherId, otherTitle };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

/**
 * One item due soon enough (`days >= 0`) to be `groups.closest` — the note
 * line's "complete" act names it (#1162). `recurrenceMonths: 12` matches
 * v19-item-actions.spec.ts's own completion proof, so the same "about a year
 * later" regex applies here too.
 */
async function seedHouseholdWithSoonItem(page: Page): Promise<{ householdId: string; itemId: string; title: string }> {
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
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    const title = "Nearest due proving";
    const dueDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      kind: "service",
      item: {
        id: itemId, sectionId, title, currency: "GBP",
        dueDate, recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { householdId, itemId, title };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

function skipOnMobile() {
  test.skip(test.info().project.name.startsWith("mobile"), "#explore's strip is the desk half; the phone has its own sheet");
}

test("typing in #explore filters the results by title, section and provider", async ({ page }) => {
  skipOnMobile();

  await signInAsAdmin(page);
  const { matchTitle, otherTitle } = await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    const explore = page.locator("#explore");
    const results = page.locator("#explore-results");

    // Title.
    await explore.fill("kwik-fit");
    await expect(results).toContainText(matchTitle);
    await expect(results).not.toContainText(otherTitle);

    // Section (accent-folded: the household's own section carries the query).
    await explore.fill("kayak garage");
    await expect(results).toContainText(matchTitle);
    await expect(results).toContainText(otherTitle);

    // Provider, and a query nothing answers.
    await explore.fill("kwik-fit");
    /* #explore-results is the screen reader's copy (visually hidden); what
       the eye sees is the strip's one mark. */
    await expect(results.getByRole("option").filter({ hasText: matchTitle })).toHaveCount(1);
    await expect(page.locator("#strip .match")).toHaveCount(1);
    await expect(page.locator("#strip")).toBeVisible();
    await explore.fill("no such orbit thing zzz");
    await expect(page.locator("#strip-note")).toContainText(`nothing in your orbit is called "no such orbit thing zzz"`);
  } finally {
    await households.sweep(page);
  }
});

test("Enter in #explore opens the top matched item", async ({ page }) => {
  skipOnMobile();

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

test("#strip is not visible before #explore is focused", async ({ page }) => {
  skipOnMobile();

  await signInAsAdmin(page);
  await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    await expect(page.locator("#strip")).toBeHidden();
  } finally {
    await households.sweep(page);
  }
});

test("#strip never draws below the field, even on a short viewport", async ({ page }) => {
  skipOnMobile();
  /* BUILD.md §3: at 1536×730 the strip's top sits at about y=506, clear of
     the sun but with little headroom — the shortest window the desk
     dialect actually runs at (901px is the pocket/desk breakpoint). */
  await page.setViewportSize({ width: 1536, height: 730 });

  await signInAsAdmin(page);
  await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    const explore = page.locator("#explore");
    await explore.fill("mo"); // matches "Kwik-Fit MOT proving" — draws at least one mark
    const strip = page.locator("#strip");
    await expect(strip).toBeVisible();

    const stripBox = await strip.boundingBox();
    const exploreBox = await explore.boundingBox();
    expect(stripBox).not.toBeNull();
    expect(exploreBox).not.toBeNull();
    if (stripBox && exploreBox) {
      expect(stripBox.y).toBeGreaterThanOrEqual(0);
      expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(exploreBox.y);
    }
  } finally {
    await households.sweep(page);
  }
});

test("ArrowRight steps the strip's selection and Enter opens the selected entry", async ({ page }) => {
  skipOnMobile();

  await signInAsAdmin(page);
  const { otherId, otherTitle } = await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    const explore = page.locator("#explore");
    await explore.fill("kayak garage"); // both items, soonest (the match) first
    const items = page.locator("#explore-results li");
    await expect(items).toHaveCount(2);

    await explore.press("ArrowRight");
    await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");

    await explore.press("Enter");
    await expect(page).toHaveURL(new RegExp(`item=${otherId}`));
    await expect(page.locator(`[id="${otherId}"]`)).toContainText(otherTitle);
  } finally {
    await households.sweep(page);
  }
});

test("hovering a mark selects it", async ({ page }) => {
  skipOnMobile();

  await signInAsAdmin(page);
  await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    const explore = page.locator("#explore");
    await explore.fill("kayak garage"); // both items, so there is a second mark to hover
    const marks = page.locator("#strip .match");
    await expect(marks).toHaveCount(2);

    /* Hover the mark's own body (drawn last in its group), as a reader does:
       the group's box also spans the gap up to its label, and that empty
       middle is the SVG's, not the mark's. */
    await marks.nth(1).locator(":scope > :last-child").hover({ timeout: 10_000 });
    await expect(page.locator("#explore-results li").nth(1)).toHaveAttribute("aria-selected", "true");
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1162: the note line's own two acts, BUILD.md left inert by #1161 and
 * wired up here — "complete" the closest thing due and "add" an item, by
 * mouse and by keyboard, through the same completeCommand/applyCommand and
 * /create the rest of the app already uses (item page, pocket-search).
 */

test("clicking the note line's add act, at rest, opens /create", async ({ page }) => {
  skipOnMobile();

  await signInAsAdmin(page);
  await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    await page.locator("#explore").focus();
    const addAct = page.locator("#strip-note .act", { hasText: "add an item" });
    await expect(addAct).toBeVisible();
    await addAct.click();

    await expect(page).toHaveURL(/\/create$/);
  } finally {
    await households.sweep(page);
  }
});

test("Enter on the no-match add act carries the typed name to /create", async ({ page }) => {
  skipOnMobile();

  await signInAsAdmin(page);
  await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/home");
    const explore = page.locator("#explore");
    await explore.fill("no such orbit thing zzz");
    await expect(page.locator("#strip-note")).toContainText('add "no such orbit thing zzz" as an item');
    /* The no-match branch's only entry is the add act, so the default
       selection (index 0) is already it — the same "Enter opens the
       selected entry" wiring the matched-item cases above prove. */
    await explore.press("Enter");

    await expect(page).toHaveURL(/\/create\?name=/);
    await expect(page.locator("#f-name")).toHaveValue("no such orbit thing zzz");
  } finally {
    await households.sweep(page);
  }
});

test("clicking the note line's complete act arms then fires, completing the closest item", async ({ page }) => {
  skipOnMobile();

  await signInAsAdmin(page);
  const { itemId, title } = await seedHouseholdWithSoonItem(page);

  try {
    await page.goto("/home");
    await page.locator("#explore").focus();
    /* Order matches stripActsOf: "complete" before "add" (BUILD.md §1). */
    const completeAct = page.locator("#strip-note .act").first();
    await expect(completeAct).toHaveText(`→ complete "${title}"`);

    await completeAct.click();
    await expect(completeAct).toHaveText(`tap again to complete "${title}"`);

    await completeAct.click();
    // The strip closes on fire and the view re-reads with the new orbit.
    await expect(page.locator("#strip")).toBeHidden();
    await expect(page.locator(`[id="${itemId}"]`)).toContainText(/T−36[456]d/);
  } finally {
    await households.sweep(page);
  }
});
