import { expect as baseExpect, test } from "@playwright/test";

import {
  auditLightDismiss,
  auditTabOrder,
  currentFocus,
  fillCreateForm,
  installKeyboardAudit,
  proveRadioGroupByArrows,
  settled,
  tabTo,
  uncheckedRadiosOf,
} from "../../../tests/e2e/support/keyboard";
import { APP, door, onPhone, rememberWrites, RIG_EXPECT_MS, RIG_TEST_MS, signedIn } from "./a11y-support.js";

/* The rig's waits (a11y-support.js RIG_EXPECT_MS, RIG_TEST_MS): the stack's explicit long waits are gone with its sign-in, but the host is shared. */
const expect = baseExpect.configure({ timeout: RIG_EXPECT_MS });
test.describe.configure({ timeout: RIG_TEST_MS });

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */

/*
 * #496, moved to the rig (ADR-0039, #1609): a keyboard-only pass over the
 * desk screens, driven entirely by `page.keyboard.press`/`.type`. No `.click()`
 * anywhere in this file: every control is reached by Tab and worked with
 * Enter, Space or Escape, the way a reader who cannot use a pointer has to.
 *
 * DESK ONLY (the `rig-desktop` project and the other desk engines). The pocket
 * screens are walked by v19-keyboard-pocket.spec.js.
 *
 * The arrival ("the sign-in door opens by Tab and Enter alone") and "sign out"
 * ran against the stack's real identity provider and a real session. Here the
 * keyboard half is what is proven: the door's button is reached and works by
 * keys and hands the browser to /api/auth/login; the sign-out control is
 * reached and works by keys, sends the logout request and lands on /logout
 * with the session gone. The provider's own identity list and its end-session
 * trip are not the keyboard's; the stack's other sign-in specs cover them.
 *
 * Each test starts from the fixture app's own Harlow Home (the five-household
 * fixture workspace) and installs the keyboard audit before the page loads.
 * Nothing is seeded and nothing is cleaned up. A write a test makes goes
 * through `rememberWrites`, which answers it and shows it back on the next
 * read, because the fixture server persists nothing.
 *
 * WHAT "reachable" MEANS. For each screen this file asks the browser, not a
 * static list, what is on screen: every `a[href]`, un-disabled
 * `button`/`input`/`select`/`textarea`, and anything with a non-negative
 * `tabindex`, that is not hidden by `display:none`, `visibility:hidden`,
 * `opacity:0`, a zero-sized `overflow:hidden` ancestor, or a `position:fixed`
 * ancestor sitting off the viewport (a closed drawer or account panel slid out
 * by transform). That set is compared against what Tab actually visits. A
 * control the screen shows that Tab never lands on, or a focus stop that is
 * not part of that set, fails the test -- the assertion is never loosened to
 * match what the app happens to do.
 *
 * LIGHT DISMISS, NOT A MODAL TRAP. design/owner-decisions.md's "Light dismiss"
 * ruling (2026-08-14) draws the three home drawers and the account panel as
 * non-modal: Escape closes them and a click outside closes them, and opening
 * one closes the others. What is asserted for every one of them is what the
 * ruling's own words promise beyond "closes": that Escape hands focus back to
 * the control that opened it, checked by tabbing INTO the panel's own contents
 * first.
 *
 * Known product defect, not fixed here: #847 (/home: Tab reaches the closed
 * account panel's links and pack buttons; the search input has no focus ring).
 *
 * `baseURL` is the fixture app, so the stack suite's keyboard helpers
 * (tests/e2e/support/keyboard.ts) run as they stand.
 */
test.use({ baseURL: APP });

/* The fixture workspace's Boiler service, in Harlow Home's Home section. */
const ITEM_ID = "i-boiler";
const ITEM_TITLE = "Boiler service";

test.beforeEach(({}, testInfo) => {
  test.skip(onPhone(testInfo), "desk screens only; the pocket walk is v19-keyboard-pocket.spec.js");
});

