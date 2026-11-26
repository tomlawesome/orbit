import { expect, test } from "@playwright/test";

import { gotoCreate, tabTo } from "../../../tests/e2e/support/keyboard";
import { focusHeld, liveRegionFor } from "../../../tests/e2e/support/signed-in";
import { APP, onPhone } from "./a11y-support.js";
import { guardedRoute } from "./workspace-writes.js";
import { INTERNAL_ERROR, SUGGESTION, rememberMailDecisions } from "./mail-support.js";
import { pickImportance } from "./importance-support.js";

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
 * Where the product falls short, mark the test `test.fail` with the defect
 * named, never a loosened check.
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
 * }} Journey
 * `words` is what the failure says, as the reader sees it; `fire` drives up to
 * the failing act, fires it, and returns the keyboard retry.
 */

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
    await expect(nameField).toBeVisible();
    await nameField.fill(name);
    /* Every entry needs a type (#1316 A4-F3, item_kind_missing); a document is
       the type that asks for no date, as v19-create.spec.ts's undated save. */
    if (isPocket()) {
    } else {
    }
    await page.getByRole("group", { name: /^section/ }).filter({ visible: true }).getByRole("button", { name: "Home" }).click();
    await pickImportance(page);

    /* #1313: Add is held (aria-disabled) until the engine's first dry-run
       answer, and a press on a held Add is ignored by design
       (create.behaviour.js `refusal`, pocket.svelte `refusal`). Pressed before
       that answer, nothing is sent and no failure ever shows. */
    const save = isPocket() ? ".pk-save" : "#card .btn-primary";
    await expect(page.locator(save).filter({ visible: true }), "create: Add is live once the engine has answered")
      .not.toHaveAttribute("aria-disabled", "true");
    await page.route("**/api/workspace/commands", failCommands);
    await tabTo(page, { selector: save }, { screen: "create" });
    await page.keyboard.press("Enter");

    return async () => {
      /* Nothing typed was lost, and the page has not moved. */
      await expect(nameField).toHaveValue(name);
      await expect(page).toHaveURL(/\/create$/);
      await page.unroute("**/api/workspace/commands", failCommands);
      await reach(page, save, "create, retry");
      await page.keyboard.press("Enter");
      /* Saved: both close onto the main screen at the saved item's own address
         (#1246; the pocket since #1319, when the belt it used to approach
         retired). */
      await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/);
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
      await expect(page.locator(face)).toBeVisible();
      await tabTo(page, { selector: face }, { screen: "home, signals" });
      await page.keyboard.press("Enter");
    } else {
      await page.goto(`/home?item=${mail.receiptId}`);
    }
    await expect(page.locator(act)).toBeEnabled();
    await tabTo(page, { selector: act }, { screen: "home, suggestion drawer" });
    await press();
    await expect.poll(mail.approvals).toBe(1);
    return async () => {
      /* The failure stays where it is said: the phone's row stays open, its
         words and its decisions with it. */
      if (isPocket()) {
        await expect(page.locator(`.pocket .pk-signals [data-row-key="${mail.receiptId}"]`)).toHaveAttribute("data-open", "");
      }
      await reach(page, act, "home drawer, retry");
      await press();
      await expect.poll(mail.approvals).toBe(2);
      /* Approved: the suggestion leaves home, its decisions with it. */
      await expect(page.locator(act)).toHaveCount(0);
    };
  },
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
    await expect(page.locator(act).first()).toBeVisible();
    await tabTo(page, { selector: act }, { screen: "inbox" });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(mail.approvals).toBe(1);
    return async () => {
      await reach(page, act, "inbox, retry");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await expect.poll(mail.approvals).toBe(2);
      /* Approved: the suggestion's card leaves the inbox. (Not its title text:
         the pocket's wake still carries it, "added to your orbit".) */
      await expect(page.locator(act)).toHaveCount(0);
    };
  },
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
    await expect(page.getByRole("heading", { name: HOUSEHOLD.name })).toBeVisible();
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
      await expect(shownText(page, /requested · .*gone for good in 30 days/)).toBeVisible();
    };
  },
};

