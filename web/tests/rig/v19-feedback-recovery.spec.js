import { expect, test } from "@playwright/test";

import { gotoCreate, tabTo } from "../../../tests/e2e/support/keyboard";
import { focusHeld, liveRegionFor } from "../../../tests/e2e/support/signed-in";
import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, onPhone } from "./a11y-support.js";
import { INTERNAL_ERROR, SUGGESTION, rememberMailDecisions } from "./mail-support.js";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Route} Route */

/*
 * #1178, moved to the rig (ADR-0039, #1610): the "feedback and recovery" row of
 * the old accessibility contract (docs/testing.md before 8a315e18): the
 * signed-in lifecycle, a document-assisted item, IMAP review and the
 * online-workspace policy, each proving that a failure is ANNOUNCED, that focus
 * is not thrown away, and that the reader can recover by keyboard alone. Ported
 * to the journeys v19 actually has:
 *
 *   online-workspace policy  a save on /create that cannot reach Orbit
 *   IMAP review              a mail suggestion whose approval fails, from its
 *                            home drawer and from /inbox
 *   signed-in lifecycle      a household deletion request that fails
 *
 * What did not come across: the old document journey's upload conflict,
 * scanner-unavailable retry and inspection rejection (v19-create.spec.ts proves
 * the create form's attach, #1245; its pocket "was not kept" check went when
 * the pocket started keeping documents, owner's 11a), and, because v19 has no
 * equivalent to drive, the old lifecycle's member-management toasts and
 * disabled-account page (web/tests/rig/auth-error.spec.js covers the v19 error page itself).
 *
 * Every failure journey is two tests, so one defect cannot hide the other check
 * behind it:
 *   announced  the words are shown and sit in a live region (liveRegionFor),
 *              then the fault is removed and the same act is repeated by
 *              keyboard and lands;
 *   focus      when the failure is shown, focus has not fallen back to <body>
 *              -- where a screen reader loses its place and a keyboard reader
 *              has to find their way back.
 * Where the product falls short, the test is `test.fail` with the defect named,
 * never a loosened check.
 *
 * Each journey starts from the fixture app's own state: /create, the fixture
 * inbox's approvable "Home insurance renewal" receipt, and Harlow Home's
 * household page. The fault is the test's own: a save, an approval and a
 * deletion request that fail once, answered where they are sent
 * (`page.route`); the approval's recovery goes through `rememberMailDecisions`
 * (mail-support.js). The stack's own seeding, sign-in and clean-up are gone.
 *
 * Playwright does not route a request the service worker handles (its own
 * documentation says to block service workers wherever routing is relied on),
 * and nothing here is about the worker, so it is kept out on every engine
 * (#1233, #1196, #1219).
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

const isFirefox = () => test.info().project.use.defaultBrowserType === "firefox";
const isDeskWebkit = () => test.info().project.name === "rig-webkit-desktop";
const isPocket = () => onPhone(test.info());

/** Focus on `selector` by keyboard: already there, or Tab onward to it.
 * @param {Page} page @param {string} selector @param {string} screen @param {number} [cap] */
async function reach(page, selector, screen, cap = 60) {
  if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return;
  await tabTo(page, { selector }, { screen, cap });
}

/** Desk and pocket both draw some screens; only the showing copy counts.
 * @param {Page} page @param {RegExp} words */
const shownText = (page, words) => page.getByText(words).filter({ visible: true }).first();

/**
 * @typedef {{
 *   name: string,
 *   words: RegExp,
 *   fire: (page: Page) => Promise<() => Promise<void>>,
 *   announceDefect?: () => string | undefined,
 *   focusDefect?: () => string | undefined,
 *   focusFixme?: () => string | undefined,
 * }} Journey
 * `words` is what the failure says, as the reader sees it; `fire` drives up to
 * the failing act, fires it, and returns the keyboard retry. `announceDefect`
 * and `focusDefect` name a defect the check expects to fail on; `focusFixme` is
 * a reason the focus check cannot report either way on this project (#1233).
 */

/* The defect common to three journeys: the button that was pressed disables
   itself (or is swapped for a disabled copy) while the request is out, and a
   focused control that becomes disabled loses focus to <body>. When the
   failure comes back the button is live again, but focus is not on it. */
const FOCUS_LOST_TO_DISABLED_BUTTON = (/** @type {string} */ where) =>
  `DEFECT (#1178): ${where} disables the pressed button while the request is out, so focus falls back to <body> `
  + "and the failure leaves the reader nowhere -- keep focus on the control (aria-disabled, not disabled) or move it to the message";

