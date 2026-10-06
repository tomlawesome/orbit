import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { gotoCreate, tabTo } from "./support/keyboard";
import {
  cleanup,
  focusedElement,
  liveRegionFor,
  seedHousehold,
  signIn,
  type Household,
} from "./support/signed-in";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1178: the "feedback and recovery" row of the old accessibility contract
 * (docs/testing.md before 8a315e18): the signed-in lifecycle, a
 * document-assisted item, IMAP review and the online-workspace policy, each
 * proving that a failure is ANNOUNCED, that focus is not thrown away, and
 * that the reader can recover by keyboard alone. Ported to the journeys v19
 * actually has:
 *
 *   online-workspace policy  a save on /create that cannot reach Orbit
 *   IMAP review              a mail suggestion whose approval fails, from the
 *                            item view and from /inbox
 *   signed-in lifecycle      a household deletion request that fails
 *   document-assisted item   a document picked on /create: v19 has no upload
 *                            yet, so the save says the file was not kept, and
 *                            that is the feedback to announce
 *
 * What did not come across, because v19 has no equivalent to drive: the old
 * document journey's upload conflict, scanner-unavailable retry and
 * inspection rejection (no v19 screen uploads a document), and the old
 * lifecycle's member-management toasts and disabled-account page
 * (auth-error.spec.ts covers the v19 error page itself).
 *
 * Every failure journey is two tests, so one defect cannot hide the other
 * check behind it:
 *   announced  the words are shown and sit in a live region
 *              (support/signed-in.ts liveRegionFor), then the fault is
 *              removed and the same act is repeated by keyboard and lands;
 *   focus      when the failure is shown, focus has not fallen back to
 *              <body> -- where a screen reader loses its place and a
 *              keyboard reader has to find their way back.
 * Where the product falls short, the test is `test.fail` with the defect
 * named, never a loosened check; #1178's report lists each for filing.
 */

const isPocket = () => test.info().project.name.startsWith("mobile");
const isFirefox = () => test.info().project.use.defaultBrowserType === "firefox";
const isWebkit = () => test.info().project.use.defaultBrowserType === "webkit";

/** Focus on `selector` by keyboard: already there, or Tab onward to it. */
async function reach(page: Page, selector: string, screen: string, cap = 60) {
  if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return;
  await tabTo(page, { selector }, { screen, cap });
}

/** Desk and pocket both draw some screens; only the showing copy counts. */
const shownText = (page: Page, words: RegExp) => page.getByText(words).filter({ visible: true }).first();

type Journey = {
  name: string;
  /** What the failure says, as the reader sees it. */
  words: RegExp;
  withItem?: boolean;
  /** Drives up to the failing act and fires it; returns the keyboard retry. */
  fire: (page: Page, household: Household) => Promise<() => Promise<void>>;
  /** The failure itself is never shown, so neither check below can run:
   *  both tests expect-fail on it ahead of their own defect. */
  announceDefect?: () => string | undefined;
  focusDefect?: () => string | undefined;
};

/* #1233 (#1196, #1219): every journey here stages its failure with a
   `page.route` mock, and Playwright does not route a request the service
   worker handles (its documentation says to block service workers wherever
   routing is relied on). On WebKit the mock applied only until Orbit's
   worker took the page, so the /inbox journey drew the real, empty inbox
   instead of the synthetic suggestion (desktop: pipeline 2203, job 32545,
   `/api/imap-inbox` answered by the server; phone: pipeline 2188). The
   same cure as v19-mail-review.spec.ts and v19-hit-routing.spec.ts: nothing
   here is about the worker, so on WebKit it is kept out. */
test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
  },
});

/* The defect common to three journeys: the button that was pressed disables
   itself (or is swapped for a disabled copy) while the request is out, and a
   focused control that becomes disabled loses focus to <body>. When the
   failure comes back the button is live again, but focus is not on it. */
const FOCUS_LOST_TO_DISABLED_BUTTON = (where: string) =>
  `DEFECT (#1178): ${where} disables the pressed button while the request is out, so focus falls back to <body> `
  + "and the failure leaves the reader nowhere -- keep focus on the control (aria-disabled, not disabled) or move it to the message";