/**
 * Installs the keyboard audit and lands settled on `/home`, in the fixture
 * state `/home` / `rest`, with motion reduced so the audit reads the screen
 * drawn.
 * @param {Page} page
 */
async function arriveAtHome(page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  await signedIn("/home", "rest")(page);
  await settled(page);
}

/** #424: the manifest row expands in place on Enter (it is not a plain
 *  navigation -- onRowClick calls preventDefault). #1319 (owner-decisions
 *  §34): the drawer it opens is the item now, holding everything the item page
 *  (the belt) did; it opens from `/home?item=<id>`. So the item is reached the
 *  way a reader reaches it: Tab to its row, Enter, and the drawer's foot row is
 *  next in the order. Shared by the two drawer tests below.
 * @param {Page} page */
async function openDrawerFromHome(page) {
  await tabTo(page, { selector: `a.item[id="${ITEM_ID}"]` }, { screen: "home corridor row" });
  await page.keyboard.press("Enter");
  await expect(page.locator(`a.item[id="${ITEM_ID}"]`)).toHaveClass(/open/);
  await expect(page.locator(`[id="${ITEM_ID}-view"]`).getByRole("group", { name: `Actions for ${ITEM_TITLE}` })).toBeVisible();
}

/** The item as the fixture workspace holds it.
 * @param {Page} page */
async function fixtureItem(page) {
  const body = await (await page.request.get(`${APP}/api/workspace`)).json();
  return body.workspace.households.flatMap((/** @type {any} */ one) => one.items ?? [])
    .find((/** @type {any} */ item) => item.id === ITEM_ID);
}

/** Waits for the chooser card's calendar to take focus (it moves focus in the
 *  frame the card is seen), then pages a month on and picks that day:
 *  PageDown and Enter, the calendar's own keys (calendar.js stepDay).
 * @param {Page} page @param {Locator} chooser */
async function pickNextMonthByKeyboard(page, chooser) {
  await expect(chooser).toBeVisible();
  await expect.poll(() => chooser.evaluate((el) => el.contains(document.activeElement) && document.activeElement?.matches("button.day"))).toBe(true);
  await page.keyboard.press("PageDown");
  await page.keyboard.press("Enter");
  await expect(chooser).toHaveCount(0);
}

/** Reaches household management the way the sun's own door works (§15, owner
 *  ruling 2026-08-17): Tab to the sun on the dial, Enter. Shared by both
 *  household tests.
 * @param {Page} page */
async function openHouseholdFromHome(page) {
  await tabTo(page, { selector: "a.sun-link" }, { screen: "home" });
  const sun = await currentFocus(page);
  expect(sun?.focusVisible, "home: the sun link has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/household\//);
}

/** Reaches /settings the way a reader would: home's account panel, its
 *  Settings link. settings/+page.svelte renders its `<h1>` immediately but
 *  gates every card behind `{#if view}`, which is set once `onMount`'s own read
 *  resolves, so an audit that starts on the URL alone snapshots an empty-ish
 *  screen as "expected" and then meets the real controls by Tab. Waiting for
 *  `.cards` -- the wrapper `{#if view}` itself renders -- closes the race.
 * @param {Page} page */
async function openSettingsFromHome(page) {
  await tabTo(page, { selector: "button.orb" }, { screen: "home" });
  await page.keyboard.press("Enter");
  await tabTo(page, { tag: "A", textIncludes: "Settings" }, { screen: "home account panel" });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".cards")).toBeVisible();
  /* The sign-in methods block (#915) is read after the helm itself, so an audit
     that starts on `.cards` alone collects its expected set before the block's
     buttons exist and then meets them by Tab. Wait for the rows. */
  await expect(page.locator(".method").first()).toBeVisible();
}

/* ────────────────────────────────────────────────────────────────────────
 * The journeys. One `test(...)` per screen state.
 * ──────────────────────────────────────────────────────────────────────── */

