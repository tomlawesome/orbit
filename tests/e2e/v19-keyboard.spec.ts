import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { ensureLocalPassword } from "./support/local-credentials";
import { ensureWorkerAdministrator, workerAccount, workerFixturePassword, workerScopedAddress } from "./support/worker-identity";

/* #1235's first traced local WebKit run: the "press before home goes live"
   test below holds home back by delaying `/api/workspace` through
   page.route, and on desktop-webkit the trace showed both workspace reads
   answered in 13 ms and 36 ms -- the delay never applied, home went live,
   and the test's own precondition (`body[data-home-ready]` absent) failed.
   WebKit serves a request the service worker handles without going through
   Playwright's route. Same cure as v19-feedback-recovery.spec.ts,
   v19-mail-review.spec.ts and v19-hit-routing.spec.ts (#1219): nothing
   here is about the worker, so on WebKit it is kept out. */
test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
  },
});
import {
  auditLightDismiss,
  auditTabOrder,
  currentFocus,
  dismissTourIfShown,
  fillCreateForm,
  installKeyboardAudit,
  settled,
  tabTo,
} from "./support/keyboard";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #496: a keyboard-only pass over the core journeys — sign-in through to
 * sign-out — driven entirely by `page.keyboard.press`/`.type`. No `.click()`
 * anywhere in this file: every control is reached by Tab and worked with
 * Enter, Space or Escape, the way a reader who cannot use a pointer has to.
 *
 * DESKTOP ONLY. `--project=desktop-chromium`. The mobile pack is touch-first
 * (tap targets, sheets, swipe) and a keyboard-only pass over it is a
 * different exercise with a different law; out of scope here.
 *
 * Each test signs in fresh (or, for journeys that start from `/home`, arrives
 * there by seeding its own household first — see `arriveAtHome` below, same
 * shape as v19-axe-sweep.spec.ts's `arriveWithHousehold`) and cleans up its
 * own household in `finally`. #846: an earlier draft of this file shared one
 * page, one session and one seeded household across all fourteen tests via
 * `beforeAll`, so the first failure poisoned every test after it. Nothing
 * here is shared between tests.
 *
 * THE FIRST-RUN TOUR is not walked here. tests/e2e/v19-tour.spec.ts journey 5
 * ("the walk can be taken from the keyboard, and Escape skips") already
 * proves the tour's own keyboard path end to end. This file only has to
 * survive the tour turning up uninvited on a first landing — see
 * `dismissTourIfShown` below — not re-prove it.
 *
 * WHAT "reachable" MEANS. For each screen this file asks the browser, not a
 * static list, what is on screen: every `a[href]`, un-disabled
 * `button`/`input`/`select`/`textarea`, and anything with a non-negative
 * `tabindex`, that is not hidden by `display:none`, `visibility:hidden`,
 * `opacity:0`, a zero-sized `overflow:hidden` ancestor (the create form's
 * progressive-disclosure grid), or a `position:fixed` ancestor sitting off
 * the viewport (a closed drawer or account panel slid out by transform — see
 * home.css's `.drawer`/`.drawer-top`/`.account`). That set is compared
 * against what Tab actually visits. A control the screen shows that Tab
 * never lands on, or a focus stop that is not part of that set, fails the
 * test — the assertion is never loosened to match what the app happens to
 * do.
 *
 * LIGHT DISMISS, NOT A MODAL TRAP. design/owner-decisions.md's "Light
 * dismiss" ruling (2026-08-14) draws the three home drawers and the account
 * panel as non-modal: Escape closes them and a click outside closes them,
 * and opening one closes the others — nothing in the design promises Tab is
 * trapped inside them, so this file does not invent that requirement. What
 * it does assert, for every one of them, is what the ruling's own words
 * promise beyond "closes": that Escape hands focus back to the control that
 * opened it. That is checked for real — by tabbing INTO the panel's own
 * contents first, not by pressing Escape a beat after opening while focus is
 * still sitting on the toggle by accident — so it is not weakened into
 * passing by construction.
 *
 * The two elements actually marked `role="dialog"` in this build (home's
 * document card and the "request to join" veil) are never reached by the
 * journeys below — the seeded household is never in the empty-sky state the
 * join veil needs, and nothing here opens a document — so this file has no
 * case to test a real modal trap against; that gap is noted, not papered
 * over.
 *
 * Known product defect, not fixed here: #847 (/home: Tab reaches the closed
 * account panel's links and pack buttons; the search input has no focus
 * ring).
 */

/* #1080: this worker's own administrator, resolved lazily (worker env only). */
const READER = () => workerAccount("administrator");
const ITEM_TITLE = "Keyboard-reached boiler service";

/* The pocket layouts are different screens with their own chrome; their walk
   is #849. This file covers the desktop screens. */
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "desktop screens only; the pocket walk is #849");
});

