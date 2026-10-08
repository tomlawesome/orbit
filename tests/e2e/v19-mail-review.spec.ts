import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister, unrouteAndSweep } from "./support/households";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #434: mail-in review on the v19 surfaces — the manifest row's two-tap
 * approve (idempotent under retry), amend-then-accept in the item view, and
 * arrived-but-unreadable mail visible on the relay. Synthetic receipts ride
 * route interception exactly as the Next inbox spec does, so approval
 * payloads are asserted without pre-approval mutation.
 */
const receiptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const sectionId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const attachmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";

/* #730: every test here seeds its own proving ground and removes it again,
   so none of the three is left in the sky a later spec measures.

   The name carries a per-test suffix because these three tests run in
   PARALLEL locally (playwright.config.ts sets fullyParallel with workers
   undefined off CI, so one worker per core). A shared fixed name meant three
   concurrent creates of the same household, and -- once cleanup existed -- one
   worker hard-deleting the household another was still using. CI never showed
   it because CI pins workers to 1. Nothing asserts the name; it is only used
   to create and to sweep. */
const HOUSEHOLD_PREFIX = "Mail Proving Ground";
const households = householdRegister();

/* #1219: interceptMail is `page.route`, and Playwright does not route a
   request the service worker handles (its documentation says to block
   service workers wherever routing is relied on). On desktop-webkit the
   `page.goto("/home")` after sign-in loads a page Orbit's worker controls,
   so `/api/imap-inbox` reached the real, empty inbox and the synthetic row
   never drew (pipeline 2131; #1196 measured the same gap). Nothing here is
   about the worker, so on that project it is kept out. Desktop only: the
   phone project's two #1196 `fail` marks below stand until that issue is
   taken up, and Chromium and Firefox already route these requests. */
test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.name === "desktop-webkit" ? "block" : "allow");
  },
});

async function signInToHome(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  /* #1080: the sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
}

async function seedHousehold(page: Page): Promise<{ householdId: string; itemId: string }> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async (householdName) => {
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
    const homeSection = crypto.randomUUID();
    await command({
      type: "household.create",
      household: {
        id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: homeSection, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    await command({
      type: "item.upsert",
      householdId,
      item: { id: itemId, sectionId: homeSection, title: "Reviewed intake landing", currency: "GBP", status: "active" },
      activity: { id: crypto.randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { householdId, itemId };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

function readyReceipt(householdId: string) {
  return {
    id: receiptId,
    status: "pending_review",
    householdId,
    draftVersion: 3,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    receivedAt: new Date().toISOString(),
    attachmentCount: 1,
    classification: "ready",
    canApprove: true,
    canDiscard: true,
    cleanupOnly: false,
    message: "Ready for your review.",
    proposal: { title: "Reviewed intake 1786823446152", provider: "Reviewed Cover", costMinor: 12550, currency: "GBP", dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12 },
    fieldEvidence: { title: { source: "parser", confidence: "medium" }, costMinor: { source: "parser", confidence: "low" } },
    // #1155: the list answers the same named shape the detail route does, so
    // the belt's staged paper (and the inbox chip) has a page to press into.
    attachments: [{
      id: attachmentId, ordinal: 1, displayName: "policy-schedule.pdf",
      mediaType: "application/pdf", sizeBytes: 128, scanState: "clean",
    }],
  };
}

async function interceptMail(
  page: Page,
  householdId: string,
  approvals: Record<string, unknown>[],
  options: { firstPartial?: boolean; approvedItemId?: string } = {},
) {
  let approved = false;
  const receipt = readyReceipt(householdId);
  // SQ2-Q2 (#1151): ApprovalOutcome's own `itemId` field is a plain
  // `string`, never optional or nullable (src/server/reviewed-intake.ts) --
  // the item is created before a partial transfer can fail, so even a
  // `partial_success` answer always names it ("never a second item" on
  // retry, same id both times). A null here could never come from the real
  // route.
  const itemId = options.approvedItemId ?? randomUUID();
  await page.route("**/api/imap-inbox", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipts: approved ? [] : [receipt], households: [{ id: householdId, name: "Mail Proving Ground", currency: "GBP" }] }) });
  });
  await page.route(`**/api/imap-inbox/${receiptId}*`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        receipt,
        sections: [{ id: sectionId, name: "Documents" }],
        candidates: [],
        attachments: [{
          id: attachmentId, ordinal: 1, displayName: "policy-schedule.pdf",
          mediaType: "application/pdf", sizeBytes: 128, scanState: "clean",
        }],
      }),
    });
  });
  // #1155: a small, real PNG for the staged attachment's own preview route,
  // so the belt's reading card, the inbox chip and the phone sheet all have
  // a real page to land, not a stub standing in for one.
  const stagedPagePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route(`**/api/imap-inbox/${receiptId}/attachments/${attachmentId}/preview`, async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: stagedPagePng });
  });
  await page.route("**/api/reviewed-intake/approve", async (route) => {
    approvals.push(route.request().postDataJSON() as Record<string, unknown>);
    if (options.firstPartial && approvals.length === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "partial_success", itemId }) });
      return;
    }
    approved = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "approved", itemId }) });
  });
}

