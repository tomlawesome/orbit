import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #455: the item view's writes, for real — a household and item seeded
 * through the same command API the product uses, then completed through the
 * v19 view, with the new orbit visible back on home.
 *
 * #1319 (owner-decisions §34): the belt that was "the v19 view" retired;
 * these act through the item's home drawer, which `/home?item=<id>` opens.
 * What only the belt had went with it: `/item` with no id seating the
 * nearest-due item and the belt's empty-household card (`/item` now lands
 * on home: v19-home-drawer.spec.ts, "the belt's old address"), and the
 * desk card's widening and centring on the belt's apex while editing (the
 * drawer edits in its own rows: v19-home-drawer.spec.ts, "the pencil edits
 * the drawer's own rows; Escape takes the chooser, then the edit").
 */

/* #730: each test removes the proving ground it seeded, so neither is left
   crowding the sky a later spec measures.

   The name carries a per-test suffix because these tests run in PARALLEL
   locally (playwright.config.ts sets fullyParallel with workers undefined off
   CI). A shared fixed name meant concurrent creates of the same household and,
   once cleanup existed, one worker hard-deleting the household another was
   still using. CI never showed it because CI pins workers to 1. Nothing
   asserts the name. */
const HOUSEHOLD_PREFIX = "Actions Proving Ground";
const households = householdRegister();

async function signInAsAdmin(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  /* #1080: the sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
}

async function seedHouseholdWithItem(page: Page): Promise<{ itemId: string; householdId: string }> {
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
        id: householdId,
        name: householdName,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    const dueDate = householdDateFromToday(20);
    await command({
      type: "item.upsert",
      householdId,
      kind: "service",
      item: {
        id: itemId,
        sectionId,
        title: "Boiler service proving",
        currency: "GBP",
        dueDate,
        recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString() },
    });
    return { itemId, householdId };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

/**
 * #1319 (owner-decisions §34): the item's home drawer, which its address
 * opens: the desk's view under the row, the phone's open row.
 */
function drawerOf(page: Page, itemId: string) {
  return test.info().project.name.startsWith("mobile")
    ? page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`)
    : page.locator(`[id="${itemId}-view"]`);
}

async function openDrawer(page: Page, itemId: string) {
  await page.goto(`/home?item=${itemId}`);
  const drawer = drawerOf(page, itemId);
  if (test.info().project.name.startsWith("mobile")) {
    await expect(drawer).toHaveAttribute("data-open", "", { timeout: 20_000 });
  } else {
    await expect(drawer).toBeVisible({ timeout: 20_000 });
  }
  return drawer;
}

/* #1319: the belt's complete moved to the drawer's foot row, on the desk and
   the phone alike: complete asks for the date (today), the cost and the
   notes in the rows, record sends it at once (no held undo), and the next
   orbit is the engine's. */
test("completing an item from its home drawer moves its orbit", async ({ page }) => {
  await signInAsAdmin(page);

  const { itemId } = await seedHouseholdWithItem(page);

  try {
    const drawer = await openDrawer(page, itemId);
    const pocket = test.info().project.name.startsWith("mobile");
    // Due in 20 days: needs attention.
    await expect(pocket ? drawer : page.locator(`[id="${itemId}"]`)).toContainText("T−20d");

    await drawer.getByRole("group", { name: "Actions for Boiler service proving" })
      .getByRole("button", { name: "Complete Boiler service proving" }).click();
    const completing = drawer.getByRole("group", { name: "Completing Boiler service proving" });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
    await completing.getByRole("button", { name: "record" }).click();
    await expect(page.getByText(/^Completed · next due .+ · Boiler service proving$/).first()).toBeAttached();

    // A year of lead time now (allow the ±1 day of month arithmetic).
    // On a desk the row sits in the wide orbit; in the pocket dialect only
    // attention rows are listed, and with this household's one item a year
    // out its line says nothing needs you and names the item as next up.
    await page.goto("/home");
    if (pocket) {
      await expect(page.locator(".mdial svg")).toBeVisible();
      const below = page.locator(".pocket .pk-below");
      await expect(below.locator(".p-row .title", { hasText: /^Boiler service proving$/ })).toHaveCount(0);
      await expect(below.locator(".p-row", { hasText: "nothing needs you" }))
        .toContainText(/next up Boiler service proving, T−36[456]d/, { timeout: 15_000 });
    } else {
      await expect(page.locator(`[id="${itemId}"]`)).toContainText(/T−36[456]d/, { timeout: 15_000 });
    }
  } finally {
    await households.sweep(page);
  }
});

/* The belt's reschedule became the pencil's due date in the drawer's rows;
   any edit sends the item at the version the drawer read. A rival's change
   makes that stale, and the engine refuses it in its own words: said under
   the rows before the save is even pressed (its dry run, ADR-0034), and
   never written over the rival's change. */
test("a stale version is refused and the drawer says so", async ({ page }) => {
  await signInAsAdmin(page);

  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    const drawer = await openDrawer(page, itemId);

    // Someone else reschedules while our drawer is open (same command API,
    // fresh version) — our copy is now stale.
    await page.evaluate(async ({ seededHouseholdId, seededItemId }) => {
      const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
      const workspace = (await (await fetch("/api/workspace", { credentials: "same-origin" })).json()).workspace;
      const household = workspace.households.find((one: { id: string }) => one.id === seededHouseholdId);
      const item = household.items.find((one: { id: string }) => one.id === seededItemId);
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({
          type: "item.reschedule",
          householdId: household.id,
          itemId: item.id,
          expectedVersion: item.version,
          dueDate: "2027-03-03",
          activity: { id: crypto.randomUUID(), itemId: item.id, occurredAt: new Date().toISOString(), nextDate: "2027-03-03" },
        }),
      });
      if (!response.ok) throw new Error(`rival reschedule failed: ${response.status}`);
    }, { seededHouseholdId: householdId, seededItemId: itemId });

    await drawer.getByRole("button", { name: "Edit this item" }).click();
    await drawer.getByRole("textbox", { name: "provider" }).click();
    await page.keyboard.type("Stale Services");
    const save = drawer.getByRole("group", { name: "Editing Boiler service proving" }).getByRole("button", { name: "save" });
    if (await save.isEnabled()) await save.click();

    // Refused in the server's own words, and nothing written over the rival.
    await expect(drawer.getByRole("alert")).toContainText("changed on another device", { timeout: 10_000 });
    const held = await page.evaluate(async ({ seededHouseholdId, seededItemId }) => {
      const workspace = (await (await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" })).json()).workspace;
      return workspace.households.find((one: { id: string }) => one.id === seededHouseholdId)
        .items.find((one: { id: string }) => one.id === seededItemId) as { dueDate: string; provider?: string | null };
    }, { seededHouseholdId: householdId, seededItemId: itemId });
    expect(held.dueDate).toBe("2027-03-03");
    expect(held.provider ?? null).toBeNull();

    // Refreshed, as the refusal asks, the drawer reads the truth.
    const reread = await openDrawer(page, itemId);
    await expect(reread).toContainText("3 March 2027");
  } finally {
    await households.sweep(page);
  }
});