async function signIn(page: Page, returnTo: string) {
  await answerPushWithoutAService(page);
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER() }).click();
  /* #1080: waits for the session, then holds administrator access. */
  await ensureWorkerAdministrator(page);
    /* #1096: every test in this file signs in when the instance holds no
     household at all -- the #1077 reset above puts the database back to a
     seed that has none, and each test cleans its own away -- so
     hooks.server.js sends the returnTo to `/` instead of to `/home`
     (web/src/hooks.server.js, the `!session.activeHouseholdId` branch). `/`
     is the arrival, and Arrival.svelte's `decide()` reads the workspace and
     hands a reader with somewhere onward to /home with `location.replace`.
     `seedHousehold` below turns that decision ONWARD while the read is still
     in flight, so the replace cancels the `page.goto("/home")` the caller
     makes a beat later: Chromium reports the cancelled one as
     `net::ERR_ABORTED`, naming the navigation rather than the redirect that
     killed it. Three CI sightings (pipelines 907, 1275 and 1491) all show the
     same two /home document requests milliseconds apart, the aborted one
     Playwright's and the survivor carrying `Referer: /`. `settleArrival`
     waits for the arrival's decision to land first, which is the fix 72d8efd0
     made for #840 everywhere else and missed here. */
  await settleArrival(page);
}

/**
 * A household of the signed-in reader's own, through the same
 * `household.create` / `item.upsert` commands v19-entry.spec.ts and
 * v19-create.spec.ts use — same shape as v19-axe-sweep.spec.ts's
 * `seedHousehold`. Named distinctively (this file's own prefix plus a random
 * id) since other specs may run against the same shared stack at the same
 * time.
 */
async function seedHousehold(page: Page, options: { withItem?: boolean } = {}) {
  const name = `keyboard-${randomUUID()}`;
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };

  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: householdId,
        name,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    },
  });
  if (!created.ok()) throw new Error(`#496: could not seed household "${name}" (${created.status()})`);

  let itemId: string | undefined;
  if (options.withItem) {
    itemId = randomUUID();
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const itemCreated = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId,
        kind: "service",
        item: {
          id: itemId,
          sectionId,
          title: ITEM_TITLE,
          currency: "GBP",
          dueDate,
          recurrenceMonths: 12,
        },
        activity: { id: randomUUID(), itemId, occurredAt: new Date().toISOString() },
      },
    });
    if (!itemCreated.ok()) {
      throw new Error(`#496: could not seed item for "${name}" (${itemCreated.status()})`);
    }
  }

  return { id: householdId, name, itemId };
}

/** #730: every household this file makes is removed, even when the test fails. */
async function cleanup(page: Page, household: { id: string; name: string }) {
  await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
}

/* ────────────────────────────────────────────────────────────────────────
 * The keyboard-audit machinery (installKeyboardAudit, collectVisible,
 * currentFocus, tabTo, auditTabOrder, auditLightDismiss, dismissTourIfShown,
 * settled, fillCreateForm) lives in ./support/keyboard.ts and is imported
 * above — shared verbatim with v19-keyboard-pocket.spec.ts (#849).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Signs in, seeds a household of the reader's own, installs the keyboard
 * audit and lands settled on `/home`. Same shape as
 * v19-axe-sweep.spec.ts's `arriveWithHousehold`. Callers clean up the
 * returned household in `finally`.
 */
async function arriveAtHome(page: Page, options: { withItem?: boolean } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page, options);
  await page.goto("/home");
  await settled(page);
  return household;
}

