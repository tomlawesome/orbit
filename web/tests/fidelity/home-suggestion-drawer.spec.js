import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1145 (owner, 2026-09-27): "let the suggested items open as a drawer like
 * the manifest items". On the desk home a suggestion row opens IN PLACE, the
 * way a filed row does (#424's shallow address, Back, Escape, click-off),
 * into SuggestionView.svelte: the relay's readings with how sure it was,
 * when it burns up, the paper it came in, the two decisions that used to sit
 * on the row at rest, `copy link` and `review & amend →`.
 *
 * #1319 (owner-decisions §34): a suggestion is reviewed in its home drawer;
 * the belt that seated it at `/item/<receiptId>` (#1145) retired in stage
 * 3b. Its address `/home?item=<id>` opens it, and the staged paper opens the
 * preview beside it.
 *
 * What the drawer shows and what its decisions send is proved in
 * tests/unit/home-suggestion-drawer.test.mjs (ADR-0039, #1613): the row at
 * rest, the readings, the two-press Add and Dismiss, review & amend and its
 * cancel, a replayed pending pair, and a failed re-read after an add. What
 * stays here needs a browser: the address and Back, Escape, where the row and
 * the preview card stand, and real focus with the chooser card. At the desk
 * the gate itself judges at.
 *
 * The unit file mounts the drawer through a copy of the home page's glue
 * (tests/unit/support/SuggestionDrawerHost.svelte), so it cannot see the
 * page's own arming, receipt keying and re-read go wrong. The last run here
 * drives the REAL /home page through Add, Dismiss and an amended add, for
 * that glue alone (#1613 review).
 */
test.use({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });

const ROW = "a.item.suggest";
const DRAWER = '[id="r-insurance-view"]';

/** @param {import("@playwright/test").Page} page */
async function openHome(page) {
  await page.goto(`${APP}/home`, { waitUntil: "networkidle" });
  await expect(page.locator(ROW, { hasText: "Home insurance renewal" })).toBeVisible();
}

test("a suggestion row opens in place into the drawer, the address follows, and Escape closes it", async ({ page }) => {
  await openHome(page);
  const row = page.locator(ROW, { hasText: "Home insurance renewal" });
  await expect(page.locator(DRAWER)).toHaveCount(0);

  await row.click();
  await expect(page.locator(DRAWER)).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/\/home\?item=r-insurance$/);

  /* Escape closes it, as it closes a filed row's drawer. */
  await page.keyboard.press("Escape");
  await expect(page.locator(DRAWER)).toHaveCount(0);
  await expect(page).toHaveURL(/\/home$/);
});

test("the drawer opens from its own address, like a filed row's", async ({ page }) => {
  /* Its address is home's (#1319); the retired belt's `/item/<id>` was
     removed, so nothing redirects here any more. */
  await page.goto(`${APP}/home?item=r-insurance`, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/home\?item=r-insurance$/);
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();
  await expect(page.locator(ROW, { hasText: "Home insurance renewal" })).toHaveAttribute("aria-expanded", "true");
  /* The row is on screen, not off the bottom (#424's own test of the address). */
  const box = await page.locator(ROW, { hasText: "Home insurance renewal" }).boundingBox();
  expect(box, "the suggestion row has no box").not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 9999) + (box?.height ?? 0)).toBeLessThanOrEqual(1000);
});

/* #1319: the paper it came in opens the preview card beside the drawer, as
   a filed item's documents do, page one drawn from the mail's own staging
   (#1155) -- and nothing to download: the foot says why instead. */
test("the staged paper opens the preview beside the drawer, page one showing, nothing to download", async ({ page }) => {
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "Open policy-schedule.pdf" }).click();
  const card = page.locator("[data-preview-card]");
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/snap/);
  await expect(card.locator(".sheet img")).toHaveAttribute("alt", "Page one of policy-schedule.pdf");
  await expect(card.locator(".rcfoot .rcnote")).toHaveText("not yet in orbit · attached on acceptance");
  await expect(card.locator(".rcfoot a")).toHaveCount(0);
  /* Beside the drawer, not over it. */
  const [c, d] = [await card.boundingBox(), await drawer.boundingBox()];
  expect((c?.x ?? 0)).toBeGreaterThanOrEqual((d?.x ?? 0) + (d?.width ?? 0) - 1);
  await expect(drawer.getByRole("button", { name: "Open policy-schedule.pdf" })).toHaveAttribute("aria-current", "true");
  /* Escape takes the card and leaves the drawer open. */
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(drawer).toBeVisible();
});

