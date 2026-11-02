import { expect, test } from "@playwright/test";

import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, onPhone } from "./a11y-support.js";
import { FAILED_MESSAGE, INTERNAL_ERROR, SUGGESTION, rememberMailDecisions } from "./mail-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1584 (web-inbox-1, web-inbox-2, web-inbox-3), moved to the rig (ADR-0039,
 * #1610): a mail decision that LANDED is never read back as refused, or lost,
 * when only the read of the screen after it fails.
 *
 * The approve (or the remove of a failed message) is answered normally; the one
 * `/api/workspace` read that follows it answers 500 once. The reader must be
 * told the decision was made and the screen could not refresh (the words of
 * web/src/lib/data/landed.js, `done — ... reload ...`) where the screen says
 * that act's problems:
 *
 *   home, desk   the suggestion's drawer shows the line, its buttons back at
 *                rest (the drawer is not re-read, so it stands); nothing is
 *                woken (the desk has no wake);
 *   home, phone  the decision is woken as done ("<title> added to your orbit")
 *                and the row, which stays open, carries the line;
 *   inbox        a removed failed message is done, never "not removed": the
 *                desk's failed entry carries the line, the phone wakes it.
 *
 * A second `Add to orbit` on a standing row would replay the earlier approval
 * (workspace.js approveOnce), never make a second item, so the line's remedy is
 * the reload every one of these ends with: the entry is gone after it.
 *
 * Each test starts from the fixture inbox (the approvable "Home insurance
 * renewal" receipt; the failed message "It carried no document Orbit can
 * read"). The decision is answered, and remembered for the reload that follows
 * it, by `rememberMailDecisions` (mail-support.js); the one failed re-read is
 * the test's own fault, injected on `/api/workspace`.
 *
 * Playwright does not route a request the service worker handles, and nothing
 * here is about the worker: kept out on every engine.
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

/** `landed.js`'s words for a command that landed whose re-read failed. */
const DONE = /^done —.*reload/i;
const APPROVAL_FAILED = /could not complete the request/;

/**
 * The mail decisions answered as the test needs, and (with
 * `failReadAfterLanding`) the first `/api/workspace` read after a decision
 * landed answering 500, then reads passing through.
 * @param {Page} page
 * @param {{ approveRefusedOnce?: boolean, failReadAfterLanding?: boolean }} [options]
 */
async function interceptMail(page, { approveRefusedOnce = false, failReadAfterLanding = false } = {}) {
  const mail = await rememberMailDecisions(page, {
    answer: (n) => (approveRefusedOnce && n === 1 ? { status: 500, json: INTERNAL_ERROR } : null),
  });
  let workspaceFailures = 0;
  if (failReadAfterLanding) {
    await page.route("**/api/workspace", (route) => {
      if (route.request().method() !== "GET" || mail.landed.size === 0 || workspaceFailures > 0) return route.fallback();
      workspaceFailures += 1;
      return route.fulfill({ status: 500, json: INTERNAL_ERROR });
    });
  }
  return {
    approvals: () => mail.approvals.length,
    removals: () => mail.removals.length,
    workspaceFailures: () => workspaceFailures,
  };
}

/** Open the suggestion where the dialect decides it, and press Add to orbit
 *  twice. Returns the place its line shows.
 * @param {Page} page @param {boolean} pocket */
async function approveFromHome(page, pocket) {
  if (pocket) {
    await page.goto("/home");
    const row = page.locator(`.pocket .pk-signals [data-row-key="${SUGGESTION.id}"]`);
    await expect(row.locator("[data-row-face]")).toBeVisible({ timeout: SETTLE });
    await row.locator("[data-row-face]").click();
    /* The pill's name is "Add <title> to your orbit", then "tap again to add ..." once armed. */
    const pill = row.getByRole("button", { name: new RegExp(`add ${SUGGESTION.title} to your orbit$`, "i") }).filter({ visible: true });
    await expect(pill).toBeEnabled({ timeout: SETTLE });
    await pill.click();
    await pill.click();
    return row;
  }
  await page.goto(`/home?item=${SUGGESTION.id}`);
  const drawer = page.locator(`[id="${SUGGESTION.id}-view"]`);
  const add = drawer.getByRole("button", { name: "Add to orbit" });
  await expect(add).toBeEnabled({ timeout: SETTLE });
  await add.click();
  await drawer.getByRole("button", { name: "tap again to approve" }).click();
  return drawer;
}

/** The wake's polite region, filtered to words.
 * @param {Page} page @param {string | RegExp} words */
const woken = (page, words) => page.getByRole("status").filter({ hasText: words });

test("home desk: a landed approve whose re-read fails shows the done line on the row, buttons at rest", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the desk drawer; the phone's row is the next test");
  const mail = await interceptMail(page, { failReadAfterLanding: true });
  const drawer = await approveFromHome(page, false);
  await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(1);
  await expect.poll(mail.workspaceFailures, { timeout: SETTLE }).toBe(1);

  await expect(drawer.locator("[role=alert]")).toHaveText(DONE, { timeout: SETTLE });
  /* The row stood, at rest: the buttons read as before and work. */
  const add = drawer.getByRole("button", { name: "Add to orbit" });
  await expect(add).toBeVisible();
  await expect(add).toBeEnabled();
  /* The desk wakes nothing here. */
  await expect(woken(page, /added to your orbit/)).toHaveCount(0);

  /* The remedy the line names: after a reload the suggestion is gone. */
  await page.reload();
  await expect(page.locator(".item.suggest", { hasText: SUGGESTION.title })).toHaveCount(0, { timeout: SETTLE });
  await expect(page.locator(`[id="${SUGGESTION.id}-view"]`)).toHaveCount(0);
});