/** #424: the manifest row expands in place on Enter (it is not a plain
 *  navigation — onRowClick calls preventDefault). #1319 (owner-decisions
 *  §34): the drawer it opens is the item now, holding everything the item
 *  page (the belt) did, and the belt's own address only redirects here. So
 *  the item is reached the way a reader reaches it: Tab to its row, Enter,
 *  and the drawer's foot row is next in the order. Shared by the two drawer
 *  tests below so each gets this same path on its own fresh page. */
async function openDrawerFromHome(page: Page, itemId: string) {
  await page.goto("/home");
  await settled(page);
  await tabTo(page, { selector: `a.item[id="${itemId}"]` }, { screen: "home corridor row" });
  await page.keyboard.press("Enter");
  await expect(page.locator(`a.item[id="${itemId}"]`)).toHaveClass(/open/);
  await expect(page.locator(`[id="${itemId}-view"]`).getByRole("group", { name: `Actions for ${ITEM_TITLE}` }))
    .toBeVisible({ timeout: 20_000 });
}

/** The item as the server holds it now. */
async function serverItem(page: Page, householdId: string, itemId: string) {
  const response = await page.request.get("/api/workspace", { headers: await sessionHeaders(page) });
  const body = (await response.json()) as {
    workspace: { households: { id: string; items?: { id: string; dueDate?: string | null; snoozedUntil?: string | null }[] }[] };
  };
  return body.workspace.households.find((one) => one.id === householdId)?.items?.find((one) => one.id === itemId) ?? null;
}

/** Waits for the chooser card's calendar to take focus (it moves focus in
 *  the frame the card is seen), then pages a month on and picks that day:
 *  PageDown and Enter, the calendar's own keys (calendar.js stepDay). */
async function pickNextMonthByKeyboard(page: Page, chooser: Locator) {
  await expect(chooser).toBeVisible();
  await expect.poll(() => chooser.evaluate((el) => el.contains(document.activeElement) && document.activeElement?.matches("button.day"))).toBe(true);
  await page.keyboard.press("PageDown");
  await page.keyboard.press("Enter");
  await expect(chooser).toHaveCount(0);
}

/** Reaches household management the way the sun's own door works (§15,
 *  owner ruling 2026-08-17): Tab to the sun on the dial, Enter. Shared by
 *  both household tests so each drives it on its own fresh page. */
async function openHouseholdFromHome(page: Page) {
  await page.goto("/home");
  await settled(page);
  await tabTo(page, { selector: "a.sun-link" }, { screen: "home" });
  const sun = await currentFocus(page);
  expect(sun?.focusVisible, "home: the sun link has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/household\//);
}

/** Reaches /settings the way a reader would: home's account panel, its
 *  Settings link. Shared so both settings tests below drive it fresh.
 *
 * settings/+page.svelte renders its `<h1>` immediately but gates every card
 * (You, Your sky, Reminders, Your relay, household list, sign out
 * everywhere) behind `{#if view}`, and `view` is only set once
 * `onMount`'s own `readSettingsScreen()` fetch resolves — confirmed by
 * instrumenting a throwaway page: right after the URL becomes `/settings`
 * only 11 interactive controls exist in the DOM (the heading and chrome);
 * ~500ms later, once `view` has arrived, that is 34. Waiting only for the
 * URL (as this helper used to) let `auditTabOrder`'s `collectVisible` snapshot
 * that empty-ish moment as "expected", so every one of those 23 real,
 * genuinely-reachable controls came back later as Tab visiting something
 * "the screen does not show as visible" — not a `collectVisible` bug (rect,
 * `visibility`, scrolling all check out fine once `view` has loaded; see
 * the diagnostic in the #846 follow-up), and not a real reachability defect
 * either. Waiting for `.cards` — the wrapper `{#if view}` itself renders —
 * closes the race. */
async function openSettingsFromHome(page: Page) {
  await page.goto("/home");
  await settled(page);
  await tabTo(page, { selector: "button.orb" }, { screen: "home" });
  await page.keyboard.press("Enter");
  await tabTo(page, { tag: "A", textIncludes: "Settings" }, { screen: "home account panel" });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 });
  /* The sign-in methods block (#915) is read after the helm itself, so an
     audit that starts on `.cards` alone collects its expected set before the
     block's buttons exist and then meets them by Tab. Wait for the rows. */
  await expect(page.locator(".method").first()).toBeVisible({ timeout: 30_000 });
}

