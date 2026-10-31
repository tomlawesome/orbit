import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { householdRegister, unrouteAndSweep } from "./support/households";
import { seedHousehold, signIn, type Household } from "./support/signed-in";
import { SETTLE } from "./support/settle";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1584 (web-inbox-1, web-inbox-2, web-inbox-3): a mail decision that LANDED
 * is never read back as refused, or lost, when only the read of the screen
 * after it fails.
 *
 * The approve (or the remove of a failed message) is answered normally; the
 * one `/api/workspace` read that follows it answers 500 once. The reader must
 * be told the decision was made and the screen could not refresh (the words
 * of web/src/lib/data/landed.js, `done — ... reload ...`) where the screen
 * says that act's problems:
 *
 *   home, desk   the suggestion's drawer shows the line, its buttons back at
 *                rest (the drawer is not re-read, so it stands); nothing is
 *                woken (the desk has no wake);
 *   home, phone  the decision is woken as done ("<title> added to your
 *                orbit") and the row, which stays open, carries the line;
 *   inbox        a removed failed message is done, never "not removed": the
 *                desk's failed entry carries the line, the phone wakes it.
 *
 * A second `Add to orbit` on a standing row would replay the earlier approval
 * (workspace.js approveOnce), never make a second item, so the line's remedy
 * is the reload every one of these ends with: the entry is gone after it.
 */

const households = householdRegister();

/* Playwright does not route a request the service worker handles, and
   nothing here is about the worker: kept out on WebKit, as
   v19-mail-review.spec.ts and v19-feedback-recovery.spec.ts do (#1219, #1233). */
test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
  },
});

const isPocket = () => test.info().project.name.startsWith("mobile");

/** `landed.js`'s words for a command that landed whose re-read failed. */
const DONE = /^done —.*reload/i;
const APPROVAL_FAILED = /could not complete the request/;
const INTERNAL_ERROR = { error: { code: "internal_error", message: "Orbit could not complete the request" } };

type MailOptions = {
  /** The synthetic receipt is a failed message the reader may remove, not a suggestion. */
  failed?: boolean;
  /** The approve answers 500 once (feedback-recovery's shape); every later one lands. */
  approveRefusedOnce?: boolean;
  /** The first `/api/workspace` read after the decision landed answers 500, then reads pass through. */
  failReadAfterLanding?: boolean;
};

/**
 * One synthetic receipt on the reader's household, as v19-mail-review.spec.ts
 * and v19-feedback-recovery.spec.ts intercept it. Once the decision lands
 * (`approved` / `removed`) the inbox answers no receipts, so a reload shows
 * the entry gone; the workspace read is failed once, right after that.
 */
async function interceptMail(page: Page, household: Household, options: MailOptions = {}) {
  const receiptId = randomUUID();
  const attachmentId = randomUUID();
  const title = `Mailed renewal ${receiptId.slice(0, 8)}`;
  let approvals = 0;
  let removals = 0;
  let landed = false;
  let workspaceReads = 0;
  let workspaceFailures = 0;

  const attachment = { id: attachmentId, ordinal: 1, displayName: "schedule.pdf", mediaType: "application/pdf", sizeBytes: 128, scanState: "clean" };
  const base = {
    id: receiptId,
    householdId: household.id,
    draftVersion: 1,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    receivedAt: new Date().toISOString(),
  };
  const receipt = options.failed
    ? {
        ...base,
        status: "failed",
        classification: "failed",
        reason: "no_document",
        attachmentCount: 0,
        canApprove: false,
        canDiscard: true,
        message: "It carried no document Orbit can read. Nothing was kept.",
      }
    : {
        ...base,
        status: "pending_review",
        attachmentCount: 1,
        classification: "ready",
        canApprove: true,
        canDiscard: true,
        message: "Ready for your review.",
        proposal: { title, provider: "Synthetic Cover", costMinor: 9900, currency: "GBP", dueDate: "2031-03-01", scheduleKind: "renewal", kind: "renewal", recurrenceMonths: 12 },
        fieldEvidence: { title: { source: "parser", confidence: "medium" } },
        attachments: [attachment],
      };

  await page.route("**/api/imap-inbox", (route) =>
    route.fulfill({ json: { receipts: landed ? [] : [receipt], households: [{ id: household.id, name: household.name, currency: "GBP" }] } }));
  await page.route(`**/api/imap-inbox/${receiptId}*`, (route) => {
    if (route.request().method() === "DELETE") {
      removals += 1;
      landed = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { receipt, sections: [{ id: household.sectionId, name: "Home" }], candidates: [], attachments: [attachment] } });
  });
  await page.route("**/api/reviewed-intake/approve", (route) => {
    approvals += 1;
    if (options.approveRefusedOnce && approvals === 1) return route.fulfill({ status: 500, json: INTERNAL_ERROR });
    landed = true;
    return route.fulfill({ json: { outcome: "approved", itemId: null } });
  });
  if (options.failReadAfterLanding) {
    await page.route("**/api/workspace", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      workspaceReads += 1;
      if (landed && workspaceFailures === 0) {
        workspaceFailures += 1;
        return route.fulfill({ status: 500, json: INTERNAL_ERROR });
      }
      return route.continue();
    });
  }
  return {
    receiptId,
    title,
    approvals: () => approvals,
    removals: () => removals,
    workspaceFailures: () => workspaceFailures,
    workspaceReads: () => workspaceReads,
  };
}