/* #1183: on Firefox that defect is a race, not a certainty. Firefox sometimes
   keeps focus on the pressed button while it is disabled and sometimes drops it
   to <body>, run to run on the same code, so test.fail would pass or fail by
   chance: every check that expects the defect is fixme on Firefox until #1178's
   fix makes it deterministic; Chromium still proves the defect every run. */
const FOCUS_DEFECT_RACES_ON_FIREFOX =
  "DEFECT (#1178), timing-dependent on Firefox: the pressed button, disabled while its request is out, sometimes "
  + "keeps focus and sometimes drops it to <body>, so this check cannot report either way until the button keeps focus";

/* #1219: the same race on desktop WebKit (a timing-dependent expected failure
   is fixme, never fail: owner, 2026-10-05, #1196). */
const FOCUS_DEFECT_RACES_ON_DESKTOP_WEBKIT =
  "DEFECT (#1178), timing-dependent on desktop Safari (#1219): the pressed button, disabled while its request is out, "
  + "sometimes keeps focus and sometimes drops it to <body>, so this check cannot report either way until the button keeps focus";

/* ── online-workspace policy ───────────────────────────────────────────── */

/** @param {Route} route */
const failCommands = (route) => (route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue());

/** @type {Journey} */
const createOffline = {
  name: "a save on /create that cannot reach Orbit",
  /* The desk shows the browser's own error words (create.behaviour.js
     saveProblem), which differ by engine: Chromium's "Failed to fetch",
     Firefox's "NetworkError when attempting to fetch resource." (#1183),
     WebKit's "Load failed" (#1233); the pocket prefixes "not saved". */
  words: /^not saved|Failed to fetch|NetworkError when attempting to fetch resource|Load failed/,
  fire: async (page) => {
    const name = "Offline proving";
    await gotoCreate(page);
    const nameField = page.getByRole("textbox", { name: "name", exact: true }).filter({ visible: true });
    await expect(nameField).toBeVisible({ timeout: SETTLE });
    await nameField.fill(name);
    /* Every entry needs a type (#1316 A4-F3, item_kind_missing); a document is
       the type that asks for no date, as v19-create.spec.ts's undated save. */
    if (isPocket()) {
      await page.getByRole("form", { name: "New entry" }).getByRole("button", { name: "document", exact: true }).click();
    } else {
      await page.locator('#types button[data-type="document"]').click();
    }
    await page.getByRole("group", { name: /^section/ }).filter({ visible: true }).getByRole("button", { name: "Home" }).click();

    /* #1313: Add is held (aria-disabled) until the engine's first dry-run
       answer, and a press on a held Add is ignored by design
       (create.behaviour.js `refusal`, pocket.svelte `refusal`). Pressed before
       that answer, nothing is sent and no failure ever shows. */
    const save = isPocket() ? ".pk-save" : "#card .btn-primary";
    await expect(page.locator(save).filter({ visible: true }), "create: Add is live once the engine has answered")
      .not.toHaveAttribute("aria-disabled", "true", { timeout: SETTLE });
    await page.route("**/api/workspace/commands", failCommands);
    await tabTo(page, { selector: save }, { screen: "create" });
    await page.keyboard.press("Enter");

    return async () => {
      /* Nothing typed was lost, and the page has not moved. */
      await expect(nameField).toHaveValue(name, { timeout: SETTLE });
      await expect(page).toHaveURL(/\/create$/, { timeout: SETTLE });
      await page.unroute("**/api/workspace/commands", failCommands);
      await reach(page, save, "create, retry");
      await page.keyboard.press("Enter");
      /* Saved: both close onto the main screen at the saved item's own address
         (#1246; the pocket since #1319, when the belt it used to approach
         retired). */
      await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });
    };
  },
  /* No focus defect to expect here any more (#1327): the save button is held
     with aria-disabled, never `disabled`, so it keeps focus while the request
     is out (#1178's own remedy). */
};

/* ── IMAP review ───────────────────────────────────────────────────────── */

/**
 * The fixture's approvable receipt, whose first approval answers 500 in Orbit's
 * own error shape (SQ2-Q1 #1151: the real approve route never answers with
 * "intake_unavailable"; a mocked shape the backend cannot produce proves
 * nothing about how the UI handles one it can) and every later one succeeds.
 * @param {Page} page
 */
