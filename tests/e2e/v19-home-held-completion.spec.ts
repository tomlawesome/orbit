import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { householdDateFromToday } from "./support/household-dates";
import { SETTLE } from "./support/settle";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * A completion an earlier visit stashed and never saw confirmed
 * (localStorage "orbit:pending-completion") is finished on the next load, once.
 *
 * Home mounts both dialects, the desk and the pocket, and CSS shows one. The
 * two replay the same stash, so on a desk-width window the completion was sent
 * twice: the second send is refused as a version conflict and the person is
 * told "that tick was not recorded" for a tick that was. The desk's guard is
 * (min-width: 901px) and the pocket's is (max-width: 900px), (max-height:
 * 600px): not each other's negation, so a wide, short window (1200 x 500, a
 * phone in landscape) is in both. Exactly one dialect may own the stash for
 * any window.
 *
 * The requests are counted, not the responses: the second send is the defect,
 * whatever it is answered. The desktop project is the desk, the mobile
 * project the pocket.
 */
test.use({ reducedMotion: "reduce" });

const HOUSEHOLD_PREFIX = "Held Completion Proving Ground";
const TITLE = "Held completion proving item";
const STASH_KEY = "orbit:pending-completion";
const households = householdRegister();

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
}

/** A household of its own with one item due in 20 days, repeating yearly. */
async function seedHouseholdWithItem(page: Page): Promise<{ itemId: string; householdId: string; dueDate: string }> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async ({ householdName, title, dueDate }) => {
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
    await command({
      type: "item.upsert",
      householdId,
      kind: "service",
      item: { id: itemId, sectionId, title, currency: "GBP", dueDate, recurrenceMonths: 12 },
      activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString() },
    });
    return { itemId, householdId, dueDate };
  }, { householdName: name, title: TITLE, dueDate: householdDateFromToday(20) });
  households.track({ id: seeded.householdId, name });
  return seeded;
}

/** The item as the server holds it now. */
async function itemOf(page: Page, householdId: string, itemId: string) {
  return page.evaluate(async ({ householdId, itemId }) => {
    const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
    const body = (await response.json()) as {
      workspace: { households: { id: string; items?: { id: string; dueDate?: string | null; version?: number }[] }[] };
    };
    return body.workspace.households.find((one) => one.id === householdId)?.items?.find((one) => one.id === itemId) ?? null;
  }, { householdId, itemId });
}

/** The completion the drawer would have stashed (commands.js completeCommand). */
function stashedCompletion(householdId: string, itemId: string, expectedVersion: number, previousDate: string) {
  const completedDate = householdDateFromToday(0);
  return {
    type: "item.complete",
    householdId,
    itemId,
    expectedVersion,
    completedDate,
    activity: { id: randomUUID(), itemId, occurredAt: new Date().toISOString(), effectiveDate: completedDate, previousDate },
  };
}

/** Put the stash in place before the first document of the next navigation,
 *  once (a later reload must not stash it again). */
async function stashBeforeLoad(page: Page, commands: unknown[]) {
  await page.addInitScript(({ key, value }) => {
    try {
      if (!sessionStorage.getItem("held-completion-spec")) {
        sessionStorage.setItem("held-completion-spec", "1");
        localStorage.setItem(key, value);
      }
    } catch { /* storage refused: the test fails on its own assertions */ }
  }, { key: STASH_KEY, value: JSON.stringify(commands) });
}

/** Count the sends to the command route from now on. */
function countCommandSends(page: Page) {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/workspace/commands") sent.push(request.url());
  });
  return sent;
}

const stashOf = (page: Page) => page.evaluate((key) => localStorage.getItem(key), STASH_KEY);

/** The page has taken the stash and every send it made has been answered. */
async function untilStashIsFinished(page: Page) {
  await expect.poll(() => stashOf(page), { timeout: SETTLE }).toBeNull();
  await page.waitForLoadState("networkidle");
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

test.describe("a completion an earlier visit stashed", () => {
  test("is sent once and recorded, with nothing said about it", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const { itemId, householdId, dueDate } = await seedHouseholdWithItem(page);
    const item = await itemOf(page, householdId, itemId);
    await stashBeforeLoad(page, [stashedCompletion(householdId, itemId, item?.version ?? 1, dueDate)]);
    const sent = countCommandSends(page);

    await page.goto("/home");
    await expect.poll(async () => (await itemOf(page, householdId, itemId))?.dueDate, { timeout: SETTLE }).not.toBe(dueDate);
    await untilStashIsFinished(page);

    expect(sent).toHaveLength(1);
    await expect(page.getByText("that tick was not recorded")).toHaveCount(0);
    expect(await stashOf(page)).toBeNull();
  });

  test("is sent once in a wide, short window, which both dialects' queries match", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "the wide window is the desktop project's");
    test.setTimeout(90_000);
    await signIn(page);
    const { itemId, householdId, dueDate } = await seedHouseholdWithItem(page);
    const item = await itemOf(page, householdId, itemId);
    await stashBeforeLoad(page, [stashedCompletion(householdId, itemId, item?.version ?? 1, dueDate)]);
    const sent = countCommandSends(page);

    /* 1200 wide (the desk's query) and 500 tall (the pocket's) */
    await page.setViewportSize({ width: 1200, height: 500 });
    await page.goto("/home");
    await expect.poll(async () => (await itemOf(page, householdId, itemId))?.dueDate, { timeout: SETTLE }).not.toBe(dueDate);
    await untilStashIsFinished(page);

    expect(sent).toHaveLength(1);
    await expect(page.getByText("that tick was not recorded")).toHaveCount(0);
    expect(await stashOf(page)).toBeNull();
  });

  test("that the engine refuses is sent once, said once and dropped", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const { itemId, householdId, dueDate } = await seedHouseholdWithItem(page);
    const item = await itemOf(page, householdId, itemId);
    const staleVersion = item?.version ?? 1;

    /* the item moves on, so the stashed version is stale */
    await page.evaluate(async ({ householdId, itemId, version, snoozedUntil }) => {
      const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({
          type: "item.snooze",
          householdId,
          itemId,
          expectedVersion: version,
          snoozedUntil,
          activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString(), effectiveDate: snoozedUntil },
        }),
      });
      if (!response.ok) throw new Error(`snooze failed: ${response.status} ${await response.text()}`);
    }, { householdId, itemId, version: staleVersion, snoozedUntil: householdDateFromToday(10) });
    expect((await itemOf(page, householdId, itemId))?.version).not.toBe(staleVersion);

    await stashBeforeLoad(page, [stashedCompletion(householdId, itemId, staleVersion, dueDate)]);
    const sent = countCommandSends(page);

    await page.goto("/home");
    await untilStashIsFinished(page);

    expect(sent).toHaveLength(1);
    await expect(page.getByText(`${TITLE}: that tick was not recorded`)).toHaveCount(1);
    expect(await stashOf(page)).toBeNull();
  });
});