/** Open the suggestion where the dialect decides it, and press Add to orbit twice. Returns the place its line shows. */
async function approveFromHome(page: Page, mail: { receiptId: string; title: string }) {
  if (isPocket()) {
    /* The phone opens the suggestion's row; home's first view is read on the
       server, which the route mock never reaches, so by its address nothing
       opens (v19-feedback-recovery.spec.ts). */
    await page.goto("/home");
    const row = page.locator(`.pocket .pk-signals [data-row-key="${mail.receiptId}"]`);
    await expect(row.locator("[data-row-face]")).toBeVisible({ timeout: 30_000 });
    await row.locator("[data-row-face]").click();
    /* The pill's name is "Add <title> to your orbit", then "tap again to add ..." once armed. */
    const pill = row.getByRole("button", { name: new RegExp(`add ${mail.title} to your orbit$`, "i") }).filter({ visible: true });
    await expect(pill).toBeEnabled({ timeout: 30_000 });
    await pill.click();
    await pill.click();
    return row;
  }
  await page.goto(`/home?item=${mail.receiptId}`);
  const drawer = page.locator(`[id="${mail.receiptId}-view"]`);
  const add = drawer.getByRole("button", { name: "Add to orbit" });
  await expect(add).toBeEnabled({ timeout: 30_000 });
  await add.click();
  await drawer.getByRole("button", { name: "tap again to approve" }).click();
  return drawer;
}

/** The wake's polite region, filtered to words. */
const woken = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

async function withMail(page: Page, prefix: string, options: MailOptions, body: (mail: Awaited<ReturnType<typeof interceptMail>>) => Promise<void>) {
  test.setTimeout(120_000);
  await signIn(page, "/home");
  const household = households.track(await seedHousehold(page, prefix));
  try {
    await body(await interceptMail(page, household, options));
  } finally {
    await unrouteAndSweep(page, households);
  }
}

test("home desk: a landed approve whose re-read fails shows the done line on the row, buttons at rest", async ({ page }) => {
  test.skip(isPocket(), "the desk drawer; the phone's row is the next test");
  await withMail(page, "mail-unread-desk", { failReadAfterLanding: true }, async (mail) => {
    const drawer = await approveFromHome(page, mail);
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
    await expect(page.locator(".item.suggest", { hasText: mail.title })).toHaveCount(0, { timeout: SETTLE });
    await expect(page.locator(`[id="${mail.receiptId}-view"]`)).toHaveCount(0);
  });
});

test("home phone: a landed approve whose re-read fails is woken as done and the row shows the done line", async ({ page }) => {
  test.skip(!isPocket(), "the phone's row; the desk's drawer is the previous test");
  await withMail(page, "mail-unread-phone", { failReadAfterLanding: true }, async (mail) => {
    const row = await approveFromHome(page, mail);
    await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(1);
    await expect.poll(mail.workspaceFailures, { timeout: SETTLE }).toBe(1);

    /* The decision landed, so it is woken as done... */
    await expect(woken(page, `${mail.title} added to your orbit`)).toHaveCount(1, { timeout: SETTLE });
    /* ...and the row, which stays, carries the line under it. */
    await expect(row).toHaveAttribute("data-open", "");
    await expect(row.locator("[role=alert]")).toHaveText(DONE);
    expect(mail.approvals()).toBe(1);
  });
});

test("inbox: a landed remove of a failed message whose re-read fails is done, not 'not removed'", async ({ page }) => {
  await withMail(page, "mail-unread-inbox", { failed: true, failReadAfterLanding: true }, async (mail) => {
    await page.goto("/inbox");
    if (isPocket()) {
      const row = page.locator(`.pk-inbox [data-row-key="${mail.receiptId}"]`);
      await expect(row.locator("[data-row-face]")).toBeVisible({ timeout: 30_000 });
      await row.locator("[data-row-face]").click();
      const pill = row.getByRole("button", { name: /remove the message from/i }).filter({ visible: true });
      await expect(pill).toBeEnabled({ timeout: 30_000 });
      await pill.click();
      await pill.click();
      await expect.poll(mail.removals, { timeout: SETTLE }).toBe(1);
      await expect.poll(mail.workspaceFailures, { timeout: SETTLE }).toBe(1);
      /* The row has no line of its own, so the phone wakes it. */
      await expect(woken(page, DONE)).toHaveCount(1, { timeout: SETTLE });
    } else {
      const entry = page.locator(".inbox-page .failed").filter({ visible: true });
      await expect(entry).toBeVisible({ timeout: 30_000 });
      await entry.getByRole("button", { name: "remove" }).click();
      await entry.getByRole("button", { name: "tap again to remove" }).click();
      await expect.poll(mail.removals, { timeout: SETTLE }).toBe(1);
      await expect.poll(mail.workspaceFailures, { timeout: SETTLE }).toBe(1);
      await expect(entry.locator(".mail-problem")).toHaveText(DONE, { timeout: SETTLE });
    }
    /* Removed is removed: nobody is told it was not. */
    await expect(page.getByText(/not removed/)).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("It carried no document Orbit can read")).toHaveCount(0, { timeout: SETTLE });
    await expect(page.locator(`[data-row-key="${mail.receiptId}"], .inbox-page .failed`)).toHaveCount(0, { timeout: SETTLE });
  });
});

test("guard: a refused approve still shows the refusal, with no done line and no wake (passes today)", async ({ page }) => {
  await withMail(page, "mail-unread-guard", { approveRefusedOnce: true }, async (mail) => {
    const place = await approveFromHome(page, mail);
    await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(1);

    await expect(place.getByText(APPROVAL_FAILED).first()).toBeVisible({ timeout: SETTLE });
    await expect(place.getByText(/done —/)).toHaveCount(0);
    await expect(woken(page, /added to your orbit/)).toHaveCount(0);
    expect(mail.workspaceFailures()).toBe(0);
  });
});