/**
 * How a failure message is announced: "focus" when focus is ON the message,
 * otherwise what `liveRegionFor` finds (a live region around it, or "none" /
 * "absent"). A focused element is read out by a screen reader (WAI-ARIA APG,
 * "Moving focus to an error", WCAG G83 / ARIA19 practice), so a message that
 * has focus needs no live-region ancestor; one focus does not move to still
 * does. The phone ReviewCard moves focus to its message; the desk's lines do
 * not, and stay in an always-present alert.
 * @param {Page} page @param {RegExp} words
 */
async function announcedAs(page, words) {
  const focused = await page.evaluate(({ source, flags }) => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return false;
    const rect = el.getBoundingClientRect();
    const shown = (rect.width > 0 || rect.height > 0) && getComputedStyle(el).visibility !== "hidden";
    return shown && new RegExp(source, flags).test(el.textContent ?? "");
  }, { source: words.source, flags: words.flags });
  return focused ? "focus" : liveRegionFor(page, words);
}

const JOURNEYS = [createOffline, drawerApproval, inboxApproval, householdDeletion];

for (const journey of JOURNEYS) {
  test(`${journey.name} is announced, and the act can be repeated by keyboard`, async ({ page }) => {
    const retry = await journey.fire(page);
    /* End states, as the focus check below (#1313, #1447): the failure is
       waited for, and so is the live region that carries it. */
    await expect(shownText(page, journey.words), `${journey.name}: the failure is shown`).toBeVisible();
    await expect
      .poll(() => announcedAs(page, journey.words), { message: `${journey.name}: the failure is announced (focus on it, or in a live region)` })
      .not.toMatch(/^(none|absent)$/);
    await retry();
  });

  test(`${journey.name} leaves focus where the reader was`, async ({ page }) => {
    /* each focusHeld read now waits for a paint, seconds apart on a loaded
       WebKit (#1705), so the poll and the test get room for several reads */
    test.setTimeout(120_000);
    await journey.fire(page);
    await expect(shownText(page, journey.words), `${journey.name}: the failure is shown`).toBeVisible();
    /* The end state, not a single read the instant the failure shows: focus may
       take a moment to settle, and what matters is where it STAYS -- so it has
       to hold one element for a run of painted frames, and a focus that only
       passed through an element on its way to the page (T-Q2) is not that. */
    await expect
      .poll(() => focusHeld(page), { message: `${journey.name}: focus is held on an element, not dropped to the page`, timeout: 60_000 })
      .not.toMatch(/^(body|moving)$/);
  });
}

/* #1182: while a decision is out, every decision control does nothing. Each
   test holds the approval request open (`page.route` waiting on a promise),
   presses again every way the reader can, and counts the decision requests
   that left the page: exactly one. The buttons are aria-disabled, never
   `disabled`, so a focused one keeps focus. */