/* ────────────────────────────────────────────────────────────────────────
 * The journeys. One `test(...)` per screen state; each signs in and seeds
 * its own household (where one is needed), and cleans it up in `finally`.
 * ──────────────────────────────────────────────────────────────────────── */

test("arrive: the sign-in door opens by Tab and Enter alone", async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);

  /* A reader with no household lands on the newcomer stage, not the dial
     `settled` waits for — and on a fresh stack every other test here has
     cleaned its household away (pipeline 487, job 3948). Seed one first,
     then drop the session so the walk really starts from the door. */
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  await context.clearCookies();
  try {
    /* Signed out, asking for /home is redirected to Orbit's own /login — the
       door every screen sends a signed-out reader through (v19-entry.spec.ts). */
    await page.goto("/home");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fhome$/);

    await tabTo(page, { selector: "#gate" }, { screen: "sign-in" });
    const gate = await currentFocus(page);
    expect(gate?.focusVisible, "sign-in: the Sign in button has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");

    /* SignIn.svelte's press() hands off to /api/auth/login after its own
       flight beat, which redirects on to the OIDC provider. Wait for the /login
       screen itself to be left rather than guessing the provider's URL shape. */
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10_000 });

    /* The provider lists identities as links (tests/e2e/v19-entry.spec.ts);
       Tab to the one this suite signs in as and press Enter rather than
       clicking it. */
    await tabTo(page, { tag: "A", textIncludes: READER() }, { screen: "identity provider" });
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
    await settled(page);
  } finally {
    // The walk may have failed before the door was through: sign in again
    // so the seed is removed either way.
    await signIn(page, "/home");
    await cleanup(page, household);
  }
});

test("home: every control is reachable, focus is visible, and Tab is not trapped", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page, { withItem: true });
  try {
    await auditTabOrder(page, "home");
  } finally {
    await cleanup(page, household);
  }
});

test("home: the account panel and the three drawers are light-dismiss by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await auditLightDismiss(page, "home", "button.orb", "#account");
    await auditLightDismiss(page, "home", "#nstar", "#createdrawer");
    await auditLightDismiss(page, "home", "#edge-health", "#statusdrawer");
    await auditLightDismiss(page, "home", "#keydrawer .handle", "#keydrawer");
  } finally {
    await cleanup(page, household);
  }
});

/**
 * #1064: the press that arrives before home can answer.
 *
 * The server renders home whole (#842), so the avatar is on screen, lettered
 * and tabbable long before the client's own readHome() has resolved and the
 * behaviour has been bound to it. A press inside that window used to be
 * dropped outright — no listener, no replay — and the panel stayed shut for
 * good, which is what the CI flake looked like from the outside:
 * `aria-expanded` stuck at "false" across a whole 5s poll.
 *
 * Driven by delaying `/api/workspace`, the slowest of readHome()'s three
 * reads, so the window is wide enough to press into on purpose rather than
 * by luck. The panel must end up open: either the press is held and applied
 * when the screen goes live, or the wait was never needed.
 */
test("home: an Enter on the avatar before home goes live still opens the account panel", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.route("**/api/workspace", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      await route.continue();
    });
    await page.goto("/home");
    await dismissTourIfShown(page);
    /* Deliberately NOT settled(): this test exists to press while the screen
       is still the server's own render. The orb is here because the server
       sent it — assert that, so a future markup change cannot turn this into
       a test that presses nothing. */
    await expect(page.locator("button.orb")).toBeVisible();
    await expect(page.locator("body[data-home-ready]")).toHaveCount(0);
    await tabTo(page, { selector: "button.orb" }, { screen: "home (not yet live)" });
    await page.keyboard.press("Enter");
    await expect(page.locator("#account")).toHaveClass(/open/, { timeout: 20_000 });
    await expect(page.locator("button.orb")).toHaveAttribute("aria-expanded", "true");
  } finally {
    await page.unroute("**/api/workspace").catch(() => {});
    await cleanup(page, household);
  }
});