/* #1183: on desktop-firefox that defect is a race, not a certainty. Firefox
   sometimes keeps focus on the pressed button while it is disabled and
   sometimes drops it to <body>, run to run on the same code (the /create and
   /inbox checks each went both ways on 2026-10-01). test.fail would then pass
   or fail by chance, so every check that expects the defect is fixme on
   Firefox until #1178's fix makes it deterministic; Chromium still proves the
   defect every run. */
const FOCUS_DEFECT_RACES_ON_FIREFOX =
  "DEFECT (#1178), timing-dependent on Firefox: the pressed button, disabled while its request is out, sometimes "
  + "keeps focus and sometimes drops it to <body>, so this check cannot report either way until the button keeps focus";

/* #1219: the desk /create card's document save races the same way on
   desktop-webkit: six runs on unchanged code (2026-10-05, pinned Playwright
   image) dropped focus to <body> four times and kept it twice, so its
   `fail` mark held or broke by timing (pipeline 2131: "Expected to fail, but
   passed"). A timing-dependent expected failure is fixme, never fail (owner,
   2026-10-05, #1196). */
const FOCUS_DEFECT_RACES_ON_DESKTOP_WEBKIT =
  "DEFECT (#1178), timing-dependent on desktop Safari (#1219): the pressed button, disabled while its request is out, "
  + "sometimes keeps focus and sometimes drops it to <body>, so this check cannot report either way until the button keeps focus";

/* ── online-workspace policy ───────────────────────────────────────────── */

const failCommands = (route: Route) =>
  route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue();

const createOffline: Journey = {
  name: "a save on /create that cannot reach Orbit",
  /* The desk shows the browser's own error words (create.behaviour.js
     saveProblem), which differ by engine: Chromium's "Failed to fetch",
     Firefox's "NetworkError when attempting to fetch resource." (#1183);
     the pocket prefixes "not saved". */
  words: /^not saved|Failed to fetch|NetworkError when attempting to fetch resource/,
  fire: async (page) => {
    const name = `Offline proving ${randomUUID().slice(0, 8)}`;
    await gotoCreate(page);
    const nameField = page.getByRole("textbox", { name: "name", exact: true }).filter({ visible: true });
    await expect(nameField).toBeVisible({ timeout: 30_000 });
    await nameField.fill(name);
    await page.getByRole("group", { name: /^section/ }).filter({ visible: true }).getByRole("button", { name: "Home" }).click();

    await page.route("**/api/workspace/commands", failCommands);
    const save = isPocket() ? ".pk-save" : "#card .btn-primary";
    await tabTo(page, { selector: save }, { screen: "create" });
    await page.keyboard.press("Enter");

    return async () => {
      /* Nothing typed was lost, and the page has not moved. */
      await expect(nameField).toHaveValue(name);
      await expect(page).toHaveURL(/\/create$/);
      await page.unroute("**/api/workspace/commands", failCommands);
      await reach(page, save, "create, retry");
      await page.keyboard.press("Enter");
      /* Saved: the desk returns to the orbit, the pocket approaches the item. */
      await expect(page).toHaveURL(isPocket() ? /\/item\/[0-9a-f-]{36}$/ : /\/home$/, { timeout: 30_000 });
    };
  },
  /* #1192: WebKit keeps focus on the pressed button while it is disabled
     (pipeline 1989, mobile-webkit) -- the opposite of Chromium's #1178
     defect, not a timing race like Firefox's. Nothing to expect-fail here. */
  focusDefect: () => isWebkit() ? undefined : FOCUS_LOST_TO_DISABLED_BUTTON(isPocket() ? "the pocket create bar (.pk-save)" : "the desk create card (#card .btn-primary)"),
};

/* ── IMAP review ───────────────────────────────────────────────────────── */

/**
 * A synthetic mail suggestion on the reader's household, as
 * v19-mail-review.spec.ts intercepts it; the first approval answers 500 in
 * Orbit's own error shape, every later one succeeds.
 */