test("the manifest row approves in two taps, idempotently under partial success", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket dialect has no suggestion rows yet (#434 follow-up)");
  await signInToHome(page);
  const { householdId } = await seedHousehold(page);

  try {
    const approvals: Record<string, unknown>[] = [];
    await interceptMail(page, householdId, approvals, { firstPartial: true });

    /* goto rather than reload: the sign-in above may have landed on the
       arrival rather than /home (#840), and household.create's own
       activeHouseholdId write means this reaches /home either way now. */
    await page.goto("/home");
    const row = page.locator(".item.suggest", { hasText: "Reviewed intake 1786823446152" });
    await expect(row.first()).toBeVisible();
    /* #1145: the two decisions live in the drawer the row opens into, like
       a filed item's detail -- the row at rest carries none. */
    await row.first().click();
    const drawer = page.locator(`[id="${receiptId}-view"]`);
    await expect(drawer).toBeVisible();
    const approve = drawer.getByRole("button", { name: "Add to orbit" });

    // One stray click does nothing but arm.
    await approve.click();
    await expect(drawer.getByRole("button", { name: "tap again to approve" })).toBeVisible();
    expect(approvals.length).toBe(0);

    // The second tap fires; the first answer is partial, so the drawer says so.
    await drawer.getByRole("button", { name: "tap again to approve" }).click();
    await expect.poll(() => approvals.length).toBe(1);
    await expect(drawer.locator(".mail-problem")).toContainText("another try");

    // The retry carries the SAME operation id and the SAME body: one item, ever.
    await drawer.getByRole("button", { name: "tap again to approve" }).click();
    await expect.poll(() => approvals.length).toBe(2);
    expect(approvals[1]).toEqual(approvals[0]);
    expect(approvals[0]).toMatchObject({
      source: { kind: "mailbox_draft", receiptId, draftVersion: 3 },
      householdId,
      sectionId,
      action: "create_separate",
      item: { title: "Reviewed intake 1786823446152", provider: "Reviewed Cover", costMinor: 12550, currency: "GBP", dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12 },
      attachmentIds: [attachmentId],
    });
    // Approved: the suggestion leaves the manifest.
    await expect(page.locator(".item.suggest", { hasText: "Reviewed intake" })).toHaveCount(0);
  } finally {
    /* #1192: WebKit only -- interceptMail's routes are never unrouted, and a
       page.request call issued while they are still registered (sweep's own
       sessionHeaders) hangs for the test's whole remaining budget instead of
       resolving or erroring. v19-hit-routing.spec.ts hits the same class of
       route/request conflict; unrouteAll is its fix too. Wrapped in
       unrouteAndSweep (support/households.ts): on mobile WebKit a test whose
       own action does not resolve in time has its page and context torn
       down by Playwright's test timeout while this finally block is still
       running, and an unrouteAll or sweep call that then finds the target
       already closed must not replace the real timeout error with its own. */
    await unrouteAndSweep(page, households);
  }
});

