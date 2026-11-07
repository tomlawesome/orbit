import { expect, test } from "@playwright/test";

import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, onPhone, settle } from "./a11y-support.js";
import { FIRST_SECTION_ID, SUGGESTION, rememberMailDecisions } from "./mail-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #434, #1145, #1155, #1319, moved to the rig (ADR-0039, #1610): mail-in review
 * on the v19 surfaces -- the manifest row's two-tap approve (idempotent under
 * retry), amend-then-accept in home's drawer, a two-tap dismissal with arrived-
 * but-unreadable mail visible on the relay, and a staged paper's page one.
 *
 * Every test starts from the fixture inbox: the approvable "Home insurance
 * renewal" receipt (r-insurance, one attachment, policy-schedule.pdf) and the
 * two failed messages. The test's own decisions -- the approval, the dismissal,
 * the assignment of the receipt to a household that comes before an approval --
 * are answered by `rememberMailDecisions` (mail-support.js), because the
 * fixture server persists nothing; a staged paper's preview that the mail has
 * outlived is the test's own fault, injected where it is read.
 *
 * Playwright does not route a request the service worker handles (its own
 * documentation says to block service workers wherever routing is relied on),
 * and nothing here is about the worker, so it is kept out on every engine.
 *
 * Left on the stack, in tests/e2e/v19-mail-review.spec.ts: "the proving ground's
 * landing item is seeded with a kind the engine accepts (#1316)". It pins the
 * stack's own seed against the engine's 422 item_kind_missing; the rig has no
 * seed. Survey verdict I1: a test for the Vitest integration project (#1612),
 * left untouched here.
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

const { id: RECEIPT, title: TITLE, provider: PROVIDER, attachmentId: ATTACHMENT, attachmentName: PAPER } = SUGGESTION;
/** What the fixture receipt proposes, as an approval of it as proposed carries
 *  it (workspace.js approvalItemOf: the cost in minor units, no kind). */
const PROPOSED = {
  title: TITLE, provider: PROVIDER, costMinor: 40000, currency: "GBP", dueDate: "2026-10-03",
  scheduleKind: "renewal", recurrenceMonths: 12,
};
/** The same once the reader has amended it: the rows send the kind, and the
 *  cost as typed (checked on its own with `costSent`). */
const AMENDED = {
  title: TITLE, provider: PROVIDER, currency: "GBP", dueDate: "2026-10-03",
  scheduleKind: "renewal", recurrenceMonths: 12,
};

/** The cost an approval sent: as typed (`cost`, read by the engine, #1325) or
 *  in minor units.
 * @param {Record<string, any>} approval */
function costSent(approval) {
  return approval.item.cost ?? approval.item.costMinor;
}

/** Home, live: the desk's manifest row or the phone's signals row is there.
 * @param {Page} page */
async function openHome(page) {
  await page.goto("/home");
  await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
  await settle(page);
}

test("the manifest row approves in two taps, idempotently under partial success", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the desk's drawer; the phone's row arms through its own pill (amend test below, v19-feedback-recovery)");
  const mail = await rememberMailDecisions(page, {
    /* The first answer is partial: the item is recorded, its documents need
       another try (ApprovalOutcome's own `itemId` is a plain string -- the item
       is created before a partial transfer can fail, so the retry names the
       same one, SQ2-Q2 #1151). */
    answer: (n) => (n === 1 ? { json: { outcome: "partial_success", itemId: "i-mailed-renewal" } } : null),
  });
  await openHome(page);
  const row = page.locator(".item.suggest", { hasText: TITLE });
  await expect(row.first()).toBeVisible();
  /* #1145: the two decisions live in the drawer the row opens into, like a
     filed item's detail -- the row at rest carries none. */
  await row.first().click();
  const drawer = page.locator(`[id="${RECEIPT}-view"]`);
  await expect(drawer).toBeVisible();
  const approve = drawer.getByRole("button", { name: "Add to orbit" });

  // One stray click does nothing but arm.
  await approve.click();
  await expect(drawer.getByRole("button", { name: "tap again to approve" })).toBeVisible();
  expect(mail.approvals.length).toBe(0);

  // The second tap fires; the first answer is partial, so the drawer says so.
  await drawer.getByRole("button", { name: "tap again to approve" }).click();
  await expect.poll(() => mail.approvals.length).toBe(1);
  await expect(drawer.locator(".mail-problem")).toContainText("The item is recorded, but its documents need another try — try once more to finish.");

  // The retry carries the SAME operation id and the SAME body: one item, ever.
  await drawer.getByRole("button", { name: "tap again to approve" }).click();
  await expect.poll(() => mail.approvals.length).toBe(2);
  expect(mail.approvals[1]).toEqual(mail.approvals[0]);
  expect(mail.approvals[0]).toMatchObject({
    source: { kind: "mailbox_draft", receiptId: RECEIPT, draftVersion: 1 },
    householdId: "hh-harlow-1",
    sectionId: FIRST_SECTION_ID,
    action: "create_separate",
    item: PROPOSED,
    attachmentIds: [ATTACHMENT],
  });
  // Approved: the suggestion leaves the manifest.
  await expect(page.locator(".item.suggest", { hasText: TITLE })).toHaveCount(0);
});

/* #1319 (owner-decisions §34): a suggestion is reviewed in its home drawer, not
   on the belt, which retired. On both, the drawer shows what the relay read and
   how sure it was; `review & amend →` puts the suggestion's own rows into
   editing (the title in the row's head), and `add to orbit` approves what they
   hold. This took over "amend then accept from the item view", the belt's card
   and the phone's review sheet. */
test("amend then accept from home's drawer", async ({ page }, testInfo) => {
  const pocket = onPhone(testInfo);
  const mail = await rememberMailDecisions(page);
  await openHome(page);
  /* The drawer: the phone's open row, or the desk's view under its row. */
  let drawer;
  if (pocket) {
    drawer = page.locator(`.pocket .pk-signals [data-row-key="${RECEIPT}"]`);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    await drawer.locator("[data-row-face]").click();
    await expect(drawer).toHaveAttribute("data-open", "");
  } else {
    const row = page.locator(".item.suggest", { hasText: TITLE }).first();
    await expect(row).toBeVisible();
    await row.click();
    drawer = page.locator(`[id="${RECEIPT}-view"]`);
    await expect(drawer).toBeVisible();
  }
  /* What the relay read, and how sure it was where the receipt says
     (readingsOf, lib/pocket/review.js): the fixture receipt read the provider
     with high confidence and the cost with low. */
  const reading = (/** @type {string} */ label) =>
    drawer.locator(pocket ? ".p-kv" : ".kv", { has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) });
  await expect(reading("provider")).toContainText(PROVIDER);
  await expect(reading("provider").locator("i")).toHaveText("sure");
  await expect(reading("cost").locator("i")).toHaveText("unsure");

  await drawer.getByRole("button", { name: "review & amend →" }).click();
  /* the title edits in the row's head, the rest in the drawer's rows */
  const title = pocket ? drawer.locator('[data-ed="title"]') : page.locator(`[id="${RECEIPT}"] [data-ed="title"]`);
  await expect(title).toHaveText(TITLE);
  await expect(title).toBeFocused();
  await expect(drawer.locator('[data-ed="provider"]')).toHaveText(PROVIDER);
  /* the relay's sure/unsure marks are put away while the rows are live */
  await expect(drawer.getByText("unsure")).toHaveCount(0);
  await title.fill("Home insurance, corrected");
  await drawer.locator('[data-ed="cost"]').fill("199.99");
  const amending = drawer.getByRole("group", { name: `Amending ${TITLE}` });
  await expect(amending.getByRole("button")).toHaveText(["add to orbit", "cancel"]);
  await amending.getByRole("button", { name: "add to orbit", exact: true }).click();

  await expect.poll(() => mail.approvals.length).toBe(1);
  expect(mail.approvals[0]).toMatchObject({
    source: { kind: "mailbox_draft", receiptId: RECEIPT, draftVersion: 1 },
    householdId: "hh-harlow-1",
    sectionId: FIRST_SECTION_ID,
    action: "create_separate",
    item: { ...AMENDED, title: "Home insurance, corrected" },
    attachmentIds: [ATTACHMENT],
  });
  // The drawer's rows send the cost as typed, for the engine to read (ADR-0034, #1325).
  expect(costSent(mail.approvals[0])).toBe("199.99");
  /* Added: the suggestion leaves home, and home stays where it is. (The belt
     used to land on the created item; the drawer stays on home.) */
  await expect(page.locator(pocket ? ".pocket .pk-signals [data-row]" : ".item.suggest", { hasText: TITLE })).toHaveCount(0);
  await expect(page).toHaveURL(/\/home/);
});