test("arrive: the sign-in door opens by Tab and Enter alone", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  /* The hand-off goes to the provider through /api/auth/login: answer it, and
     see which address the press asked for. */
  const handedOff = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/login");
  await page.route("**/api/auth/login**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>identity provider</title>" }));
  await door("door", "rest")(page);
  await expect(page).toHaveURL(`${APP}/`);

  await tabTo(page, { selector: "#gate" }, { screen: "sign-in" });
  const gate = await currentFocus(page);
  expect(gate?.focusVisible, "sign-in: the Sign in button has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");

  /* SignIn.svelte's press() hands off to /api/auth/login after its own flight
     beat, asking to come back to where the reader was. */
  const request = await handedOff;
  expect(new URL(request.url()).searchParams.get("returnTo"), "sign-in: the press asks to return to the door's own address").toBe("/");
  await page.waitForURL((url) => !url.pathname.startsWith("/login") && url.pathname !== "/", { timeout: 10_000 });
});

test("home: every control is reachable, focus is visible, and Tab is not trapped", async ({ page }) => {
  await arriveAtHome(page);
  await auditTabOrder(page, "home");
});

test("home: the account panel and the three drawers are light-dismiss by keyboard", async ({ page }) => {
  await arriveAtHome(page);
  await auditLightDismiss(page, "home", "button.orb", "#account");
  await auditLightDismiss(page, "home", "#nstar", "#createdrawer");
  await auditLightDismiss(page, "home", "#edge-health", "#statusdrawer");
  await auditLightDismiss(page, "home", "#keydrawer .handle", "#keydrawer");
});

/**
 * #1064: the press that arrives before home can answer.
 *
 * The server renders home whole (#842), so the avatar is on screen, lettered
 * and tabbable long before the client's own readHome() has resolved and the
 * behaviour has been bound to it. A press inside that window used to be dropped
 * outright -- no listener, no replay -- and the panel stayed shut for good.
 *
 * Driven by delaying `/api/workspace`, the slowest of readHome()'s three reads,
 * so the window is wide enough to press into on purpose rather than by luck.
 * The panel must end up open: either the press is held and applied when the
 * screen goes live, or the wait was never needed.
 */
test("home: an Enter on the avatar before home goes live still opens the account panel", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  /* The read is held until the test has pressed, not for a stretch of real
     time: `release` is called right after the press. The 20 s timer is only a
     safety so a test that fails before pressing cannot leave the page hanging. */
  /** @type {() => void} */
  let release = () => {};
  const pressed = new Promise((resolve) => {
    release = () => resolve(undefined);
    setTimeout(release, 20_000);
  });
  await page.route("**/api/workspace", async (route) => {
    await pressed;
    await route.continue().catch(() => {});
  });
  try {
    /* The fixture state `/home` / `rest` waits for the screen to be live, which
       is exactly what this test holds back; its address is loaded directly. */
    await page.goto(`${APP}/home`);
    /* Deliberately NOT settled(): this test exists to press while the screen is
       still the server's own render. The orb is here because the server sent
       it -- assert that, so a future markup change cannot turn this into a test
       that presses nothing. */
    await expect(page.locator("button.orb")).toBeVisible();
    await expect(page.locator("body[data-home-ready]")).toHaveCount(0);
    await tabTo(page, { selector: "button.orb" }, { screen: "home (not yet live)" });
    await page.keyboard.press("Enter");
    release();
    await expect(page.locator("#account")).toHaveClass(/open/);
    await expect(page.locator("button.orb")).toHaveAttribute("aria-expanded", "true");
  } finally {
    release();
    await page.unroute("**/api/workspace").catch(() => {});
  }
});