async function interceptFailingMail(page: Page, household: Household) {
  const receiptId = randomUUID();
  const attachmentId = randomUUID();
  const title = `Mailed renewal ${receiptId.slice(0, 8)}`;
  let approvals = 0;
  let approved = false;
  const attachment = { id: attachmentId, ordinal: 1, displayName: "schedule.pdf", mediaType: "application/pdf", sizeBytes: 128, scanState: "clean" };
  const receipt = {
    id: receiptId,
    status: "pending_review",
    householdId: household.id,
    draftVersion: 1,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    receivedAt: new Date().toISOString(),
    attachmentCount: 1,
    classification: "ready",
    canApprove: true,
    canDiscard: true,
    cleanupOnly: false,
    message: "Ready for your review.",
    proposal: { title, provider: "Synthetic Cover", costMinor: 9900, currency: "GBP", dueDate: "2031-03-01", scheduleKind: "renewal", recurrenceMonths: 12 },
    fieldEvidence: { title: { source: "parser", confidence: "medium" } },
    attachments: [attachment],
  };
  await page.route("**/api/imap-inbox", (route) =>
    route.fulfill({ json: { receipts: approved ? [] : [receipt], households: [{ id: household.id, name: household.name, currency: "GBP" }] } }));
  await page.route(`**/api/imap-inbox/${receiptId}*`, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: { receipt, sections: [{ id: household.sectionId, name: "Home" }], candidates: [], attachments: [attachment] } });
  });
  await page.route("**/api/reviewed-intake/approve", (route) => {
    approvals += 1;
    if (approvals === 1) {
      // SQ2-Q1 (#1151): the real approve route never answers with
      // "intake_unavailable" -- src/lib/app-error.ts's appErrorResponse has
      // no such code, and its catch-all for an unexpected failure is always
      // this exact status, code and message. A mocked shape the backend
      // cannot produce proves nothing about how the UI handles one it can.
      return route.fulfill({ status: 500, json: { error: { code: "internal_error", message: "Orbit could not complete the request" } } });
    }
    approved = true;
    return route.fulfill({ json: { outcome: "approved", itemId: null } });
  });
  return { receiptId, title, approvals: () => approvals };
}

const APPROVAL_FAILED = /could not complete the request/;

const itemViewApproval: Journey = {
  name: "a mail suggestion whose approval fails, in the item view",
  words: APPROVAL_FAILED,
  fire: async (page, household) => {
    const mail = await interceptFailingMail(page, household);
    await page.goto(`/item/${mail.receiptId}`);
    /* Pocket: the suggestion card's ArmButton (Enter arms, Enter fires);
       desk: the amend card's "accept into orbit". */
    const act = isPocket() ? `button[aria-label="Add ${mail.title} to your orbit"]` : ".save-row .btn-primary";
    const press = async () => {
      await page.keyboard.press("Enter");
      if (isPocket()) await page.keyboard.press("Enter");
    };
    await expect(page.locator(act)).toBeEnabled({ timeout: 30_000 });
    await tabTo(page, { selector: act }, { screen: "item, suggestion" });
    await press();
    await expect.poll(mail.approvals).toBe(1);
    return async () => {
      await reach(page, act, "item, retry");
      await press();
      await expect.poll(mail.approvals).toBe(2);
      await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
    };
  },
  focusDefect: () => FOCUS_LOST_TO_DISABLED_BUTTON(isPocket() ? "the pocket suggestion card's Add to orbit" : "the desk amend card's accept into orbit"),
};

const inboxApproval: Journey = {
  name: "a mail suggestion whose approval fails, on /inbox",
  words: APPROVAL_FAILED,
  fire: async (page, household) => {
    const mail = await interceptFailingMail(page, household);
    await page.goto("/inbox");
    /* Both dialects ask twice: Enter arms, Enter fires. */
    const act = isPocket() ? `button[aria-label="Add ${mail.title} to your orbit"]` : ".actions button.yes";
    await expect(page.locator(act).first()).toBeVisible({ timeout: 30_000 });
    await tabTo(page, { selector: act }, { screen: "inbox" });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(mail.approvals).toBe(1);
    return async () => {
      await reach(page, act, "inbox, retry");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await expect.poll(mail.approvals).toBe(2);
      /* Approved: the suggestion's card leaves the inbox. (Not its title
         text: the pocket's wake still carries it, "added to your orbit".) */
      await expect(page.locator(act)).toHaveCount(0);
    };
  },
  announceDefect: () =>
    isPocket()
      ? undefined
      : "DEFECT (#1178): the desk /inbox draws an approve or dismiss failure as a plain <div class=\"mail-problem\"> "
        + "(web/src/routes/inbox/+page.svelte) with no role=\"alert\" or live region, so a screen reader is never told",
  /* Desktop Safari keeps focus on the disabled button here (pipeline 2011
     passed the focus check twice under an expect-fail), as every WebKit
     does on /create above; the pocket keeps its mark, which held on
     mobile-webkit in the same run. */
  focusDefect: () =>
    test.info().project.name === "desktop-webkit"
      ? undefined
      : FOCUS_LOST_TO_DISABLED_BUTTON(isPocket() ? "the pocket inbox's ReviewCard" : "the desk /inbox row's Add to orbit"),
};