test("amend then accept from the item view", async ({ page }) => {
  /* #1196: on mobile WebKit, the page's own /api/imap-inbox fetch after
     `page.goto` reaches the real server instead of interceptMail's route --
     Playwright's WebKit driver skips the mock after a full navigation.
     desktop-webkit runs this same flow and passes; detail on #1196. */
  test.fail(test.info().project.name === "mobile-webkit", "#1196: mobile WebKit skips interceptMail's route after goto, so this hits the real (empty) inbox");
  await signInToHome(page);
  const { householdId, itemId } = await seedHousehold(page);

  try {
    const approvals: Record<string, unknown>[] = [];
    await interceptMail(page, householdId, approvals, { approvedItemId: itemId });

    await page.goto(`/item/${receiptId}`);
    if (test.info().project.name.startsWith("mobile")) {
      /* #1145, round 3 §4: on a phone the suggestion's card holds the relay's
         readings and the two decisions; the fields are in the review sheet
         `review & amend →` raises (ReviewSheet.svelte: EntryForm in review
         mode), so the amendment happens there. */
      /* #1196: a bounded wait for the button the mocked receipt should have
         produced, true on every engine that reaches it -- mobile WebKit's
         own interceptMail bypass (above) then fails this fast instead of
         riding the click's own full test-timeout wait. */
      await expect(page.getByRole("button", { name: "review & amend →" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "review & amend →" }).click();
      const form = page.getByRole("form", { name: "Review Reviewed intake 1786823446152" });
      const name = form.locator('input[id$="-name"]');
      await expect(name).toHaveValue("Reviewed intake 1786823446152");
      /* No field wears a from-document mark on the phone: round 3 §4 draws
         the readings as their own card, `what the relay read`, each with how
         sure the relay was, and readingsOf (lib/pocket/review.js) lists
         provider, reference, due date and cost only -- never the title. So
         the mark asserted here is that card's: the provider was read plain,
         the cost at low confidence. */
      const reading = (label: string) =>
        form.locator(".pc-read", { has: page.locator(".pc-read-label", { hasText: new RegExp(`^${label}$`) }) });
      await expect(reading("provider").locator(".pc-read-sure")).toHaveText("sure");
      await expect(reading("cost").locator(".pc-read-sure")).toHaveText("unsure");

      await name.fill("Home insurance, corrected");
      await form.locator('input[id$="-cost"]').fill("199.99");
      /* The sheet's form is create's, and create refuses to save without a
         section (entry.js refusalOf); the relay proposes none. */
      await form.getByRole("button", { name: "Home", exact: true }).click();
      await page.getByRole("button", { name: "add to orbit", exact: true }).click();
    } else {
      const title = page.locator(".name-title");
      await expect(title).toHaveValue("Reviewed intake 1786823446152");
      // Extraction-read fields carry the from-document mark.
      await expect(title).toHaveClass(/sugg/);

      await title.fill("Home insurance, corrected");
      await page.locator("#s-cost").fill("199.99");
      await page.getByRole("button", { name: "accept into orbit" }).click();
    }

    await expect.poll(() => approvals.length).toBe(1);
    expect(approvals[0]).toMatchObject({
      source: { kind: "mailbox_draft", receiptId, draftVersion: 3 },
      action: "create_separate",
      item: { title: "Home insurance, corrected", costMinor: 19999, currency: "GBP", dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12 },
      attachmentIds: [attachmentId],
    });
    // Acceptance lands on the created item.
    await expect(page).toHaveURL(new RegExp(`/item/${itemId}$`));
    await expect(page.getByRole("heading", { name: "Reviewed intake landing" })).toBeVisible();
  } finally {
    /* #1192: WebKit only -- interceptMail's routes are never unrouted, and a
       page.request call issued while they are still registered (sweep's own
       sessionHeaders) hangs for the test's whole remaining budget instead of
       resolving or erroring. v19-hit-routing.spec.ts hits the same class of
       route/request conflict; unrouteAll is its fix too. Wrapped in
       unrouteAndSweep (support/households.ts): on mobile WebKit a test whose
       own action does not resolve in time has its page and context torn
       down by Playwright's test timeout while this finally block is still
       running, and an unrouteAll or sweep call that then finds the target
       already closed must not replace the real timeout error with its own. */
    await unrouteAndSweep(page, households);
  }
});

/* #1319 (owner-decisions §34): a suggestion is reviewed in its home drawer,
   not on the belt. The same amend-then-accept as above, from home: on the
   desk the drawer's own rows go live (`review & amend →`) and `add to orbit`
   approves what they hold; on a phone the signals row's `review & amend →`
   raises the review sheet in place. */
test("amend then accept from home's drawer", async ({ page }) => {
  test.fail(test.info().project.name === "mobile-webkit", "#1196: mobile WebKit skips interceptMail's route after goto, so this hits the real (empty) inbox");
  await signInToHome(page);
  const { householdId } = await seedHousehold(page);

  try {
    const approvals: Record<string, unknown>[] = [];
    await interceptMail(page, householdId, approvals);
    await page.goto("/home");
    if (test.info().project.name.startsWith("mobile")) {
      const row = page.locator(".pocket .pk-signals [data-row]", { hasText: "Reviewed intake 1786823446152" }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.locator("[data-row-face]").first().click();
      await row.getByRole("button", { name: "review & amend →" }).click();
      const form = page.getByRole("form", { name: "Review Reviewed intake 1786823446152" });
      const name = form.locator('input[id$="-name"]');
      await expect(name).toHaveValue("Reviewed intake 1786823446152");
      await name.fill("Home insurance, corrected");
      await form.locator('input[id$="-cost"]').fill("199.99");
      await form.getByRole("button", { name: "Home", exact: true }).click();
      await page.getByRole("button", { name: "add to orbit", exact: true }).click();
    } else {
      const row = page.locator(".item.suggest", { hasText: "Reviewed intake 1786823446152" }).first();
      await expect(row).toBeVisible();
      await row.click();
      const drawer = page.locator(`[id="${receiptId}-view"]`);
      await drawer.getByRole("button", { name: "review & amend →" }).click();
      /* the title edits in the row's head, the rest in the drawer's rows */
      const title = page.locator(`[id="${receiptId}"] [data-ed="title"]`);
      await expect(title).toHaveText("Reviewed intake 1786823446152");
      await expect(drawer.locator('[data-ed="provider"]')).toHaveText("Reviewed Cover");
      await title.fill("Home insurance, corrected");
      await drawer.locator('[data-ed="cost"]').fill("199.99");
      await drawer.getByRole("button", { name: "add to orbit", exact: true }).click();
    }

    await expect.poll(() => approvals.length).toBe(1);
    expect(approvals[0]).toMatchObject({
      source: { kind: "mailbox_draft", receiptId, draftVersion: 3 },
      householdId,
      sectionId,
      action: "create_separate",
      item: { title: "Home insurance, corrected", provider: "Reviewed Cover", costMinor: 19999, currency: "GBP",
        dueDate: "2031-01-10", scheduleKind: "renewal", recurrenceMonths: 12 },
      attachmentIds: [attachmentId],
    });
    // Nothing about it went to the belt.
    await expect(page).toHaveURL(/\/home/);
  } finally {
    await unrouteAndSweep(page, households);
  }
});

test("a dismissal takes two taps and mail that failed is visible on the relay", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket dialect has no suggestion rows yet (#434 follow-up)");
  await signInToHome(page);
  const { householdId } = await seedHousehold(page);

  try {
    let dismissed = false;
    await page.route("**/api/imap-inbox", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          receipts: [
            ...(dismissed ? [] : [readyReceipt(householdId)]),
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", status: "failed", householdId, draftVersion: 1,
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(), receivedAt: "2026-08-14T08:00:00.000Z",
              attachmentCount: 0, classification: "unavailable", canApprove: false, canDiscard: false,
              cleanupOnly: false, message: "This incoming document is no longer available for review.",
              proposal: {}, fieldEvidence: {},
            },
          ],
          households: [{ id: householdId, name: "Mail Proving Ground", currency: "GBP" }],
        }),
      });
    });
    await page.route(`**/api/imap-inbox/${receiptId}*`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      dismissed = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    /* goto rather than reload: the sign-in above may have landed on the
       arrival rather than /home (#840), and household.create's own
       activeHouseholdId write means this reaches /home either way now. */
    await page.goto("/home");
    const row = page.locator(".item.suggest", { hasText: "Reviewed intake 1786823446152" }).first();
    await expect(row).toBeVisible();
    /* #1145: the dismissal lives in the drawer the row opens into, as the
       approve test above; the row at rest carries no buttons. */
    await row.click();
    const drawer = page.locator(`[id="${receiptId}-view"]`);
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Dismiss" }).click();
    await expect(drawer.getByRole("button", { name: "tap again to dismiss" })).toBeVisible();
    await drawer.getByRole("button", { name: "tap again to dismiss" }).click();
    await expect(page.locator(".item.suggest", { hasText: "Reviewed intake" })).toHaveCount(0);

    // The failed message is on the relay, dated, in the server's own words.
    await page.goto("/settings/mail");
    await expect(page.locator(".failures")).toContainText("arrived, but could not be read");
    await expect(page.locator(".failures")).toContainText("no longer available for review");
    await expect(page.locator(".failures")).toContainText("14 Aug");
  } finally {
    /* #1192: WebKit only -- interceptMail's routes are never unrouted, and a
       page.request call issued while they are still registered (sweep's own
       sessionHeaders) hangs for the test's whole remaining budget instead of
       resolving or erroring. v19-hit-routing.spec.ts hits the same class of
       route/request conflict; unrouteAll is its fix too. Wrapped in
       unrouteAndSweep (support/households.ts): on mobile WebKit a test whose
       own action does not resolve in time has its page and context torn
       down by Playwright's test timeout while this finally block is still
       running, and an unrouteAll or sweep call that then finds the target
       already closed must not replace the real timeout error with its own. */
    await unrouteAndSweep(page, households);
  }
});

