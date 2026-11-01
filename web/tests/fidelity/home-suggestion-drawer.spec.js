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
 * 3b. What the belt's card was proved to do is proved here of the drawer:
 * its address `/home?item=<id>` opens it, the staged paper opens the preview beside
 * it, the proposal is amended in the drawer's own rows and accepted, and
 * dismiss takes two presses.
 *
 * What is proved here is what the drawer does, not how it looks
 * (screens.spec.js holds the manifest's own baseline). The fixture API
 * answers reads only, so the writes a decision makes are answered here and
 * read back: that is the assertion. Same harness as pocket-inbox.spec.js,
 * at the desk the gate itself judges at.
 */
test.use({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });

const ROW = "a.item.suggest";
const DRAWER = '[id="r-insurance-view"]';

/**
 * Answers the three calls approveReceipt makes and records the approval.
 * @param {import("@playwright/test").Page} page
 */
async function answerApproval(page) {
  /** @type {{ approvals: any[], discards: string[] }} */
  const seen = { approvals: [], discards: [] };
  await page.route("**/api/imap-inbox/r-*", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (request.method() === "DELETE") {
      seen.discards.push(id);
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      json: {
        receipt: { id, draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
      },
    });
  });
  await page.route("**/api/reviewed-intake/approve", async (route) => {
    seen.approvals.push(route.request().postDataJSON());
    await route.fulfill({ json: { outcome: "approved", itemId: "i-new" } });
  });
  return seen;
}

/** @param {import("@playwright/test").Page} page */
async function openHome(page) {
  await page.goto(`${APP}/home`, { waitUntil: "networkidle" });
  await expect(page.locator(ROW, { hasText: "Home insurance renewal" })).toBeVisible();
}

test("the row at rest carries no decisions; it opens in place into the drawer, and the address follows", async ({ page }) => {
  await openHome(page);
  const row = page.locator(ROW, { hasText: "Home insurance renewal" });
  /* What the owner showed: the hollow mark, the title, the found-in line. */
  await expect(row.locator(".planet.sug")).toBeVisible();
  await expect(row.locator(".body span")).toHaveText("Found in 1 forwarded document · renews 03 Oct · ~£400.00");
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(page.locator(DRAWER)).toHaveCount(0);

  await row.click();
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/\/home\?item=r-insurance$/);

  /* The relay's readings, each with how sure it was; when it burns up. */
  const kv = (/** @type {string} */ label) => drawer.locator(".kv", { has: page.locator(`span:text-is("${label}")`) });
  await expect(kv("provider").locator("b")).toContainText("Harbour Mutual");
  await expect(kv("provider").locator("i.sure")).toHaveText("sure");
  await expect(kv("renews").locator("b")).toContainText("03 Oct 2026");
  await expect(kv("cost").locator("b")).toContainText("~£400.00");
  await expect(kv("cost").locator("i.sure")).toHaveText("unsure");
  await expect(kv("burns up").locator("b")).toHaveText("in 43d · 25 September 2026");
  /* The paper it came in, attached only on acceptance. */
  await expect(drawer.locator(".doc")).toContainText("policy-schedule.pdf");
  await expect(drawer.locator(".doc small")).toHaveText("attached on acceptance");
  /* The two decisions, and the foot: the way to amend it, here (#1319). */
  await expect(drawer.getByRole("button", { name: "Add to orbit" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "copy link" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "review & amend →" })).toBeVisible();
  /* Nothing about a suggestion links to the retired item screen. */
  await expect(drawer.locator('a[href^="/item"]')).toHaveCount(0);
  /* Nothing here promises anything (owner's 10b); the acts are the promise. */
  await expect(drawer.getByText("nothing is created")).toHaveCount(0);

  /* Escape closes it, as it closes a filed row's drawer. */
  await page.keyboard.press("Escape");
  await expect(page.locator(DRAWER)).toHaveCount(0);
  await expect(page).toHaveURL(/\/home$/);
});