test.describe("a decision in flight ignores every press (#1182)", () => {
  /** Holds the one approval open until `release()`; counts decision requests as
   *  the page sends them (an approval, or a dismissal's DELETE).
   * @param {Page} page */
  async function holdApproval(page) {
    /** @type {string[]} */
    const sent = [];
    /** Reads of the inbox list since the approval was let go: one, for the
     *  approval that landed. (The approval's own request is shared by every
     *  press while it is out, workspace.js approvalsInFlight, so a second press
     *  that got through a missing guard shows here, as a second re-read.)
     *  @type {string[]} */
    const rereads = [];
    let released = false;
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (released && request.method() === "GET" && pathname.endsWith("/api/imap-inbox")) rereads.push(pathname);
      if (request.method() === "POST" && pathname.endsWith("/api/reviewed-intake/approve")) sent.push("approve");
      if (request.method() === "DELETE" && pathname.includes("/api/imap-inbox/")) sent.push(`dismiss ${pathname.split("/").pop()}`);
    });
    await rememberMailDecisions(page);
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    await page.route("**/api/reviewed-intake/approve", guardedRoute(async (route) => {
      await gate;
      await route.fallback();
    }));
    return { sent, rereads, release: () => { released = true; release(); } };
  }

  /* A request that a press wrongly starts leaves after the page's own reads
     (assign, review: a few round trips on the fixture server); this is how
     long "nothing was sent" is watched for. */
  const NOTHING_FOLLOWS = 1_000;

  /** A forced press, which Playwright otherwise refuses on an aria-disabled
   *  button. If the press itself removes the control (a guard that is gone and
   *  a decision that landed), that is for the checks below to report, not a
   *  wait to time out on.
   * @param {import("@playwright/test").Locator} control */
  const press = (control) => control.click({ force: true, timeout: 3_000 }).catch(() => undefined);

  /** @param {import("@playwright/test").Locator} buttons @param {string} message */
  async function allHeld(buttons, message) {
    const count = await buttons.count();
    expect(count, `${message}: there are buttons to check`).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      await expect(buttons.nth(i), `${message} (#${i})`).toHaveAttribute("aria-disabled", "true");
    }
  }

  test("desk /inbox: a press, an Enter, or another receipt's buttons send nothing while an approval is out", async ({ page }) => {
    test.skip(isPocket(), "the desk's inbox");
    const { sent, release } = await holdApproval(page);
    try {
      await page.goto("/inbox");
      const yes = page.locator(".receipt .actions button.yes");
      const dismiss = page.locator(".receipt .actions button:not(.yes)");
      const remove = page.locator(".failed button");
      await expect(yes).toBeVisible();
      await expect(remove, "the failed message that can be removed is the other receipt").toHaveCount(1);
      /* Enter arms, Enter fires: one approval is out. */
      await yes.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await expect.poll(() => sent.length).toBe(1);
      await allHeld(page.locator(".receipt .actions button, .failed button"), "inbox: every receipt's decision buttons are held while one is out");

      /* again, by click (twice, as a two-tap act asks) and by Enter */
      await press(yes);
      await press(yes);
      await yes.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      /* a different receipt's buttons */
      await press(dismiss);
      await press(dismiss);
      await press(remove);
      await press(remove);
      await page.keyboard.press("Enter");
            await page.waitForTimeout(NOTHING_FOLLOWS);
      expect.soft(sent, "exactly one decision request was sent").toEqual(["approve"]);
      await expect(yes).toHaveAttribute("aria-disabled", "true");
    } finally {
      release();
    }
    /* the one approval lands once it is let go */
    await expect(page.locator(".receipt .actions button.yes")).toHaveCount(0);
    expect(sent).toEqual(["approve"]);
  });

  test("home drawer: approve, dismiss and review & amend do nothing while an approval is out", async ({ page }) => {
    test.skip(isPocket(), "the desk's drawer");
    const { sent, rereads, release } = await holdApproval(page);
    try {
      await page.goto(`/home?item=${SUGGESTION.id}`);
      const view = page.locator(`[id="${SUGGESTION.id}-view"]`);
      const yes = view.locator(".actions button.yes");
      const dismiss = view.locator(".actions button:not(.yes)");
      const amend = view.locator(".ivamend");
      await expect(yes).toBeEnabled();
      await yes.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await expect.poll(() => sent.length).toBe(1);
      await allHeld(view.locator(".actions button, .ivamend"), "drawer: approve, dismiss and review & amend are held");

      await press(yes);
      await press(yes);
      await yes.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await press(dismiss);
      await press(dismiss);
      await press(amend);
      await amend.focus({ timeout: 3_000 }).catch(() => undefined);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(NOTHING_FOLLOWS);
      expect.soft(sent, "exactly one decision request was sent").toEqual(["approve"]);
      await expect.soft(page.getByRole("group", { name: /^Amending/ }), "review & amend did not open").toHaveCount(0);
      await expect(view.locator(".actions button.yes")).toHaveAttribute("aria-disabled", "true");
    } finally {
      release();
    }
    await expect(page.locator(`[id="${SUGGESTION.id}-view"] .actions button.yes`)).toHaveCount(0);
    expect(sent).toEqual(["approve"]);
    await page.waitForTimeout(NOTHING_FOLLOWS);
    expect(rereads, "the approval that landed was followed by one re-read of the inbox").toHaveLength(1);
  });

  test("phone /inbox: the review card's buttons and review & amend do nothing while an approval is out", async ({ page }) => {
    test.skip(!isPocket(), "the phone's review card");
    const { sent, release } = await holdApproval(page);
    try {
      await page.goto("/inbox");
      const card = page.locator(".pki-card").filter({ visible: true }).first();
      const yes = card.locator(".rv-yes");
      const amend = card.locator(".rv-amend");
      await expect(yes).toBeVisible();
      /* the pill arms on the first tap, fires on the second */
      await press(yes);
      await press(yes);
      await expect.poll(() => sent.length).toBe(1);
      /* while it is out the pills are held (disabled) and review & amend is aria-disabled */
      await expect(card.locator(".rv-acts button")).toHaveCount(2);
      for (const pill of await card.locator(".rv-acts button").all()) await expect(pill).toBeDisabled();
      await expect(amend).toHaveAttribute("aria-disabled", "true");

      for (const pill of await card.locator(".rv-acts button").all()) {
        await press(pill);
        await press(pill);
      }
      await press(amend);
      await amend.focus({ timeout: 3_000 }).catch(() => undefined);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(NOTHING_FOLLOWS);
      expect.soft(sent, "exactly one decision request was sent").toEqual(["approve"]);
      await expect.soft(page.getByRole("dialog"), "review & amend did not open").toHaveCount(0);
    } finally {
      release();
    }
    await expect(page.locator(".pki-card .rv-yes")).toHaveCount(0);
    expect(sent).toEqual(["approve"]);
  });
});