async function interceptFailingMail(page) {
  const mail = await rememberMailDecisions(page, {
    answer: (n) => (n === 1 ? { status: 500, json: INTERNAL_ERROR } : null),
  });
  return { receiptId: SUGGESTION.id, title: SUGGESTION.title, approvals: () => mail.approvals.length };
}

const APPROVAL_FAILED = /could not complete the request/;

/* #1319 (owner-decisions §34): the belt's suggestion card retired; a suggestion
   is decided in its home drawer, which its address opens. */
/** @type {Journey} */
const drawerApproval = {
  name: "a mail suggestion whose approval fails, in its home drawer",
  words: APPROVAL_FAILED,
  fire: async (page) => {
    const mail = await interceptFailingMail(page);
    /* Both ask twice, Enter arms and Enter fires: the pocket row's ArmButton,
       the desk drawer's "Add to orbit" (SuggestionView). */
    const act = isPocket()
      ? `button[aria-label="Add ${mail.title} to your orbit"]`
      : `[id="${mail.receiptId}-view"] .actions button.yes`;
    const press = async () => {
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    };
    if (isPocket()) {
      /* The phone opens the suggestion's row by keyboard. */
      await page.goto("/home");
      const face = `.pocket .pk-signals [data-row-key="${mail.receiptId}"] [data-row-face]`;
      await expect(page.locator(face)).toBeVisible({ timeout: SETTLE });
      await tabTo(page, { selector: face }, { screen: "home, signals" });
      await page.keyboard.press("Enter");
    } else {
      await page.goto(`/home?item=${mail.receiptId}`);
    }
    await expect(page.locator(act)).toBeEnabled({ timeout: SETTLE });
    await tabTo(page, { selector: act }, { screen: "home, suggestion drawer" });
    await press();
    await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(1);
    return async () => {
      /* The failure stays where it is said: the phone's row stays open, its
         words and its decisions with it. */
      if (isPocket()) {
        await expect(page.locator(`.pocket .pk-signals [data-row-key="${mail.receiptId}"]`)).toHaveAttribute("data-open", "", { timeout: SETTLE });
      }
      await reach(page, act, "home drawer, retry");
      await press();
      await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(2);
      /* Approved: the suggestion leaves home, its decisions with it. */
      await expect(page.locator(act)).toHaveCount(0, { timeout: SETTLE });
    };
  },
  /* #1233: desktop WebKit kept focus on the amend card's button, as it keeps it
     on the create card (#1192) -- and the create card's check on desktop WebKit
     then raced (#1219). One observation is not a certainty either way, so on
     desktop WebKit this check is fixme; the phone and the other engines keep
     their marks. The phone's row puts focus on its own face when the act
     returns (Row.svelte run), so focus is never dropped there. */
  focusDefect: () => (isPocket() ? undefined : FOCUS_LOST_TO_DISABLED_BUTTON("the desk suggestion drawer's Add to orbit")),
  focusFixme: () => (isDeskWebkit() ? FOCUS_DEFECT_RACES_ON_DESKTOP_WEBKIT : undefined),
};

/** @type {Journey} */
const inboxApproval = {
  name: "a mail suggestion whose approval fails, on /inbox",
  words: APPROVAL_FAILED,
  fire: async (page) => {
    const mail = await interceptFailingMail(page);
    await page.goto("/inbox");
    /* Both dialects ask twice: Enter arms, Enter fires. */
    const act = isPocket() ? `button[aria-label="Add ${mail.title} to your orbit"]` : ".actions button.yes";
    await expect(page.locator(act).first()).toBeVisible({ timeout: SETTLE });
    await tabTo(page, { selector: act }, { screen: "inbox" });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(1);
    return async () => {
      await reach(page, act, "inbox, retry");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await expect.poll(mail.approvals, { timeout: SETTLE }).toBe(2);
      /* Approved: the suggestion's card leaves the inbox. (Not its title text:
         the pocket's wake still carries it, "added to your orbit".) */
      await expect(page.locator(act)).toHaveCount(0, { timeout: SETTLE });
    };
  },
  announceDefect: () =>
    isPocket()
      ? undefined
      : "DEFECT (#1178): the desk /inbox draws an approve or dismiss failure as a plain <div class=\"mail-problem\"> "
        + "(web/src/routes/inbox/+page.svelte) with no role=\"alert\" or live region, so a screen reader is never told",
  /* Desktop Safari keeps focus on the disabled button here, as every WebKit
     does on /create; the pocket keeps its mark. A traced local desktop WebKit
     run (#1235) dropped it to <body> -- so on desktop WebKit this one is the
     same race the item view has, not a certainty either way: fixme there. */
  focusDefect: () =>
    isDeskWebkit()
      ? undefined
      : FOCUS_LOST_TO_DISABLED_BUTTON(isPocket() ? "the pocket inbox's ReviewCard" : "the desk /inbox row's Add to orbit"),
  focusFixme: () => (isDeskWebkit() ? FOCUS_DEFECT_RACES_ON_DESKTOP_WEBKIT : undefined),
};