test("home: a dial planet link is reachable and activates by keyboard", async ({ page }) => {
  await arriveAtHome(page);
  /* The item's body on the dial is a real <a href="#<id>">; Enter follows it
     like any link, landing on (and focusing) the matching corridor row (#424:
     the row is the item, sharing that id). Attribute selectors throughout: an
     id is a perfectly legal HTML id but not always a legal bare CSS identifier,
     so it is never interpolated as `#${id}`. */
  await tabTo(page, { selector: `a.body-link[href="#${ITEM_ID}"]` }, { screen: "home dial" });
  const body = await currentFocus(page);
  expect(body?.focusVisible, "home: the dial body-link has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator(`a.item[id="${ITEM_ID}"]`)).toBeFocused();
});

/* #1319: was "item page: reached from home's manifest by keyboard, is fully
   reachable", which audited /item/<id>. The item is home's drawer now, so the
   same audit runs over home with the drawer open: every control the drawer
   shows (its documents, the foot row's pills, the pencil, the copy link) is
   reached by Tab, focus is visible on each, and Tab is not trapped. */
test("item drawer: opened from home's manifest by keyboard, is fully reachable", async ({ page }) => {
  await arriveAtHome(page);
  await openDrawerFromHome(page);
  await auditTabOrder(page, "home with the item drawer open");
});

/* #1319: was "item page: actions and the back link work by keyboard"
   (reschedule through the belt's panel, then its "← YOUR SKY" link). The
   drawer's acts are snooze (the calendar, "snooze until") and the pencil, whose
   due date is the reschedule; the way back is Escape, which puts the drawer
   away (owner-decisions "Light dismiss"). What the engine would then hold is
   what the write carried, so the saves are read back from `rememberWrites`. */
test("item drawer: rescheduling, snooze and the way back work by keyboard", async ({ page }) => {
  const writes = await rememberWrites(page);
  await arriveAtHome(page);
  await openDrawerFromHome(page);
  const drawer = page.locator(`[id="${ITEM_ID}-view"]`);
  const dueBefore = (await fixtureItem(page)).dueDate;

  /* Reschedule: the pencil puts the rows into edit, the due date opens the
     calendar, a day picked and save sends it. */
  await tabTo(page, { selector: 'button[aria-label="Edit this item"]' }, { screen: "item drawer foot row" });
  const pencil = await currentFocus(page);
  expect(pencil?.focusVisible, "item drawer: the pencil has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator(`[id="${ITEM_ID}"]`).getByRole("textbox", { name: "title" })).toBeFocused();
  await tabTo(page, { selector: '[aria-label^="due: "]' }, { screen: "item drawer, editing" });
  const due = await currentFocus(page);
  expect(due?.focusVisible, "item drawer: the due date has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await pickNextMonthByKeyboard(page, page.getByRole("dialog", { name: /due date/i }));
  /* save waits on the engine's dry run of the rows (edit-session.svelte.js
     `refused`); until then the button is aria-disabled (still in the Tab order,
     #1327) and Enter on it does nothing */
  const save = drawer.getByRole("group", { name: `Editing ${ITEM_TITLE}` }).getByRole("button", { name: "save" });
  await expect(save).toBeEnabled({ timeout: 10_000 }).catch(async () => {
    throw new Error(`item drawer: save stayed disabled; the drawer read: ${await drawer.innerText()}`);
  });
  await tabTo(page, { tag: "BUTTON", textIncludes: "save" }, { screen: "item drawer, editing" });
  await page.keyboard.press("Enter");
  await expect(drawer.getByRole("group", { name: `Actions for ${ITEM_TITLE}` })).toBeVisible();
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => writes.sent.find((one) => one.type === "item.upsert")?.item.dueDate).toBeTruthy();
  expect(writes.sent.find((one) => one.type === "item.upsert")?.item.dueDate, "the save left the due date as it was").not.toBe(dueBefore);

  /* Snooze: the pill opens the calendar beside the drawer; a day picked by
     keyboard snoozes the item. */
  await tabTo(page, { selector: `[aria-label="Snooze ${ITEM_TITLE}"]` }, { screen: "item drawer foot row" });
  const snooze = await currentFocus(page);
  expect(snooze?.focusVisible, "item drawer: the snooze pill has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await pickNextMonthByKeyboard(page, page.getByRole("dialog", { name: /snooze until/i }));
  await expect(drawer.getByText("snoozed until")).toBeVisible();
  await expect.poll(() => writes.sent.find((one) => one.type === "item.snooze")?.snoozedUntil ?? null).not.toBeNull();
  /* The pick hands focus back to the snooze pill (drawer-modes.svelte.js
     closeChooser); a keyboard reader carries on from there, so it must still
     be in the drawer once the snooze has landed. */
  await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement)),
    { message: "item drawer: focus left the drawer after the snooze" }).toBe(true);

  /* The way back: Escape puts the drawer away and leaves home as it was. */
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(`a.item[id="${ITEM_ID}"]`)).not.toHaveClass(/open/);
  await expect(page).toHaveURL(/\/home$/);
});