test("Add to orbit arms on the first click and approves on the second, from the drawer", async ({ page }) => {
  const seen = await answerApproval(page);
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "Add to orbit" }).click();
  await expect(drawer.getByRole("button", { name: "tap again to approve" })).toBeVisible();
  expect(seen.approvals).toHaveLength(0);
  await drawer.getByRole("button", { name: "tap again to approve" }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  expect(seen.approvals[0]).toMatchObject({
    sectionId: "s-home", action: "create_separate", attachmentIds: ["a-1"],
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
  });
});

test("Dismiss arms on the first click and discards on the second, from the drawer", async ({ page }) => {
  const seen = await answerApproval(page);
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "Dismiss" }).click();
  await expect(drawer.getByRole("button", { name: "tap again to dismiss" })).toBeVisible();
  expect(seen.discards).toHaveLength(0);
  await drawer.getByRole("button", { name: "tap again to dismiss" }).click();
  await expect.poll(() => seen.discards).toEqual(["r-insurance"]);
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

/* #1319: review & amend puts the drawer's own rows into editing -- the
   title in the row's head, the values live, the choosers beside -- and
   `add to orbit` approves what they hold, as the belt's card did. */
test("review & amend edits the proposal in the rows, and add to orbit approves it amended", async ({ page }) => {
  const seen = await answerApproval(page);
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "review & amend →" }).click();
  /* The decisions give way to add and cancel; the readings to live rows. */
  await expect(drawer.getByRole("button", { name: "Add to orbit", exact: true })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "add to orbit", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "cancel" })).toBeVisible();
  const title = page.locator('[id="r-insurance"] [data-ed="title"]');
  await expect(title).toBeFocused();
  await expect(title).toHaveText("Home insurance renewal");
  await expect(drawer.locator('[data-ed="provider"]')).toHaveText("Harbour Mutual");
  await expect(drawer.locator('[data-ed="cost"]')).toHaveText("£400.00");
  /* The due date's calendar stands beside the drawer, as a filed item's does. */
  await drawer.getByRole("button", { name: /^due: / }).click();
  await expect(page.locator("[data-chooser-card]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-chooser-card]")).toHaveCount(0);
  await title.fill("Home insurance, corrected");
  await drawer.locator('[data-ed="cost"]').fill("199.99");
  await drawer.locator('[data-ed="reference"]').fill("HM-7");
  await drawer.getByRole("button", { name: "add to orbit", exact: true }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  expect(seen.approvals[0]).toMatchObject({
    action: "create_separate", attachmentIds: ["a-1"],
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    /* The rows send the cost as typed, for the engine to read (ADR-0034, #1325). */
    item: { title: "Home insurance, corrected", provider: "Harbour Mutual", reference: "HM-7", cost: "199.99",
      currency: "GBP", dueDate: "2026-10-03", scheduleKind: "renewal", kind: "renewal", recurrenceMonths: 12 },
  });
  /* Added: the drawer goes, and the wake says so. */
  await expect(page.locator(DRAWER)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "added to your orbit" }))
    .toHaveText("added to your orbit · Home insurance, corrected");
});

test("cancel, asked twice over a change, puts the readings back and sends nothing", async ({ page }) => {
  const seen = await answerApproval(page);
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "review & amend →" }).click();
  await drawer.locator('[data-ed="cost"]').fill("1.00");
  /* The rows hold a change, so the first press only asks (84b21c82). */
  await drawer.getByRole("button", { name: "cancel" }).click();
  await drawer.getByRole("button", { name: "discard changes?" }).click();
  await expect(drawer.getByRole("button", { name: "Add to orbit", exact: true })).toBeVisible();
  await expect(drawer.locator(".kv", { has: page.locator('span:text-is("cost")') }).locator("b")).toContainText("~£400.00");
  await expect(drawer.getByRole("button", { name: "review & amend →" })).toBeFocused();
  expect(seen.approvals).toHaveLength(0);
});