/* G-B4-1 (#1671): a reading the relay gave no evidence for draws no sure/unsure mark
   (review.js readingsOf: no evidence is null, not "sure"). The fixture receipt has
   evidence for every reading it makes, so this one adds a reference with none. */
test("a reading with no evidence draws no sure or unsure mark", async ({ page }, testInfo) => {
  const pocket = onPhone(testInfo);
  await rememberMailDecisions(page);
  await page.route("**/api/imap-inbox", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.receipts = body.receipts.map((/** @type {Record<string, any>} */ one) =>
      one.id === RECEIPT ? { ...one, proposal: { ...one.proposal, reference: "POL-77120" } } : one);
    return route.fulfill({ response, json: body });
  });
  await openHome(page);
  let drawer;
  if (pocket) {
    drawer = page.locator(`.pocket .pk-signals [data-row-key="${RECEIPT}"]`);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    await drawer.locator("[data-row-face]").click();
    await expect(drawer).toHaveAttribute("data-open", "");
  } else {
    const row = page.locator(".item.suggest", { hasText: TITLE }).first();
    await expect(row).toBeVisible();
    await row.click();
    drawer = page.locator(`[id="${RECEIPT}-view"]`);
    await expect(drawer).toBeVisible();
  }
  const reading = (/** @type {string} */ label) =>
    drawer.locator(pocket ? ".p-kv" : ".kv", { has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) });
  await expect(reading("reference")).toContainText("POL-77120");
  await expect(reading("reference").locator("i")).toHaveCount(0);
  // The readings that do have evidence keep their marks.
  await expect(reading("provider").locator("i")).toHaveText("sure");
});