/* #1705: proof that focusHeld can fail. It must not return before a painted
   frame has run, or a focus lost inside a requestAnimationFrame callback is
   never seen on a WebKit that paints seconds apart. The page's
   requestAnimationFrame is replaced by one that delivers its callbacks 3 s
   late, so the helper's 30 samples at 50 ms (about 1.5 s) end before the first
   frame. The tests assert where focus ended, not how long it took. */
test.describe("focusHeld waits for a painted frame (#1705)", () => {
  /** A signed-in page with focus on the name field and every
   *  requestAnimationFrame callback delivered 3 s late.
   * @param {Page} page */
  async function focusedWithLateFrames(page) {
    await gotoCreate(page);
    const nameField = page.getByRole("textbox", { name: "name", exact: true }).filter({ visible: true });
    await expect(nameField).toBeVisible();
    await nameField.focus();
    await expect(nameField).toBeFocused();
    await page.evaluate(() => {
      window.requestAnimationFrame = (callback) =>
        /** @type {number} */ (/** @type {unknown} */ (setTimeout(() => callback(performance.now()), 3_000)));
    });
  }

  test("focus lost inside a delayed animation frame is seen: body", async ({ page }) => {
    await focusedWithLateFrames(page);
    await page.evaluate(() => {
      window.requestAnimationFrame(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    });
    expect(await focusHeld(page), "focus was dropped to the page in a later frame, which focusHeld did not wait for").toBe("body");
  });

  test("focus that stays is still reported as the element", async ({ page }) => {
    await focusedWithLateFrames(page);
    const held = await focusHeld(page);
    expect(held).not.toMatch(/^(body|moving)$/);
    expect(held).toMatch(/^input/);
  });
});