test("the desk reads a staged paper's page one, on the receipt's own screen and from the inbox chip (#1155)", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the desk reading card is desktop-only; see the phone test below");
  await signInToHome(page);
  const { householdId } = await seedHousehold(page);

  try {
    const approvals: Record<string, unknown>[] = [];
    await interceptMail(page, householdId, approvals);

    await page.goto(`/item/${receiptId}`);
    /* §11: the suggestion card's note names the staged paper as a button;
       pressing it is the same `showPaperById` an inbox chip or a home arrival
       uses, so this covers all three doors into the same reading card. */
    await page.locator(".note").getByRole("button", { name: /policy-schedule\.pdf/ }).click();

    const readcard = page.locator("#readcard");
    await expect(readcard).toHaveClass(/snap/);
    await expect(readcard.locator(".sheet img")).toHaveAttribute("alt", "Page one of policy-schedule.pdf");
    await expect(readcard.locator(".rcfoot .rcnote")).toHaveText("not yet in orbit · attached on acceptance");
    // No download for a staged paper: the foot carries the note, never a link.
    await expect(readcard.locator(".rcfoot a")).toHaveCount(0);

    // The chip is a second door into the same reading card (§8, §10).
    await page.goto("/inbox");
    await page.getByRole("link", { name: /policy-schedule\.pdf/ }).click();
    await expect(page).toHaveURL(new RegExp(`/item/${receiptId}$`));
    await expect(page.locator("#readcard")).toHaveClass(/open/);
  } finally {
    /* #1192: WebKit only -- interceptMail's routes are never unrouted, and a
       page.request call issued while they are still registered (sweep's own
       sessionHeaders) hangs for the test's whole remaining budget instead of
       resolving or erroring. v19-hit-routing.spec.ts hits the same class of
       route/request conflict; unrouteAll is its fix too. Wrapped in
       unrouteAndSweep (support/households.ts): on mobile WebKit a test whose
       own action does not resolve in time has its page and context torn
       down by Playwright's test timeout while this finally block is still
       running, and an unrouteAll or sweep call that then finds the target
       already closed must not replace the real timeout error with its own. */
    await unrouteAndSweep(page, households);
  }
});