test("home: a dial planet link is reachable and activates by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page, { withItem: true });
  try {
    /* The seeded item's body on the dial is a real <a href="#<id>">; Enter
       follows it like any link, landing on (and focusing) the matching
       corridor row (#424: the row is the item, sharing that id). Attribute
       selectors throughout: a UUID id is a perfectly legal HTML id but not
       always a legal bare CSS identifier (one starting with a digit isn't),
       so it is never interpolated as `#${id}`. */
    await tabTo(page, { selector: `a.body-link[href="#${household.itemId}"]` }, { screen: "home dial" });
    const body = await currentFocus(page);
    expect(body?.focusVisible, "home: the dial body-link has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator(`a.item[id="${household.itemId}"]`)).toBeFocused();
  } finally {
    await cleanup(page, household);
  }
});

/* #1319: was "item page: reached from home's manifest by keyboard, is fully
   reachable", which audited /item/<id>. The item is home's drawer now, so
   the same audit runs over home with the drawer open: every control the
   drawer shows (its documents, the foot row's pills, the pencil, the copy
   link) is reached by Tab, focus is visible on each, and Tab is not trapped. */
test("item drawer: opened from home's manifest by keyboard, is fully reachable", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page, { withItem: true });
  try {
    await openDrawerFromHome(page, household.itemId as string);
    await auditTabOrder(page, "home with the item drawer open");
  } finally {
    await cleanup(page, household);
  }
});

/* #1319: was "item page: actions and the back link work by keyboard"
   (reschedule through the belt's panel, then its "← YOUR SKY" link). The
   drawer's acts are snooze (the calendar, "snooze until") and the pencil,
   whose due date is the reschedule; the way back is Escape, which puts the
   drawer away (owner-decisions "Light dismiss"). */
test("item drawer: rescheduling, snooze and the way back work by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page, { withItem: true });
  const itemId = household.itemId as string;
  try {
    await openDrawerFromHome(page, itemId);
    const drawer = page.locator(`[id="${itemId}-view"]`);
    const dueBefore = (await serverItem(page, household.id, itemId))?.dueDate;

    /* Reschedule: the pencil puts the rows into edit, the due date opens
       the calendar, a day picked and save sends it. */
    await tabTo(page, { selector: 'button[aria-label="Edit this item"]' }, { screen: "item drawer foot row" });
    const pencil = await currentFocus(page);
    expect(pencil?.focusVisible, "item drawer: the pencil has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator(`[id="${itemId}"]`).getByRole("textbox", { name: "title" })).toBeFocused();
    await tabTo(page, { selector: '[aria-label^="due: "]' }, { screen: "item drawer, editing" });
    const due = await currentFocus(page);
    expect(due?.focusVisible, "item drawer: the due date has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await pickNextMonthByKeyboard(page, page.getByRole("dialog", { name: /due date/i }));
    /* save waits on the engine's dry run of the rows (edit-session.svelte.js
       `refused`); until then the button is aria-disabled (still in the Tab
       order, #1327) and Enter on it does nothing */
    const save = drawer.getByRole("group", { name: `Editing ${ITEM_TITLE}` }).getByRole("button", { name: "save" });
    await expect(save).toBeEnabled({ timeout: 10_000 }).catch(async () => {
      throw new Error(`item drawer: save stayed disabled; the drawer read: ${await drawer.innerText()}`);
    });
    await tabTo(page, { tag: "BUTTON", textIncludes: "save" }, { screen: "item drawer, editing" });
    await page.keyboard.press("Enter");
    await expect(drawer.getByRole("group", { name: `Actions for ${ITEM_TITLE}` })).toBeVisible({ timeout: 10_000 });
    await expect(drawer.getByRole("alert")).toHaveCount(0);
    await expect.poll(async () => (await serverItem(page, household.id, itemId))?.dueDate).not.toBe(dueBefore);

    /* Snooze: the pill opens the calendar beside the drawer; a day picked
       by keyboard snoozes the item. */
    await tabTo(page, { selector: `[aria-label="Snooze ${ITEM_TITLE}"]` }, { screen: "item drawer foot row" });
    const snooze = await currentFocus(page);
    expect(snooze?.focusVisible, "item drawer: the snooze pill has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await pickNextMonthByKeyboard(page, page.getByRole("dialog", { name: /snooze until/i }));
    await expect(drawer.getByText("snoozed until")).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await serverItem(page, household.id, itemId))?.snoozedUntil ?? null).not.toBeNull();
    /* The pick hands focus back to the snooze pill (drawer-modes.svelte.js
       closeChooser); a keyboard reader carries on from there, so it must
       still be in the drawer once the snooze has landed. */
    await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement)),
      { message: "item drawer: focus left the drawer after the snooze" }).toBe(true);

    /* The way back: Escape puts the drawer away and leaves home as it was. */
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.locator(`a.item[id="${itemId}"]`)).not.toHaveClass(/open/);
    await expect(page).toHaveURL(/\/home$/);
  } finally {
    await cleanup(page, household);
  }
});