test("create: the whole form is reachable in order", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  await fillCreateForm(page, "Keyboard-only proving ground (audit)");
  /* #1463: the Importance tiles are a radiogroup, one Tab stop on the pressed tile */
  await auditTabOrder(page, "create form", { exclude: uncheckedRadiosOf("Importance") });
});

test("create: fillable and submittable by keyboard alone", async ({ page }) => {
  const writes = await rememberWrites(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  const name = "Keyboard-only proving ground";
  await fillCreateForm(page, name);

  await tabTo(page, { selector: ".btn-primary" }, { screen: "create form" });
  const submit = await currentFocus(page);
  expect(submit?.focusVisible, "create: the submit button has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");

  /* #1246: a save lands on home with the item it saved open. */
  await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]+$/);
  await expect(page.locator(".item", { hasText: name })).toBeVisible();
  expect(writes.sent.find((one) => one.type === "item.upsert")?.item.title).toBe(name);
  /* #1463: the first importance tile (low) was the one the keyboard pass pressed. */
  expect(writes.sent.find((one) => one.type === "item.upsert")?.item.importance).toBe("low");
});

test("household page: reached from home's sun by keyboard, and is fully reachable", async ({ page }) => {
  await arriveAtHome(page);
  await openHouseholdFromHome(page);
  /* Scoped away from `.cand`: "Add someone" lists every account the household
     does not hold yet, which is not part of what this test is proving.
     Everything else on the screen is still audited in full.
     #1002: the archive's unselected tab is out of the Tab order by design (the
     WAI-ARIA tabs pattern: the tablist is one Tab stop and ← → move between its
     tabs), so it is proved by arrow key below rather than by Tab -- the same
     split the pocket file makes (#1122). */
  /* #1466: each section's colour swatches are one Tab stop (the checked one, as Tiles); the others are proved by arrow key in v19-section-colour. */
  await auditTabOrder(page, "household page", {
    exclude: '.cand, [role="tab"][aria-selected="false"], .swatches [role="radio"][aria-checked="false"]',
  });
  const archive = page.getByRole("tablist", { name: "The archive" });
  await tabTo(page, { selector: '[role="tab"][aria-selected="true"]' }, { screen: "household page archive" });
  await page.keyboard.press("ArrowRight");
  await expect(archive.getByRole("tab", { name: "bring one in" })).toBeFocused();
  await expect(archive.getByRole("tab", { name: "bring one in" })).toHaveAttribute("aria-selected", "true");
});

