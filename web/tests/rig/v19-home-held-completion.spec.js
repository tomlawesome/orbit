import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";
import { completeLikeTheEngine, ownWorkspace } from "./workspace-writes.js";

/*
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
 * whatever it is answered. The desktop project is the desk, the phone project
 * the pocket.
 *
 * Moved from tests/e2e (ADR-0039, #1611). The item is the fixture's Car MOT
 * (i-mot, version 5, due 2026-08-29); the stash is put in localStorage before
 * the page loads, and the engine's side of the send is this test's own answer
 * (ownWorkspace with completeLikeTheEngine; a 409 where the stash is stale).
 */
test.use({ reducedMotion: "reduce" });

const MOT = { id: "i-mot", title: "Car MOT — Volvo V60", household: "hh-harlow-1", version: 5, dueDate: "2026-08-29" };
const STASH_KEY = "orbit:pending-completion";
const SETTLE = 20_000;

/** The completion the drawer would have stashed (commands.js completeCommand). @param {number} expectedVersion */
function stashedCompletion(expectedVersion) {
  const completedDate = "2026-08-13";
  return {
    type: "item.complete",
    householdId: MOT.household,
    itemId: MOT.id,
    expectedVersion,
    completedDate,
    activity: { id: crypto.randomUUID(), itemId: MOT.id, occurredAt: new Date().toISOString(), effectiveDate: completedDate, previousDate: MOT.dueDate },
  };
}

/** Put the stash in place before the first document of the next navigation, once (a later reload must not stash it again).
 * @param {import("@playwright/test").Page} page @param {unknown[]} commands */
async function stashBeforeLoad(page, commands) {
  await page.addInitScript(({ key, value }) => {
    try {
      if (!sessionStorage.getItem("held-completion-spec")) {
        sessionStorage.setItem("held-completion-spec", "1");
        localStorage.setItem(key, value);
      }
    } catch { /* storage refused: the test fails on its own assertions */ }
  }, { key: STASH_KEY, value: JSON.stringify(commands) });
}

/** @param {import("@playwright/test").Page} page */
const stashOf = (page) => page.evaluate((key) => localStorage.getItem(key), STASH_KEY);

/** The page has taken the stash and every send it made has been answered. @param {import("@playwright/test").Page} page */
async function untilStashIsFinished(page) {
  await expect.poll(() => stashOf(page), { timeout: SETTLE }).toBeNull();
  await page.waitForLoadState("networkidle");
}

test.describe("a completion an earlier visit stashed", () => {
  test("is sent once and recorded, with nothing said about it", async ({ page }) => {
    const writes = await ownWorkspace(page, { "item.complete": completeLikeTheEngine });
    await stashBeforeLoad(page, [stashedCompletion(MOT.version)]);

    await signedIn("/home", "rest")(page);
    await expect.poll(async () => (await writes.itemOf(MOT.id))?.item.dueDate, { timeout: SETTLE }).not.toBe(MOT.dueDate);
    await untilStashIsFinished(page);

    expect(writes.sent("item.complete")).toHaveLength(1);
    await expect(page.getByText("that tick was not recorded")).toHaveCount(0);
    expect(await stashOf(page)).toBeNull();
  });

  test("is sent once in a wide, short window, which both dialects' queries match", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "rig-desktop", "the wide window is the desktop project's");
    const writes = await ownWorkspace(page, { "item.complete": completeLikeTheEngine });
    await stashBeforeLoad(page, [stashedCompletion(MOT.version)]);

    /* 1200 wide (the desk's query) and 500 tall (the pocket's) */
    await page.setViewportSize({ width: 1200, height: 500 });
    await signedIn("/home", "rest")(page);
    await expect.poll(async () => (await writes.itemOf(MOT.id))?.item.dueDate, { timeout: SETTLE }).not.toBe(MOT.dueDate);
    await untilStashIsFinished(page);

    expect(writes.sent("item.complete")).toHaveLength(1);
    await expect(page.getByText("that tick was not recorded")).toHaveCount(0);
    expect(await stashOf(page)).toBeNull();
  });

  test("that the engine refuses is sent once, said once and dropped", async ({ page }) => {
    /* The item moved on since the stash, so the engine answers the stale version as it does. */
    const writes = await ownWorkspace(page, {
      "item.complete": () => ({ status: 409, json: { error: { code: "version_required", message: "This item changed on another device; refresh and try again" } } }),
    });
    await stashBeforeLoad(page, [stashedCompletion(MOT.version - 1)]);

    await signedIn("/home", "rest")(page);
    await untilStashIsFinished(page);

    expect(writes.sent("item.complete")).toHaveLength(1);
    await expect(page.getByText(`${MOT.title}: that tick was not recorded`)).toHaveCount(1);
    expect(await stashOf(page)).toBeNull();
  });
});
