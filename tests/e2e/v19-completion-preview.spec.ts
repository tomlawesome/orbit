import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";

/* #1337: the "then <date>" a member reads before confirming a completion is
   the date the engine's dry run of `item.complete` answers (counted from the
   completion date), so after a late completion it equals the next date the
   item then shows. The browser used to add months to the old due date, which
   differs by exactly how late the completion was. */
resetDatabaseBetweenSpecFiles();

const households = householdRegister();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shown = (iso: string) => {
  const [year, month, day] = iso.split("-");
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
};

async function signInAsAdmin(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
}

/** A yearly item whose due date passed ten days ago, so completing it today is late. */
async function seedOverdueItem(page: Page) {
  const name = `Preview Proving Ground ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async ({ householdName, dueDate }) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
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
        id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP", memberCount: 1,
        canManage: true, onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    await command({
      type: "item.upsert", householdId, kind: "service",
      item: { id: itemId, sectionId, title: "Boiler service preview", currency: "GBP", dueDate, recurrenceMonths: 12 },
      activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString() },
    });
    return { itemId, householdId };
  }, { householdName: name, dueDate: householdDateFromToday(-10) });
  households.track({ id: seeded.householdId, name });
  return seeded;
}

function drawerOf(page: Page, itemId: string) {
  return test.info().project.name.startsWith("mobile")
    ? page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`)
    : page.locator(`[id="${itemId}-view"]`);
}

test("after a late completion, the preview shown before confirming is the next date the item then shows", async ({ page }) => {
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedOverdueItem(page);

  try {
    await page.goto(`/home?item=${itemId}`);
    const drawer = drawerOf(page, itemId);
    if (test.info().project.name.startsWith("mobile")) await expect(drawer).toHaveAttribute("data-open", "", { timeout: 20_000 });
    else await expect(drawer).toBeVisible({ timeout: 20_000 });

    await drawer.getByRole("group", { name: "Actions for Boiler service preview" })
      .getByRole("button", { name: "Complete Boiler service preview" }).click();
    const completing = drawer.getByRole("group", { name: "Completing Boiler service preview" });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);

    // The preview, before anything is confirmed: "then DD Mon YYYY", from the engine.
    const preview = completing.getByText(/then \d{2} [A-Z][a-z]{2} \d{4}/);
    await expect(preview).toBeVisible({ timeout: 10_000 });
    const previewed = ((await preview.first().textContent()) ?? "").match(/then (\d{2} [A-Z][a-z]{2} \d{4})/)?.[1];
    expect(previewed).toBeTruthy();

    await completing.getByRole("button", { name: "record" }).click();
    await expect(page.getByText(/^Completed · next due .+ · Boiler service preview$/).first()).toBeAttached();

    // The date the item then stores, counted from today (the completion), a year on.
    const stored = await page.evaluate(async ({ seededHouseholdId, seededItemId }) => {
      const workspace = (await (await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" })).json()).workspace;
      return workspace.households.find((one: { id: string }) => one.id === seededHouseholdId)
        .items.find((one: { id: string }) => one.id === seededItemId).dueDate as string;
    }, { seededHouseholdId: householdId, seededItemId: itemId });
    expect(shown(stored)).toBe(previewed);

    // And it is not the old due date plus a year, ten days earlier.
    const oldDuePlusAYear = householdDateFromToday(-10).replace(/^\d{4}/, (year) => String(Number(year) + 1));
    expect(stored).not.toBe(oldDuePlusAYear);
  } finally {
    await households.sweep(page);
  }
});