test("household page: the back link works by keyboard", async ({ page }) => {
  await arriveAtHome(page);
  await openHouseholdFromHome(page);
  await tabTo(page, { selector: "a.back" }, { screen: "household page" });
  const back = await currentFocus(page);
  expect(back?.focusVisible, "household page: the back link has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/home/);
});

test("settings: reached via the account panel, and fully reachable", async ({ page }) => {
  await arriveAtHome(page);
  await openSettingsFromHome(page);
  /* #1003: the Reminders card's tabs (owner-decisions §22) are one Tab stop with
     ← → between them, so the unchosen tab is proved by arrow key below, not by
     Tab -- as the pocket file does.
     #1180: the Text size radio group is likewise one Tab stop (WAI-ARIA radio
     pattern), so its unchecked radios are proved by arrow key. */
  await auditTabOrder(page, "settings", {
    exclude: `[role="tab"][aria-selected="false"], ${uncheckedRadiosOf("Text size")}`,
  });
  const reminders = page.getByRole("tablist", { name: "Reminders" });
  await tabTo(page, { selector: "#rem-tab-reminders" }, { screen: "settings reminders" });
  await page.keyboard.press("ArrowRight");
  await expect(reminders.getByRole("tab", { name: "sent to you lately" })).toBeFocused();
  await expect(reminders.getByRole("tab", { name: "sent to you lately" })).toHaveAttribute("aria-selected", "true");
  await proveRadioGroupByArrows(page, "Text size", "settings text size");
});

test("settings: the account panel is light-dismiss by keyboard", async ({ page }) => {
  await arriveAtHome(page);
  await openSettingsFromHome(page);
  /* Chrome.svelte's account panel is shared by settings, household and inbox,
     and is the same "light dismiss" control home's own account panel is -- the
     same promise is checked here rather than assumed to carry over, since
     Chrome.svelte is a different implementation of it. */
  await auditLightDismiss(page, "settings", "button.orb", "#account");
});

test("inbox: reachable via the account panel, and keyboard-navigable", async ({ page }) => {
  await arriveAtHome(page);
  await tabTo(page, { selector: "button.orb" }, { screen: "home" });
  await page.keyboard.press("Enter");
  await tabTo(page, { tag: "A", textIncludes: "Inbox" }, { screen: "home account panel" });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/inbox$/);
  /* The inbox draws its queue or its empty-state relay bar only once the view
     has loaded; audit the loaded screen, not the shell. */
  await expect(page.locator(".inbox-page .lanes, .inbox-page .quietnote").first()).toBeVisible();

  await auditTabOrder(page, "inbox");
});

test("sign out: the one-press control ends the session by keyboard alone", async ({ page }) => {
  /* The fixture server has no session to revoke: this test answers the revoke
     and, once it has, the session read that follows, as the engine would. */
  let revoked = 0;
  await page.route("**/api/auth/logout", (route) => {
    revoked += 1;
    return route.fulfill({ json: { redirectTo: null } });
  });
  await page.route("**/api/auth/session", (route) =>
    revoked ? route.fulfill({ status: 401, json: { error: "unauthenticated" } }) : route.fallback());
  await arriveAtHome(page);
  await tabTo(page, { selector: "button.orb" }, { screen: "home" });
  await page.keyboard.press("Enter");
  await tabTo(page, { selector: ".signout" }, { screen: "home account panel" });
  const signOut = await currentFocus(page);
  expect(signOut?.focusVisible, "home: the sign-out control has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter"); // revokes the session, then plays the descent (one press: owner, 2026-10-06)

  await expect(page).toHaveURL(/\/logout$/, { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible();
  expect(revoked, "sign out: the logout request was never sent").toBe(1);
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    return /** @type {{ authenticated?: boolean }} */ (await response.json());
  });
  expect(session.authenticated, "sign out: the session is still authenticated after the sign-out control fired").toBeFalsy();
});

/* G-B2-1 (#1671): the logout answer's `redirectTo` is the provider's own sign-out address,
   and home's sign-out hands it to the descent, which goes there once the goodbye has shown.
   The tests above answer `redirectTo: null`, which proves nothing about that hand-over. */
