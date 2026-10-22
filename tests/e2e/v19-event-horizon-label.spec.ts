import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1471: the line that bounds overdue on the home dial is called "the event
 * horizon" to people, and that includes screen-reader users. This is a NEW
 * test (no earlier test named the line to a screen reader): on the desk's
 * dial and the pocket's (.mdial), the line is present, rendered, not hidden
 * from the accessibility tree, and its accessible name says "event horizon"
 * -- never the old "overdue line".
 */

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
}

async function sessionHeaders(page: Page) {
  const response = await page.request.get("/api/auth/session");
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { Origin: new URL(page.url()).origin, "X-CSRF-Token": csrfToken };
}

async function cleanupHousehold(page: Page, headers: Record<string, string>, householdId: string, name: string) {
  const url = `/api/households/${householdId}/lifecycle`;
  const schedule = await page.request.post(url, { headers, data: { action: "delete", confirmation: name } });
  if (schedule.status() === 404) return;
  if (!schedule.ok() && schedule.status() !== 409) {
    throw new Error(`Could not schedule event-horizon fixture cleanup (${schedule.status()})`);
  }
  const remove = await page.request.post(url, { headers, data: { action: "hard_delete", confirmation: name } });
  if (remove.status() !== 404 && !remove.ok()) {
    throw new Error(`Could not remove event-horizon fixture (${remove.status()})`);
  }
}

test("the home dial's overdue line is announced as the event horizon", async ({ page }) => {
  await signIn(page);
  const headers = await sessionHeaders(page);
  const suffix = randomUUID().slice(0, 8);
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const householdName = `Dial Line Label ${suffix}`;

  try {
    const create = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "household.create",
        household: {
          id: householdId,
          name: householdName,
          timezone: "Europe/London",
          currency: "GBP",
          memberCount: 1,
          canManage: true,
          onboardingComplete: true,
          sections: [{ id: sectionId, name: "Horizon", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      },
    });
    expect(create.ok()).toBeTruthy();

    const upsert = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId,
        kind: "renewal",
        item: {
          id: randomUUID(),
          sectionId,
          title: `Late proving item ${suffix}`,
          currency: "GBP",
          costMinor: 12550,
          dueDate: householdDateFromToday(-5),
          recurrenceMonths: 12,
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    expect(upsert.ok()).toBeTruthy();

    await page.goto("/home");
    // The desk dial (.dialwrap) or the pocket dial (.mdial): exactly one shows.
    const dial = page.locator(".dialwrap, .mdial").filter({ visible: true });
    await expect(dial).toHaveCount(1);

    // The line is present: one element in the dial carries the name, it is
    // drawn (has a box), and nothing above it hides it from the tree.
    const horizon = dial.locator('[aria-label*="event horizon" i]');
    await expect(horizon).toHaveCount(1);
    const box = await horizon.boundingBox();
    expect(box, "the event horizon is not drawn").not.toBeNull();
    expect(box!.width * box!.height, "the event horizon has no extent").toBeGreaterThan(0);
    expect(
      await horizon.evaluate((el) => el.closest('[aria-hidden="true"]') !== null),
      "the event horizon is hidden from the accessibility tree",
    ).toBe(false);

    // What a screen reader is told is the name, not just the attribute.
    await expect(horizon).toHaveAccessibleName(/event horizon/i);

    // The old name is gone from everything announced on the screen.
    await expect(page.locator('[aria-label*="overdue line" i]')).toHaveCount(0);
    await expect(page.getByText(/overdue line/i)).toHaveCount(0);
  } finally {
    await cleanupHousehold(page, headers, householdId, householdName);
  }
});