test("create: the whole form is reachable in order", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await fillCreateForm(page, "Keyboard-only proving ground (audit)");
    await auditTabOrder(page, "create form");
  } finally {
    await cleanup(page, household);
  }
});

test("create: fillable and submittable by keyboard alone", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    const name = "Keyboard-only proving ground";
    await fillCreateForm(page, name);

    await tabTo(page, { selector: ".btn-primary" }, { screen: "create form" });
    const submit = await currentFocus(page);
    expect(submit?.focusVisible, "create: the submit button has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");

    /* #1246: a save lands on home with the item it saved open. */
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]+$/, { timeout: 10_000 });
    await expect(page.locator(".item", { hasText: name })).toBeVisible();
  } finally {
    await cleanup(page, household);
  }
});

test("household page: reached from home's sun by keyboard, and is fully reachable", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await openHouseholdFromHome(page);
    /* Scoped away from `.cand`: "Add someone" lists every account on this
       shared acceptance instance not yet in the household, which grows over
       the stack's lifetime as unrelated specs create accounts — genuinely
       unbounded and not part of what this test is proving. Everything else on
       the screen is still audited in full. */
    /* #1002: the archive's unselected tab is out of the Tab order by
       design (the WAI-ARIA tabs pattern: the tablist is one Tab stop and
       ← → move between its tabs), so it is proved by arrow key below rather
       than by Tab — the same split the pocket file makes (#1122). */
    await auditTabOrder(page, "household page", {
      exclude: '.cand, [role="tab"][aria-selected="false"]',
    });
    const archive = page.getByRole("tablist", { name: "The archive" });
    await tabTo(page, { selector: '[role="tab"][aria-selected="true"]' }, { screen: "household page archive" });
    await page.keyboard.press("ArrowRight");
    await expect(archive.getByRole("tab", { name: "bring one in" })).toBeFocused();
    await expect(archive.getByRole("tab", { name: "bring one in" })).toHaveAttribute("aria-selected", "true");
  } finally {
    await cleanup(page, household);
  }
});

test("household page: the back link works by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await openHouseholdFromHome(page);
    await tabTo(page, { selector: "a.back" }, { screen: "household page" });
    const back = await currentFocus(page);
    expect(back?.focusVisible, "household page: the back link has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/home/);
  } finally {
    await cleanup(page, household);
  }
});

test("settings: reached via the account panel, and fully reachable", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await openSettingsFromHome(page);
    /* #1003: the Reminders card's tabs (owner-decisions §22) are one Tab
       stop with ← → between them, so the unchosen tab is proved by arrow
       key below, not by Tab — as the pocket file does. */
    await auditTabOrder(page, "settings", { exclude: '[role="tab"][aria-selected="false"]' });
    const reminders = page.getByRole("tablist", { name: "Reminders" });
    await tabTo(page, { selector: '#rem-tab-reminders' }, { screen: "settings reminders" });
    await page.keyboard.press("ArrowRight");
    await expect(reminders.getByRole("tab", { name: "sent to you lately" })).toBeFocused();
    await expect(reminders.getByRole("tab", { name: "sent to you lately" })).toHaveAttribute("aria-selected", "true");
  } finally {
    await cleanup(page, household);
  }
});