/* ── signed-in lifecycle ───────────────────────────────────────────────── */

const householdDeletion: Journey = {
  name: "a household deletion request that fails",
  words: /could not schedule the deletion just now/,
  fire: async (page, household) => {
    const lifecycle = `**/api/households/${household.id}/lifecycle`;
    const failDeletion = (route: Route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, json: { error: { code: "lifecycle_unavailable", message: "Orbit could not schedule the deletion just now" } } })
        : route.continue();
    await page.goto(`/household/${household.id}`);
    await expect(page.getByRole("heading", { name: household.name })).toBeVisible({ timeout: 30_000 });
    await page.route(lifecycle, failDeletion);

    /* Opening the confirmation moves focus into it: on the desk onto the
       name field (openConfirm), on the pocket into the sheet (sheet.js). */
    const opener = isPocket() ? ".hh-danger button.danger" : ".dangercard .dangerbtn";
    await tabTo(page, { selector: opener }, { screen: "household, danger line", cap: 120 });
    await page.keyboard.press("Enter");
    if (isPocket()) {
      await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    } else {
      await expect(page.locator("#delname")).toBeFocused();
    }
    const confirmName = isPocket() ? "#hh-delname" : "#delname";
    await reach(page, confirmName, "household, confirmation");
    await page.keyboard.type(household.name);

    /* The armed act: on the desk the button above the field, on the pocket
       the ArmButton in the sheet's foot. Enter arms, Enter again fires. */
    const act = isPocket() ? '[role="dialog"] button.arm' : ".dangercard .dangerbtn";
    const fire = async (screen: string) => {
      if (!isPocket() && (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, confirmName))) {
        await page.keyboard.press("Shift+Tab");
      }
      await reach(page, act, screen);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    };
    await fire("household, request deletion");
    return async () => {
      await page.unroute(lifecycle, failDeletion);
      await fire("household, ask again");
      await expect(shownText(page, /requested · .*gone for good in 30 days/)).toBeVisible();
    };
  },
  announceDefect: () =>
    isPocket()
      ? undefined
      : "DEFECT (#1178): the desk household page draws a failed deletion request as a plain <p class=\"problem\"> "
        + "(web/src/routes/household/[id]/+page.svelte, the danger line; its identity, sections and members "
        + "problems likewise) with no role=\"alert\", and the success line has no role=\"status\" either",
};

const JOURNEYS = [createOffline, itemViewApproval, inboxApproval, householdDeletion];

for (const journey of JOURNEYS) {
  test(`${journey.name} is announced, and the act can be repeated by keyboard`, async ({ page }) => {
    const defect = journey.announceDefect?.();
    test.fail(Boolean(defect), defect);
    test.setTimeout(90_000);
    await signIn(page, "/home");
    const household = await seedHousehold(page, "feedback-recovery", { withItem: journey.withItem });
    try {
      const retry = await journey.fire(page, household);
      await expect(shownText(page, journey.words), `${journey.name}: the failure is shown`).toBeVisible();
      expect(await liveRegionFor(page, journey.words), `${journey.name}: the failure is in a live region`).not.toMatch(/^(none|absent)$/);
      await retry();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await cleanup(page, household);
    }
  });

  test(`${journey.name} leaves focus where the reader was`, async ({ page }) => {
    const defect = journey.focusDefect?.();
    test.fixme(Boolean(defect) && isFirefox(), FOCUS_DEFECT_RACES_ON_FIREFOX);
    test.fail(Boolean(defect), defect);
    test.setTimeout(90_000);
    await signIn(page, "/home");
    const household = await seedHousehold(page, "feedback-recovery", { withItem: journey.withItem });
    try {
      await journey.fire(page, household);
      await expect(shownText(page, journey.words), `${journey.name}: the failure is shown`).toBeVisible();
      expect(await focusedElement(page), `${journey.name}: focus is not dropped to the page`).not.toBe("body");
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await cleanup(page, household);
    }
  });
}