test("the phone sheet reads a staged paper's page one, and tells a gone mail apart from one it just cannot draw (#1155)", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "the pocket paper sheet is phone-only; see the desk test above");
  /* #1196: on mobile WebKit, the page's own /api/imap-inbox fetch after
     `page.goto` reaches the real server instead of interceptMail's route --
     Playwright's WebKit driver skips the mock after a full navigation.
     desktop-webkit runs this same flow and passes; detail on #1196. */
  test.fail(test.info().project.name === "mobile-webkit", "#1196: mobile WebKit skips interceptMail's route after goto, so this hits the real (empty) inbox");
  await signInToHome(page);
  const { householdId } = await seedHousehold(page);

  try {
    const approvals: Record<string, unknown>[] = [];
    await interceptMail(page, householdId, approvals);

    await page.goto("/inbox");
    /* #1196: a bounded wait for the button the mocked receipt should have
       produced, true on every engine that reaches it -- mobile WebKit's own
       interceptMail bypass (above) then fails this fast instead of riding
       the click's own full test-timeout wait. */
    await expect(page.getByRole("button", { name: /policy-schedule\.pdf/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /policy-schedule\.pdf/ }).click();
    const dialog = page.getByRole("dialog", { name: "policy-schedule.pdf" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("img")).toHaveAttribute("alt", "Page one of policy-schedule.pdf");
    await expect(dialog).toContainText("not yet in orbit · attached on acceptance");
    await dialog.getByRole("button", { name: "close" }).click();
    await expect(dialog).not.toBeVisible();

    // The mail is decided or burns up between the belt listing it and the
    // preview answering: the sheet must say so plainly, never "could not draw".
    await page.route(`**/api/imap-inbox/${receiptId}/attachments/${attachmentId}/preview`, async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "inbox_receipt_not_found", message: "That incoming document is not available" } }) });
    });
    await page.getByRole("button", { name: /policy-schedule\.pdf/ }).click();
    const reopened = page.getByRole("dialog", { name: "policy-schedule.pdf" });
    await expect(reopened).toContainText("This mail has gone.");
  } finally {
    /* #1192: WebKit only -- interceptMail's routes are never unrouted, and a
       page.request call issued while they are still registered (sweep's own
       sessionHeaders) hangs for the test's whole remaining budget instead of
       resolving or erroring. v19-hit-routing.spec.ts hits the same class of
       route/request conflict; unrouteAll is its fix too. Wrapped in
       unrouteAndSweep (support/households.ts): on mobile WebKit a test whose
       own action does not resolve in time has its page and context torn
       down by Playwright's test timeout while this finally block is still
       running, and an unrouteAll or sweep call that then finds the target
       already closed must not replace the real timeout error with its own. */
    await unrouteAndSweep(page, households);
  }
});
