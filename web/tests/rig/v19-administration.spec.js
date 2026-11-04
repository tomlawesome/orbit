import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { RIG_TEST_MS, signedIn } from "./a11y-support.js";
import { guardedRoute } from "./workspace-writes.js";

/*
 * #1001: household recovery on the Systems card, ratified
 * design/v19/household-recovery/round-1/b-the-row-on-the-clock.html. Restore
 * (one tap on the desk; ArmButton's two taps on the phone) and the two-tap
 * hard delete, on both dialects. Moved from tests/e2e (ADR-0039, #1611): the
 * state is `/administration two-on-the-clock` (Aunt May's Cottage, 13 days,
 * and Uncle Bob's Allotment, 6 days); the two writes are this test's own
 * answers, and the read after each leaves the acted-on household out.
 *
 * The server's side of the hard delete (the household and its members are
 * gone, a repeat is a 404) is lower: tests/integration/household-lifecycle.test.ts:420-441.
 */

const RESTORE = "Aunt May’s Cottage";
const DELETE = "Uncle Bob’s Allotment";
const SETTLE = 20_000;

/* Takes 54-59 s on a loaded WebKit runner (#1695), too close to the rig budget alone. */
test.describe.configure({ timeout: RIG_TEST_MS * 2 });

test("restores a household within its window, then hard-deletes another by the two-tap protocol", async ({ page }, testInfo) => {
  const phone = testInfo.project.name.endsWith("phone");
  /* The arm hold is the page's own 4 s timer (arm.js ARM_MS), so the page's clock is the test's: installed before load, paused around each tap pair so real elapsed time on loaded WebKit cannot disarm the button between taps. */
  await page.clock.install();
  await signedIn("/administration", "two-on-the-clock")(page);

  /** @type {{ action: string, confirmation?: string, id: string }[]} */
  const lifecycle = [];
  const gone = new Set();
  await page.route(`${APP}/api/households/*/lifecycle`, guardedRoute(async (route) => {
    const id = route.request().url().match(/households\/([^/]+)\/lifecycle/)?.[1] ?? "";
    lifecycle.push({ id, ...route.request().postDataJSON() });
    gone.add(id);
    await route.fulfill({ json: { ok: true } });
  }));
  /* The read after a write: the workspace without the household acted on. */
  await page.route(`${APP}/api/workspace`, guardedRoute(async (route) => {
    if (route.request().method() !== "GET" || gone.size === 0) return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.workspace.recoverableHouseholds = [
      { id: "hh-gone-1", name: RESTORE, deleteAfter: "2026-08-26T12:00:00.000Z" },
      { id: "hh-gone-2", name: DELETE, deleteAfter: "2026-08-19T12:00:00.000Z" },
    ].filter((one) => !gone.has(one.id));
    await route.fulfill({ response, json: body });
  }));

  // ---- restore (the safe act, one accent tap on desk) ------------------
  if (phone) {
    // Always on show, an ArmButton: first tap arms, second fires.
    await page.clock.pauseAt(new Date(Date.now() + 1_000));
    await page.getByRole("button", { name: `Restore ${RESTORE}` }).click();
    await page.getByRole("button", { name: `tap again to restore ${RESTORE}` }).click({ force: true });
  } else {
    await page.locator(".system.doomed").filter({ hasText: RESTORE }).getByRole("button", { name: "restore" }).click();
  }
  await expect.poll(() => lifecycle).toEqual([{ id: "hh-gone-1", action: "restore" }]);

  // The row returns to normal -- no longer on the clock, on either dialect.
  if (phone) await expect(page.getByRole("button", { name: `Restore ${RESTORE}` })).toHaveCount(0, { timeout: SETTLE });
  else await expect(page.locator(".system.doomed").filter({ hasText: RESTORE })).toHaveCount(0, { timeout: SETTLE });

  // ---- hard delete (the household page's own danger protocol) ----------
  if (phone) {
    // Opens the row in place, arms and fires its `delete now` act, which opens the confirm sheet.
    await page.locator("[data-row-face]").filter({ hasText: DELETE }).click();
    await page.getByRole("button", { name: `Delete ${DELETE} now, for good` }).click();
    await page.getByRole("button", { name: `tap again to delete ${DELETE} now, for good` }).click({ force: true });
    await page.getByLabel("type the system’s name exactly to wake the button").fill(DELETE);
    await page.getByRole("button", { name: "delete for good" }).click();
    await page.getByRole("button", { name: "tap again to delete for good" }).click({ force: true });
  } else {
    const row = page.locator(".system.doomed").filter({ hasText: DELETE });
    await row.getByRole("button", { name: "delete now →" }).click();
    await row.getByLabel("type the system’s name exactly to wake the button").fill(DELETE);
    const arm = row.getByRole("button", { name: "delete now", exact: true });
    await expect(arm).toBeEnabled();
    await arm.click();
    await row.getByRole("button", { name: "tap again to delete for good" }).click();
  }
  await expect(page.getByText(`deleted · ${DELETE} is gone for good · its members keep their accounts`)).toBeVisible({ timeout: SETTLE });
  expect(lifecycle[1]).toEqual({ id: "hh-gone-2", action: "hard_delete", confirmation: DELETE });
});