test("settings: the account panel is light-dismiss by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await openSettingsFromHome(page);
    /* Chrome.svelte's account panel is shared by settings, household and
       inbox, and is the same "light dismiss" control home's own account panel
       is — the same promise is checked here rather than assumed to carry
       over, since Chrome.svelte is a different implementation of it. */
    await auditLightDismiss(page, "settings", "button.orb", "#account");
  } finally {
    await cleanup(page, household);
  }
});

test("inbox: reachable via the account panel, and keyboard-navigable", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await tabTo(page, { selector: "button.orb" }, { screen: "home" });
    await page.keyboard.press("Enter");
    await tabTo(page, { tag: "A", textIncludes: "Inbox" }, { screen: "home account panel" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/inbox$/);
    /* The inbox draws its queue or its empty-state relay bar only once the
       view has loaded; audit the loaded screen, not the shell. */
    await expect(page.locator(".inbox-page .lanes, .inbox-page .quietnote").first()).toBeVisible({ timeout: 30_000 });

    await auditTabOrder(page, "inbox");
  } finally {
    await cleanup(page, household);
  }
});

test("sign out: the one-press control ends the session by keyboard alone", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await tabTo(page, { selector: "button.orb" }, { screen: "home" });
    await page.keyboard.press("Enter");
    await tabTo(page, { selector: ".signout" }, { screen: "home account panel" });
    const signOut = await currentFocus(page);
    expect(signOut?.focusVisible, "home: the sign-out control has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter"); // revokes the session, then plays the descent (one press: owner, 2026-10-06)

    await expect(page).toHaveURL(/\/logout$/, { timeout: 15_000 });
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      return (await response.json()) as { authenticated?: boolean };
    });
    expect(session.authenticated, "sign out: the session is still authenticated after the sign-out control fired").toBeFalsy();

    /* Cleanup needs a live session again — sign back in the same keyboard way
       the arrival journey proved, so this test's own household can still be
       removed once it revoked the session that was carrying it. */
    await page.goto("/api/auth/login?returnTo=/home");
    await tabTo(page, { tag: "A", textIncludes: READER() }, { screen: "identity provider" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
  } finally {
    await cleanup(page, household);
  }
});

/* ────────────────────────────────────────────────────────────────────────
 * SIGN-IN METHODS AND ADMIN-CREATED LOCAL USERS (#915).
 *
 * Two blocks arrived with M7, and both are worked entirely by Tab and Enter
 * here like everything above. What is new about them, and what these two
 * tests are actually for, is that each control opens ANOTHER control: the
 * two-tap protocol arms an action and a field appears under it. A field a
 * pointer reveals and a keyboard cannot reach is exactly the defect this
 * file exists to catch, so the audit is run with the challenge OPEN, not
 * only on the resting screen.
 *
 * `aria-expanded` is the screen-reader half of the same promise: the armed
 * state is announced rather than only drawn, so a reader who cannot see the
 * field appear is still told the control opened something.
 *
 * Both need a reader who HAS a password, because that is who is challenged
 * with a field; an account with only a provider identity is challenged at
 * the provider instead, which is a navigation and a different journey (it is
 * walked in sign-in-methods.spec.ts). `ensureLocalPassword` is idempotent
 * while every file sends the same password (see FIXTURE_PASSWORD), so a
 * retried file meets the state the first attempt did.
 * ──────────────────────────────────────────────────────────────────────── */

const KEYBOARD_PASSWORD = () => workerFixturePassword(READER());

test("settings: the sign-in-methods challenge arms by keyboard and is reachable", async ({ page }) => {
  test.setTimeout(90_000);
  const household = await arriveAtHome(page);
  try {
    await openSettingsFromHome(page);
    await ensureLocalPassword(page, READER(), KEYBOARD_PASSWORD());
    await page.goto("/settings");
    await expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 });

    const change = page.locator(".method button", { hasText: "change" }).first();
    await expect(change).toHaveAttribute("aria-expanded", "false");

    await tabTo(page, { selector: ".method button", textIncludes: "change" }, { screen: "settings" });
    const armer = await currentFocus(page);
    expect(armer?.focusVisible, "settings: the change-password action has no visible focus indicator").toBe(true);

    await page.keyboard.press("Enter");
    await expect(change).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".challenge")).toBeVisible();

    /* The whole screen again, with the challenge standing open: its two
       fields and its two buttons have to be in the tab order like anything
       else the screen is now showing. */
    /* The Reminders tabs' unchosen tab is off the Tab order by design; the
       reachable-settings test above proves it by arrow key. */
    await auditTabOrder(page, "settings with the sign-in challenge open", {
      exclude: '[role="tab"][aria-selected="false"]',
    });
  } finally {
    await cleanup(page, household);
  }
});