/* #1319: review & amend puts the drawer's own rows into editing -- the title
   in the row's head, focus on it, the choosers beside -- and cancel gives
   focus back to the way in. What the rows hold and send is in the unit file. */
test("review & amend: focus lands on the title, the due calendar opens beside and Escape takes it, cancel returns focus", async ({ page }) => {
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "review & amend →" }).click();
  const title = page.locator('[id="r-insurance"] [data-ed="title"]');
  await expect(title).toBeFocused();
  /* The due date's calendar stands beside the drawer, as a filed item's does. */
  await drawer.getByRole("button", { name: /^due: / }).click();
  await expect(page.locator("[data-chooser-card]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-chooser-card]")).toHaveCount(0);
  /* Cancel, over a change, asks first and then puts focus back on the way in. */
  await drawer.locator('[data-ed="cost"]').fill("1.00");
  await drawer.getByRole("button", { name: "cancel" }).click();
  await drawer.getByRole("button", { name: "discard changes?" }).click();
  await expect(drawer.getByRole("button", { name: "review & amend →" })).toBeFocused();
});

/**
 * Answers what a decision sends, and takes the receipt out of the inbox read
 * once it has landed, as the relay would. Reads fall through to the fixture.
 * @param {import("@playwright/test").Page} page
 */
async function answerDecisions(page) {
  /** @type {{ approvals: any[], discards: string[], gone: boolean, pair: any, sinkNextWorkspace: boolean, sinkAfterApprove: boolean, landedKeepsRow: boolean }} */
  const seen = { approvals: [], discards: [], gone: false, pair: null, sinkNextWorkspace: false, sinkAfterApprove: false, landedKeepsRow: false };
  await page.route("**/api/imap-inbox/r-*", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (request.method() === "DELETE") {
      seen.discards.push(id);
      seen.gone = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      json: {
        receipt: { id, draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-services" }],
        attachments: [{ id: "a-1" }],
        ...(seen.pair ? { approval: seen.pair } : {}),
      },
    });
  });
  /* a home read sunk as a dropped connection */
  await page.route("**/api/workspace", async (route) => {
    if (!seen.sinkNextWorkspace) return route.fallback();
    seen.sinkNextWorkspace = false;
    return route.abort("failed");
  });
  await page.route("**/api/reviewed-intake/approve", async (route) => {
    seen.approvals.push(route.request().postDataJSON());
    seen.gone = !seen.landedKeepsRow;
    if (seen.sinkAfterApprove) seen.sinkNextWorkspace = true;
    await route.fulfill({ json: { outcome: "approved", itemId: "i-new" } });
  });
  await page.route(/\/api\/imap-inbox(\?.*)?$/, async (route) => {
    try {
      const read = await route.fetch();
      const body = await read.json();
      if (seen.gone) body.receipts = body.receipts.filter((/** @type {{ id: string }} */ one) => one.id !== "r-insurance");
      await route.fulfill({ response: read, json: body });
    } catch {
      /* a read the end of the test cuts off is the end of the test, not a failure of it */
    }
  });
  return seen;
}

/* The real home page's glue for a suggestion (home/+page.svelte): the first
   press arms, the second sends; the decided receipt's row leaves on the re-read;
   an amended add's wake is the suggestion's own title. The unit file proves
   what each sends; this proves the page wires them, so it asserts the page's
   own states and the end state, one run for Add, Dismiss and an amended add. */