test("home phone: a landed approve whose re-read fails is woken as done and the row shows the done line", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "the phone's row; the desk's drawer is the previous test");
  const mail = await interceptMail(page, { failReadAfterLanding: true });
  const row = await approveFromHome(page, true);
  await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(1);
  await expect.poll(mail.workspaceFailures, { timeout: SETTLE }).toBe(1);

  /* The decision landed, so it is woken as done... */
  await expect(woken(page, `${SUGGESTION.title} added to your orbit`)).toHaveCount(1, { timeout: SETTLE });
  /* ...and the row, which stays, carries the line under it. */
  await expect(row).toHaveAttribute("data-open", "");
  await expect(row.locator("[role=alert]")).toHaveText(DONE);
  expect(mail.approvals()).toBe(1);
});

test("inbox: a landed remove of a failed message whose re-read fails is done, not 'not removed'", async ({ page }, testInfo) => {
  const mail = await interceptMail(page, { failReadAfterLanding: true });
  await page.goto("/inbox");
  if (onPhone(testInfo)) {
    const row = page.locator(`.pk-inbox [data-row-key="${FAILED_MESSAGE.id}"]`);
    await expect(row.locator("[data-row-face]")).toBeVisible({ timeout: SETTLE });
    await row.locator("[data-row-face]").click();
    const pill = row.getByRole("button", { name: /remove the message from/i }).filter({ visible: true });
    await expect(pill).toBeEnabled({ timeout: SETTLE });
    await pill.click();
    await pill.click();
    await expect.poll(mail.removals, { timeout: SETTLE }).toBe(1);
    await expect.poll(mail.workspaceFailures, { timeout: SETTLE }).toBe(1);
    /* The row has no line of its own, so the phone wakes it. */
    await expect(woken(page, DONE)).toHaveCount(1, { timeout: SETTLE });
  } else {
    /* The fixture inbox holds two failed messages: this is the one that carried no document. */
    const entry = page.locator(".inbox-page .failed").filter({ hasText: FAILED_MESSAGE.words }).filter({ visible: true });
    await expect(entry).toBeVisible({ timeout: SETTLE });
    await entry.getByRole("button", { name: "remove" }).click();
    await entry.getByRole("button", { name: "tap again to remove" }).click();
    await expect.poll(mail.removals, { timeout: SETTLE }).toBe(1);
    await expect.poll(mail.workspaceFailures, { timeout: SETTLE }).toBe(1);
    await expect(entry.locator(".mail-problem")).toHaveText(DONE, { timeout: SETTLE });
  }
  /* Removed is removed: nobody is told it was not. */
  await expect(page.getByText(/not removed/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(FAILED_MESSAGE.words)).toHaveCount(0, { timeout: SETTLE });
  await expect(page.locator(`[data-row-key="${FAILED_MESSAGE.id}"]`)).toHaveCount(0, { timeout: SETTLE });
});

test("guard: a refused approve still shows the refusal, with no done line and no wake (passes today)", async ({ page }, testInfo) => {
  const mail = await interceptMail(page, { approveRefusedOnce: true });
  const place = await approveFromHome(page, onPhone(testInfo));
  await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(1);

  await expect(place.getByText(APPROVAL_FAILED).first()).toBeVisible({ timeout: SETTLE });
  await expect(place.getByText(/done —/)).toHaveCount(0);
  await expect(woken(page, /added to your orbit/)).toHaveCount(0);
  expect(mail.workspaceFailures()).toBe(0);
});