/*
 * #1584 web-wr9: a receipt with an earlier approval still pending. The review
 * read reports the pair (#1396), so the approval is that pair sent verbatim.
 * Specs match the replayed wake on the fragment `earlier approval`, never on
 * the whole sentence: the words belong to the seam alone.
 */
const PAIR = {
  operationId: "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a",
  request: {
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    householdId: "hh-harlow-1",
    sectionId: "s-home",
    action: "create_separate",
    item: { kind: "renewal", title: "Home insurance renewal", currency: "GBP" },
    attachmentIds: ["a-1"],
  },
};
const REPLAY_BODY = { ...PAIR.request, operationId: PAIR.operationId };

/**
 * Makes the review read answer the pair. Registered after answerApproval's
 * routes, so it is asked first; every other call falls back to them.
 * @param {import("@playwright/test").Page} page
 * @param {(call: number) => boolean} [reports]  whether the nth review GET reports it (default: all)
 */
async function reportPair(page, reports = () => true) {
  let call = 0;
  await page.route("**/api/imap-inbox/r-*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    call += 1;
    return route.fulfill({
      json: {
        receipt: { id, draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
        ...(reports(call) ? { approval: PAIR } : {}),
      },
    });
  });
}

/** Opens the rows on the suggestion and types the corrected title. @param {import("@playwright/test").Page} page */
async function amendTitle(page) {
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "review & amend →" }).click();
  await page.locator('[id="r-insurance"] [data-ed="title"]').fill("Home insurance, corrected");
  return drawer;
}

test("#1584 web-wr9-3: an amend over a pending pair is replayed, and the wake says so", async ({ page }) => {
  const seen = await answerApproval(page);
  await reportPair(page);
  const drawer = await amendTitle(page);
  await drawer.getByRole("button", { name: "add to orbit", exact: true }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  /* the pair verbatim, not the corrected title */
  expect(seen.approvals[0]).toEqual(REPLAY_BODY);
  expect(seen.approvals[0].item.title).toBe("Home insurance renewal");
  await expect(page.locator(DRAWER)).toHaveCount(0);
  const wake = page.getByRole("status").filter({ hasText: "earlier approval" });
  await expect(wake).toBeVisible();
  await expect(wake).not.toContainText("added to your orbit");
  await expect(page.getByText(/not added/i)).toHaveCount(0);
});

test("#1584 web-wr9-2: a failed re-read after an amended add is done, not 'not added', and the desk says so", async ({ page }) => {
  const seen = await answerApproval(page);
  /* answer the approval, then sink the one home read that follows it */
  await page.route("**/api/reviewed-intake/approve", async (route) => {
    seen.approvals.push(route.request().postDataJSON());
    let sunk = false;
    await page.route("**/api/workspace", (read) => {
      if (sunk) return read.fallback();
      sunk = true;
      return read.abort();
    });
    await route.fulfill({ json: { outcome: "approved", itemId: "i-new" } });
  });
  const drawer = await amendTitle(page);
  await drawer.getByRole("button", { name: "add to orbit", exact: true }).click();
  await expect.poll(() => seen.approvals.length).toBe(1);
  await expect(page.locator(DRAWER)).toHaveCount(0);
  /* The done line is the wake, in place of "added to your orbit": the line
     under the row is drawn only inside the open drawer, which has just left. */
  const wake = page.getByRole("status").filter({ hasText: /^done — / });
  await expect(wake).toHaveText(/^done — .*reload/);
  await expect(page.getByRole("status").filter({ hasText: "added to your orbit" })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "added to your orbit" })).toHaveCount(0);
  /* a plain wake, not a failure */
  await expect(page.getByRole("alert")).toHaveText("");
  await expect(page.getByText(/not added/i)).toHaveCount(0);
  /* The stale row kept its line for a reader who opens it before reloading. */
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const problem = page.locator(DRAWER).locator(".mail-problem");
  await expect(problem).toBeVisible();
  await expect(problem).toHaveText(/^done — .*reload/);
});