test("the real home page: Add and Dismiss arm then send and the row leaves; an amended add says so", async ({ page }) => {
  const seen = await answerDecisions(page);
  const row = page.locator(ROW, { hasText: "Home insurance renewal" });
  const drawer = page.locator(DRAWER);
  await openHome(page);

  /* Add: one press only arms. */
  await row.click();
  await drawer.getByRole("button", { name: "Add to orbit" }).click();
  await expect(drawer.getByRole("button", { name: "tap again to approve" })).toBeVisible();
  expect(seen.approvals).toHaveLength(0);
  await drawer.getByRole("button", { name: "tap again to approve" }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  expect(seen.approvals[0]).toMatchObject({ action: "create_separate", source: { receiptId: "r-insurance" } });
  await expect(row).toHaveCount(0);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("");

  /* Dismiss, on the receipt back in the inbox (a clean address: the last one carried ?item=). */
  seen.gone = false;
  await openHome(page);
  await row.click();
  await drawer.getByRole("button", { name: "Dismiss" }).click();
  await expect(drawer.getByRole("button", { name: "tap again to dismiss" })).toBeVisible();
  expect(seen.discards).toHaveLength(0);
  await drawer.getByRole("button", { name: "tap again to dismiss" }).click();
  await expect.poll(() => seen.discards).toEqual(["r-insurance"]);
  await expect(row).toHaveCount(0);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("");

  /* An amended add: the drawer goes, the row leaves, and the wake names the amended title. */
  seen.gone = false;
  await openHome(page);
  await row.click();
  await drawer.getByRole("button", { name: "review & amend →" }).click();
  await page.locator('[id="r-insurance"] [data-ed="title"]').fill("Home insurance, corrected");
  await drawer.getByRole("button", { name: "add to orbit", exact: true }).click();
  await expect.poll(() => seen.approvals.length).toBe(2);
  expect(seen.approvals[1]).toMatchObject({ item: { title: "Home insurance, corrected" } });
  await expect(drawer).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "added to your orbit" }))
    .toHaveText("added to your orbit · Home insurance, corrected");
  await expect(page.getByRole("alert")).toHaveText("");
});

/*
 * T-F3 (#1671): the two unusual landings of an amended add, on the real page.
 * The unit file proves them against a hand copy of the page's glue
 * (tests/unit/support/SuggestionDrawerHost.svelte); these drive /home itself,
 * so the page's own amendReceipt and re-read are what is judged.
 */
const PAIR = {
  operationId: "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a",
  request: {
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    householdId: "hh-harlow-1",
    sectionId: "s-home",
    action: "create_separate",
    item: { title: "Home insurance renewal", currency: "GBP" },
    attachmentIds: ["a-1"],
  },
};

/** @param {import("@playwright/test").Page} page */
async function amendTitle(page) {
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  await page.locator(DRAWER).getByRole("button", { name: "review & amend →" }).click();
  await page.locator('[id="r-insurance"] [data-ed="title"]').fill("Home insurance, corrected");
  await page.locator(DRAWER).getByRole("button", { name: "add to orbit", exact: true }).click();
}

test("the real home page: an amend over a pending earlier approval is replayed, and the wake says so", async ({ page }) => {
  const seen = await answerDecisions(page);
  seen.pair = PAIR;
  await openHome(page);
  await amendTitle(page);

  await expect.poll(() => seen.approvals.length).toBe(1);
  /* the pair verbatim, not the corrected title */
  expect(seen.approvals[0]).toEqual({ ...PAIR.request, operationId: PAIR.operationId });
  await expect(page.locator(DRAWER)).toHaveCount(0);
  const status = page.getByRole("status").filter({ hasText: "earlier approval" });
  await expect(status).toBeVisible();
  await expect(status).not.toContainText("added to your orbit");
  await expect(page.getByRole("alert")).toHaveText("");
  await expect(page.locator("body")).not.toContainText(/not added/i);
});

test("the real home page: a failed re-read after an amended add is done, not 'not added', and the row says so", async ({ page }) => {
  const seen = await answerDecisions(page);
  /* the receipt stays in the inbox read, as a stale row does when the re-read never arrives */
  seen.landedKeepsRow = true;
  await openHome(page);
  /* the one home read that follows the approval is sunk */
  seen.sinkAfterApprove = true;
  await amendTitle(page);

  await expect.poll(() => seen.approvals.length).toBe(1);
  await expect(page.locator(DRAWER)).toHaveCount(0);
  const status = page.getByRole("status").filter({ hasText: /^done — .*reload/ });
  await expect(status).toBeVisible();
  await expect(status).not.toContainText("added to your orbit");
  await expect(page.getByRole("alert")).toHaveText("");
  await expect(page.locator("body")).not.toContainText(/not added/i);
  /* The stale row kept its line for a reader who opens it before reloading. */
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  await expect(page.locator(DRAWER).locator(".mail-problem")).toHaveText(/^done — .*reload/);
});