/* ── document-assisted item ────────────────────────────────────────────── */

/* Desk: "Saved. renewal-letter.pdf was not attached …" in #save-note
   (aria-live="polite"), and the page stays; pocket: "… was not kept" in the
   wake's status region (lib/pocket/Wake.svelte) as the new item opens. */
const DOCUMENT_NOT_KEPT = /renewal-letter\.pdf was not (attached|kept)/;

/** Picks a document and saves an entry with it, by keyboard; returns its name. */
async function saveWithDocument(page: Page): Promise<string> {
  const name = `Document proving ${randomUUID().slice(0, 8)}`;
  /* Listened for BEFORE the page loads: Playwright switches the browser's
     file-chooser interception on when the first listener arrives, and a key
     that lands before that switch has taken opens the native chooser, which
     no event reports -- seen twice in five desk runs while this file was
     written, as a 15s wait right after the Enter. */
  const chooser = page.waitForEvent("filechooser", { timeout: 45_000 });
  await gotoCreate(page);
  const nameField = page.getByRole("textbox", { name: "name", exact: true }).filter({ visible: true });
  await expect(nameField).toBeVisible({ timeout: 30_000 });

  /* The picker, by keyboard: the desk's drop target is a role="button" that
     opens the file chooser on Enter or Space; the pocket's is "add a
     document". */
  const picker = isPocket() ? "#pocket-entry .pc-doc" : "#dropzone";
  await tabTo(page, { selector: picker }, { screen: "create, document" });
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "renewal-letter.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });

  await nameField.fill(name);
  await page.getByRole("group", { name: /^section/ }).filter({ visible: true }).getByRole("button", { name: "Home" }).click();
  await tabTo(page, { selector: isPocket() ? ".pk-save" : "#card .btn-primary" }, { screen: "create, document" });
  await page.keyboard.press("Enter");
  return name;
}

test("a document picked on /create is announced as not kept, and the entry still saves", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, "/home");
  const household = await seedHousehold(page, "feedback-recovery");
  try {
    const name = await saveWithDocument(page);
    await expect.poll(() => liveRegionFor(page, DOCUMENT_NOT_KEPT), { timeout: 15_000 }).not.toMatch(/^(none|absent)$/);

    /* And the entry itself is in the orbit, whatever became of the file. */
    const listed = await page.request.get("/api/workspace", { timeout: 15_000 });
    expect(listed.ok()).toBe(true);
    const { workspace } = (await listed.json()) as { workspace: { households: Array<{ id: string; items: Array<{ title: string }> }> } };
    expect(workspace.households.find((one) => one.id === household.id)?.items.map((item) => item.title)).toContain(name);
  } finally {
    await cleanup(page, household);
  }
});

test("a document picked on /create leaves focus where the reader was", async ({ page }) => {
  /* The pocket saves by opening the new item: a navigation, where focus
     starting over is SvelteKit's own reset, not a loss. The desk stays put. */
  test.skip(isPocket(), "the pocket save navigates to the new item; focus starting over there is not a loss");
  test.fixme(isFirefox(), FOCUS_DEFECT_RACES_ON_FIREFOX);
  test.fixme(test.info().project.name === "desktop-webkit", FOCUS_DEFECT_RACES_ON_DESKTOP_WEBKIT);
  const defect = FOCUS_LOST_TO_DISABLED_BUTTON("the desk create card (#card .btn-primary)");
  test.fail(Boolean(defect), defect);
  test.setTimeout(90_000);
  await signIn(page, "/home");
  const household = await seedHousehold(page, "feedback-recovery");
  try {
    await saveWithDocument(page);
    await expect(shownText(page, DOCUMENT_NOT_KEPT)).toBeVisible({ timeout: 15_000 });
    expect(await focusedElement(page), "create, document: focus is not dropped to the page").not.toBe("body");
  } finally {
    await cleanup(page, household);
  }
});