test("a dismissal takes two taps and mail that failed is visible on the relay", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the desk's drawer; the phone's row dismisses through the inbox lane (pocket-inbox)");
  const mail = await rememberMailDecisions(page);
  await openHome(page);
  const row = page.locator(".item.suggest", { hasText: TITLE }).first();
  await expect(row).toBeVisible();
  /* #1145: the dismissal lives in the drawer the row opens into, as the approve
     test above; the row at rest carries no buttons. */
  await row.click();
  const drawer = page.locator(`[id="${RECEIPT}-view"]`);
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Dismiss" }).click();
  await expect(drawer.getByRole("button", { name: "tap again to dismiss" })).toBeVisible();
  expect(mail.removals).toEqual([]);
  await drawer.getByRole("button", { name: "tap again to dismiss" }).click();
  await expect.poll(() => mail.removals).toEqual([RECEIPT]);
  await expect(page.locator(".item.suggest", { hasText: TITLE })).toHaveCount(0);

  // The failed messages are on the relay, dated, in the server's own words.
  await page.goto("/settings/mail");
  await expect(page.locator(".failures")).toContainText("arrived, but could not be read");
  await expect(page.locator(".failures")).toContainText("It carried no document Orbit can read");
  await expect(page.locator(".failures")).toContainText("06 Aug");
});

/* #1155, #1319: a staged paper opens the preview card beside the suggestion's
   home drawer (it used to open the belt's reading card), and the inbox's paper
   chip leads to that drawer. */
test("the desk reads a staged paper's page one, from the suggestion's drawer and from the inbox chip (#1155)", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the desk's preview card; the phone's sheet is the test below");
  await rememberMailDecisions(page);

  await page.goto(`/home?item=${RECEIPT}`);
  const drawer = page.locator(`[id="${RECEIPT}-view"]`);
  await expect(drawer).toBeVisible({ timeout: SETTLE });
  await drawer.getByRole("button", { name: `Open ${PAPER}` }).click();

  const card = page.getByRole("dialog", { name: PAPER });
  await expect(card).toHaveClass(/snap/, { timeout: SETTLE });
  await expect(card.getByRole("img")).toHaveAttribute("alt", `Page one of ${PAPER}`);
  await expect(card.locator(".rcfoot .rcnote")).toHaveText("not yet in orbit · attached on acceptance");
  // No download for a staged paper: the foot carries the note, never a link.
  await expect(card.locator(".rcfoot a")).toHaveCount(0);

  // The chip is a second door, into the same drawer (§8, §10).
  await page.goto("/inbox");
  await page.getByRole("link", { name: new RegExp(PAPER.replace(".", "\\.")) }).click();
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${RECEIPT}$`));
  await expect(drawer).toBeVisible({ timeout: SETTLE });
  await expect(drawer.getByRole("button", { name: `Open ${PAPER}` })).toBeVisible();
});

test("the phone sheet reads a staged paper's page one, and tells a gone mail apart from one it just cannot draw (#1155)", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "the pocket paper sheet is phone-only; see the desk test above");
  await rememberMailDecisions(page);

  await page.goto("/inbox");
  const chip = page.getByRole("button", { name: new RegExp(PAPER.replace(".", "\\.")) });
  await expect(chip).toBeVisible({ timeout: SETTLE });
  await chip.click();
  const dialog = page.getByRole("dialog", { name: PAPER });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img")).toHaveAttribute("alt", `Page one of ${PAPER}`);
  await expect(dialog).toContainText("not yet in orbit · attached on acceptance");
  await dialog.getByRole("button", { name: "close" }).click();
  await expect(dialog).not.toBeVisible();

  // The mail is decided or burns up between the lane listing it and the
  // preview answering: the sheet must say so plainly, never "could not draw".
  await page.route(`**/api/imap-inbox/${RECEIPT}/attachments/${ATTACHMENT}/preview`, (route) =>
    route.fulfill({ status: 404, json: { error: { code: "inbox_receipt_not_found", message: "That incoming document is not available" } } }));
  await chip.click();
  const reopened = page.getByRole("dialog", { name: PAPER });
  await expect(reopened).toContainText("This mail has gone.");
});