/* ── signed-in lifecycle ───────────────────────────────────────────────── */

/** The fixture's primary household, which its viewer manages. */
const HOUSEHOLD = { id: "hh-harlow-1", name: "Harlow Home" };

/** @type {Journey} */
const householdDeletion = {
  name: "a household deletion request that fails",
  words: /could not schedule the deletion just now/,
  fire: async (page) => {
    const lifecycle = `**/api/households/${HOUSEHOLD.id}/lifecycle`;
    /** @param {Route} route */
    const failDeletion = (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, json: { error: { code: "lifecycle_unavailable", message: "Orbit could not schedule the deletion just now" } } })
        : route.continue();
    await page.goto(`/household/${HOUSEHOLD.id}`);
    await expect(page.getByRole("heading", { name: HOUSEHOLD.name })).toBeVisible({ timeout: SETTLE });
    await page.route(lifecycle, failDeletion);

    /* Opening the confirmation moves focus into it: on the desk onto the name
       field (openConfirm), on the pocket into the sheet (sheet.js). */
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
    await page.keyboard.type(HOUSEHOLD.name);

    /* The armed act: on the desk the button above the field, on the pocket the
       ArmButton in the sheet's foot. Enter arms, Enter again fires. */
    const act = isPocket() ? '[role="dialog"] button.arm' : ".dangercard .dangerbtn";
    const fire = async (/** @type {string} */ screen) => {
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
      /* The request goes through this time: the engine's own answer, the date
         the household will be gone for good. */
      await page.route(lifecycle, (route) =>
        route.fulfill({ json: { deleteAfter: new Date(Date.now() + 30 * 86_400_000).toISOString() } }));
      await fire("household, ask again");
      await expect(shownText(page, /requested · .*gone for good in 30 days/)).toBeVisible({ timeout: SETTLE });
    };
  },
  announceDefect: () =>
    isPocket()
      ? undefined
      : "DEFECT (#1178): the desk household page draws a failed deletion request as a plain <p class=\"problem\"> "
        + "(web/src/routes/household/[id]/+page.svelte, the danger line; its identity, sections and members "
        + "problems likewise) with no role=\"alert\", and the success line has no role=\"status\" either",
};

const JOURNEYS = [createOffline, drawerApproval, inboxApproval, householdDeletion];

for (const journey of JOURNEYS) {
  test(`${journey.name} is announced, and the act can be repeated by keyboard`, async ({ page }) => {
    const defect = journey.announceDefect?.();
    test.fail(Boolean(defect), defect);
    test.setTimeout(60_000);
    const retry = await journey.fire(page);
    /* End states, as the focus check below (#1313, #1447): the failure is
       waited for, and so is the live region that carries it. */
    await expect(shownText(page, journey.words), `${journey.name}: the failure is shown`).toBeVisible({ timeout: SETTLE });
    await expect
      .poll(() => liveRegionFor(page, journey.words), { message: `${journey.name}: the failure is in a live region`, timeout: SETTLE })
      .not.toMatch(/^(none|absent)$/);
    await retry();
  });

  test(`${journey.name} leaves focus where the reader was`, async ({ page }) => {
    const defect = journey.focusDefect?.();
    test.fixme(Boolean(journey.focusFixme?.()), journey.focusFixme?.());
    test.fixme(Boolean(defect) && isFirefox(), FOCUS_DEFECT_RACES_ON_FIREFOX);
    test.fail(Boolean(defect), defect);
    test.setTimeout(60_000);
    await journey.fire(page);
    await expect(shownText(page, journey.words), `${journey.name}: the failure is shown`).toBeVisible({ timeout: SETTLE });
    /* The end state, not a single read the instant the failure shows: focus may
       take a moment to settle, and what matters is where it STAYS -- so it has
       to hold one element for a run of painted frames, and a focus that only
       passed through an element on its way to the page (T-Q2) is not that. */
    await expect
      .poll(() => focusHeld(page), { message: `${journey.name}: focus is held on an element, not dropped to the page`, timeout: SETTLE })
      .not.toMatch(/^(body|moving)$/);
  });
}