test("sign out: home passes the provider's logout address from the answer on to the descent", async ({ page }) => {
  const PROVIDER = "https://idp.example.invalid/logout?from=orbit";
  let revoked = 0;
  await page.route("**/api/auth/logout", (route) => {
    revoked += 1;
    return route.fulfill({ json: { redirectTo: PROVIDER } });
  });
  await page.route("**/api/auth/session", (route) =>
    revoked ? route.fulfill({ status: 401, json: { error: "unauthenticated" } }) : route.fallback());
  await page.route(PROVIDER, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>provider</title><p>signed out at the provider</p>" }));
  await arriveAtHome(page);
  await tabTo(page, { selector: "button.orb" }, { screen: "home" });
  await page.keyboard.press("Enter");
  await tabTo(page, { selector: ".signout" }, { screen: "home account panel" });
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(PROVIDER, { timeout: 30_000 });
  expect(revoked, "sign out: the logout request was never sent").toBe(1);
});

/* ────────────────────────────────────────────────────────────────────────
 * SIGN-IN METHODS AND ADMIN-CREATED LOCAL USERS (#915).
 *
 * Two blocks arrived with M7, and both are worked entirely by Tab and Enter
 * here like everything above. What is new about them is that each control opens
 * ANOTHER control: the two-tap protocol arms an action and a field appears
 * under it. A field a pointer reveals and a keyboard cannot reach is exactly
 * the defect this file exists to catch, so the audit is run with the challenge
 * OPEN, not only on the resting screen.
 *
 * `aria-expanded` is the screen-reader half of the same promise: the armed
 * state is announced rather than only drawn.
 *
 * Both need a reader who HAS a password, because that is who is challenged
 * with a field; the fixture settings screen is that reader's (a password and a
 * linked provider), and its administration roster holds four other people.
 * ──────────────────────────────────────────────────────────────────────── */

test("settings: the sign-in-methods challenge arms by keyboard and is reachable", async ({ page }) => {
  await arriveAtHome(page);
  await openSettingsFromHome(page);

  const change = page.locator(".method button", { hasText: "change" }).first();
  await expect(change).toHaveAttribute("aria-expanded", "false");

  await tabTo(page, { selector: ".method button", textIncludes: "change" }, { screen: "settings" });
  const armer = await currentFocus(page);
  expect(armer?.focusVisible, "settings: the change-password action has no visible focus indicator").toBe(true);

  await page.keyboard.press("Enter");
  await expect(change).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".challenge")).toBeVisible();

  /* The whole screen again, with the challenge standing open: its two fields and
     its two buttons have to be in the tab order like anything else the screen is
     now showing. The Reminders tabs' unchosen tab is off the Tab order by
     design; the reachable-settings test above proves it by arrow key. */
  await auditTabOrder(page, "settings with the sign-in challenge open", {
    exclude: `[role="tab"][aria-selected="false"], ${uncheckedRadiosOf("Text size")}`,
  });
});

test("administration: the local-user controls are reachable and announced", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installKeyboardAudit(page);
  await signedIn("/administration", "any-dialect")(page);
  await expect(page.locator(".card").first()).toBeVisible();

  /* Every field in the row is a labelled control, which is what lets a screen
     reader say what is being asked for rather than "edit text". */
  const row = page.locator("form.localuser").first();
  await expect(row.getByLabel("email")).toBeVisible();
  await expect(row.getByLabel("display name")).toBeVisible();
  await expect(row.getByLabel("link valid for")).toBeVisible();

  /* The row is a real form: its fields are `required`, so an empty Create is
     stopped by the browser before the screen sees it. Fill it the way a keyboard
     user would, then arm. Nothing is created: the challenge opens, and the test
     never confirms it. */
  await row.getByLabel("email").fill("keyboard-newcomer@example.invalid");
  await row.getByLabel("display name").fill("Keyboard Newcomer");

  /* Arming Create by keyboard opens the challenge, and the field it opens is
     the very next thing Tab reaches. */
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
});