test("administration: the local-user controls are reachable and announced", async ({ page }) => {
  test.setTimeout(90_000);
  const household = await arriveAtHome(page);
  try {
    await openSettingsFromHome(page);
    await ensureLocalPassword(page, READER(), KEYBOARD_PASSWORD());

    /* #1077: a NEIGHBOUR on the roster, made here rather than inherited. The
       per-person control asserted at the end of this test needs a row that is
       somebody other than the reader, and until the database went back to its
       seed between spec files this test was quietly relying on accounts other
       specs happened to have created before it ran -- which is the same
       cross-file coupling that made the tab-order failures move around.
       Created through the route the screen's own form calls, with the
       password `ensureLocalPassword` has just set answering the challenge, so
       the roster it reads is a real one. The address carries the clock
       because the account outlives this test: the reset takes it away at the
       next spec file, but a retry of THIS file inside the same one would
       otherwise collide with the address it used the first time.
       #1080: and it carries THIS WORKER's slot, because the roster is
       instance-wide -- every worker's neighbours are on the list this test
       tabs through, so two workers minting the same address in the same
       millisecond would be a unique-constraint failure, and a neighbour with
       no slot in its name could not be told from another worker's. */
    const neighbour = await page.request.post("/api/admin/users", {
      headers: await sessionHeaders(page),
      data: {
        email: workerScopedAddress(`roster-neighbour-${Date.now()}`),
        displayName: "Roster Neighbour",
        currentPassword: KEYBOARD_PASSWORD(),
      },
    });
    expect(neighbour.status(), "administration: the roster neighbour was refused").toBe(201);

    await page.goto("/administration");
    await expect(page.locator(".card").first()).toBeVisible({ timeout: 30_000 });

    /* Every field in the row is a labelled control, which is what lets a
       screen reader say what is being asked for rather than "edit text". */
    const row = page.locator("form.localuser").first();
    await expect(row.getByLabel("email")).toBeVisible();
    await expect(row.getByLabel("display name")).toBeVisible();
    await expect(row.getByLabel("link valid for")).toBeVisible();

    /* The row is a real form: its fields are `required`, so an empty Create
       is stopped by the browser before the screen sees it. Fill it the way
       a keyboard user would, then arm. Nothing is created: the challenge
       opens, and the test never confirms it. */
    await row.getByLabel("email").fill(`keyboard-${Date.now()}@example.invalid`);
    await row.getByLabel("display name").fill("Keyboard Newcomer");

    /* Arming Create by keyboard opens the challenge, and the field it opens
       is the very next thing Tab reaches. */
    await tabTo(page, { selector: "form.localuser button[type=submit]" }, { screen: "administration" });
    const create = await currentFocus(page);
    expect(create?.focusVisible, "administration: the create action has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(row.getByLabel("your current password")).toBeVisible();
    await tabTo(page, { selector: "#localuser-current" }, { screen: "administration challenge" });
    const field = await currentFocus(page);
    expect(field?.focusVisible, "administration: the challenge field has no visible focus indicator").toBe(true);

    /* And the per-person control says who it is for, and whether it is open,
       rather than repeating one unlabelled phrase down the roster. */
    const resend = page
      .locator(".person")
      .filter({ hasNotText: "· you" })
      .first()
      .getByRole("button", { name: /send a new setup link/ });
    await expect(resend).toHaveAttribute("aria-expanded", "false");
    await expect(resend).toHaveAttribute("aria-label", /send a new setup link to .+/);
  } finally {
    await cleanup(page, household);
  }
});
