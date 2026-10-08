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
 * #1319 (owner-decisions §34): a suggestion is reviewed in its home drawer,
 * not on the belt. What belt-suggestion.spec.js proved of the belt's card is
 * proved here of the drawer: the staged paper opens the preview beside it,
 * and the proposal is amended in the drawer's own rows and accepted.
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
  /* Nothing about a suggestion goes to the belt any more. */
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
  await page.goto(`${APP}/home?item=r-insurance`, { waitUntil: "networkidle" });
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
    item: { title: "Home insurance, corrected", provider: "Harbour Mutual", reference: "HM-7", costMinor: 19999,
      currency: "GBP", dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12 },
  });
  /* Added: the drawer goes, and the wake says so. */
  await expect(page.locator(DRAWER)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "added to your orbit" }))
    .toHaveText("added to your orbit · Home insurance, corrected");
});

test("cancel puts the readings back and sends nothing", async ({ page }) => {
  const seen = await answerApproval(page);
  await openHome(page);
  await page.locator(ROW, { hasText: "Home insurance renewal" }).click();
  const drawer = page.locator(DRAWER);
  await drawer.getByRole("button", { name: "review & amend →" }).click();
  await drawer.locator('[data-ed="cost"]').fill("1.00");
  await drawer.getByRole("button", { name: "cancel" }).click();
  await expect(drawer.getByRole("button", { name: "Add to orbit", exact: true })).toBeVisible();
  await expect(drawer.locator(".kv", { has: page.locator('span:text-is("cost")') }).locator("b")).toContainText("~£400.00");
  await expect(drawer.getByRole("button", { name: "review & amend →" })).toBeFocused();
  expect(seen.approvals).toHaveLength(0);
});
