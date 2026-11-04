import { expect as baseExpect, test } from "@playwright/test";

import {
  auditLightDismiss,
  auditTabOrder,
  currentFocus,
  homeIsLive,
  installKeyboardAudit,
  proveRadioGroupByArrows,
  tabTo,
  uncheckedRadiosOf,
} from "../../../tests/e2e/support/keyboard";
import { APP, onPhone, rememberWrites, RIG_EXPECT_MS, RIG_TEST_MS, settle, signedIn } from "./a11y-support.js";

/* The rig's waits (a11y-support.js RIG_EXPECT_MS, RIG_TEST_MS): the stack's explicit long waits are gone with its sign-in, but the host is shared. */
const expect = baseExpect.configure({ timeout: RIG_EXPECT_MS });
test.describe.configure({ timeout: RIG_TEST_MS });

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */

/*
 * #849, moved to the rig (ADR-0039, #1609): the pocket-dialect mirror of
 * v19-keyboard.spec.js -- a keyboard-only pass over the phone screens, driven
 * entirely by `page.keyboard`. No `.click()` anywhere in this file, same rule as
 * the desk walk.
 *
 * PHONE ONLY (`rig-phone`, `rig-webkit-phone`). The desk walk is
 * v19-keyboard.spec.js; this file is the pocket dialect's own exercise, because
 * CON-10 (#430) draws them as genuinely different screens with different
 * chrome, not one screen resized. That file's header holds the shared ground
 * rules (what "reachable" means, why light dismiss is not a modal trap, the
 * audit machinery in tests/e2e/support/keyboard.ts), restated here only where
 * the pocket dialect differs.
 *
 * Each test starts from the fixture app's Harlow Home. Nothing is seeded and
 * nothing is cleaned up; a write a test makes goes through `rememberWrites`.
 *
 * PICK OF SCREENS. web/src/routes/home/pocket.svelte (the pocket dialect),
 * pocket.css (the dialect switch and its own rules) and web/src/lib/Chrome.svelte
 * (the sub-screens' shared chrome) were read to find these:
 *
 *   - /home in its pocket form: the sky strip, the search line (`.msearch`, a
 *     button raising the search sheet), the manifest rows a dial body opens in
 *     place (264acd44, #1149), and the hatch (#1120, the kit's `.p-sheet-layer`).
 *     The account panel and the three home drawers the desk twin light-dismiss
 *     tests are `.desk`-only chrome that pocket.css hides below 901px/600px.
 *   - /inbox, /create and /household/<id> each draw their own pocket beside the
 *     desk's markup since #1120/#1122 (inbox/pocket.svelte, create/pocket.svelte,
 *     household/[id]/pocket.svelte), chosen by CSS, so the tests below walk the
 *     pocket's own controls and wait on the pocket's own loaded state.
 *     /settings draws no second dialect of its own; only its shared chrome
 *     (Chrome.svelte) turns into the kit's top chrome and hatch, so the same
 *     controls the desk file walks are walked again here, at the phone viewport.
 *   - #1319 (owner-decisions §34): an item is its manifest row's drawer on home
 *     (ItemDrawer.svelte, the foot row FootRow.svelte), so the item tests below
 *     walk that drawer.
 *
 * #852 made the avatar a real `<button>`, reached by Tab and activated by
 * Enter/Space; since #1120 it keeps its id (`#morb`) and opens the kit's hatch,
 * with keyboard access to Inbox, Settings and Administration. The sub-screen
 * tests reach their screens by direct navigation, because that is the only way
 * this file can audit a real, rendered screen on its own.
 *
 * `baseURL` is the fixture app, so the stack suite's keyboard helpers run as
 * they stand.
 */
test.use({ baseURL: APP });

test.beforeEach(({}, testInfo) => {
  test.skip(!onPhone(testInfo), "pocket screens only; the desk walk is v19-keyboard.spec.js");
});

/*
 * #1120: pocket home's overlays are the kit's sheets (web/src/lib/pocket),
 * portalled to the end of <body>, each a `.p-sheet-layer` that wears `open`
 * while it is up. The hatch is the one holding the "Go to" nav. The item sheet
 * is gone (264acd44): a planet opens its manifest row in place.
 */
const HATCH = '.p-sheet-layer:has(nav[aria-label="Go to"])';
/* The pocket top chrome's way back. Chrome.svelte also renders the desk
   `a.back`, display:none below the CON-10 switch, so a bare `a.back` matches two
   elements (one hidden) and trips strict mode. */
const TOP_BACK = "header.p-chrome a.back";
/* The dial's planets (pocket.svelte): an item body carries `data-body` alone; the
   relay's catch adds `data-body-sugg`. An open manifest row wears `data-open`
   (row.js), and the planet whose row is open wears `lit`. */
const DIAL_PLANET = ".pocket .mdial .pk-body[data-body]:not([data-body-sugg])";
const OPEN_ROW = ".pocket .pk-below [data-row][data-open]";

/**
 * The pocket dialect's own settle: `#explore` (the desk's marker) is drawn only
 * by the desk dialect. `.mtop .morb` is rendered unconditionally but stays empty
 * text until `view.user` has actually arrived -- the same "always in the DOM,
 * only meaningful once loaded" shape `#explore` gave the desk audit.
 * @param {Page} p
 */
async function settledPocket(p) {
  await p.waitForFunction(() => !document.body.classList.contains("launching"));
  await expect(p.locator("#morb")).not.toHaveText("");
  /* ...and the avatar carries its initials from the server's own render (#842),
     so that says the markup arrived, not that anything is listening to it.
     `homeIsLive` is the wait that means the sheet will open when the orb is
     pressed (#1064). */
  await homeIsLive(p);
}

/**
 * Installs the keyboard audit and lands settled on `/home` in its pocket form:
 * the fixture state `/home` / `rest`.
 * @param {Page} page
 */
async function arriveAtHomePocket(page) {
  await installKeyboardAudit(page);
  await signedIn("/home", "rest")(page);
  await settledPocket(page);
}

const POCKET_FORM = "#pocket-entry";

/**
 * #1120, proposal §2.5: on a phone /create is the pocket's own form
 * (create/pocket.svelte over EntryForm.svelte), not the desk card
 * `fillCreateForm` walks, so this is its keyboard-only fill. Its order is the
 * form's own: the type chips, then name, the section (a required choice, #1058),
 * provider, reference, the due date, how often it comes round, cost, reminders,
 * notes. Every control is reached by Tab and activated by Enter; the date goes
 * through `fill()` because a native date input reads typed digits in whatever
 * segment order the OS locale uses.
 * @param {Page} page @param {string} name
 */
async function fillPocketCreateForm(page, name) {
  const screen = "create form (pocket)";
  /* The state that keeps this browser's saves on the fixture server, so the
     save below lands on an address home can open. */
  await signedIn("/create", "saves-kept")(page);
  const form = page.getByRole("form", { name: "New entry" });
  await expect(form).toBeVisible();

  await tabTo(page, { selector: `${POCKET_FORM} .pc-kinds button`, textIncludes: "service" }, { screen });
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "service", exact: true })).toHaveAttribute("aria-pressed", "true");

  await tabTo(page, { selector: `${POCKET_FORM} input[id$="-name"]` }, { screen });
  await page.keyboard.type(name);

  await tabTo(page, { selector: `${POCKET_FORM} .pc-sec`, textIncludes: "Home" }, { screen });
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-pressed", "true");

  await tabTo(page, { selector: `${POCKET_FORM} input[type="date"]` }, { screen });
  const dueDate = "2026-09-12";
  const due = form.locator('input[type="date"]');
  await due.fill(dueDate);
  await expect(due).toHaveValue(dueDate);

  await tabTo(page, { selector: `${POCKET_FORM} textarea[id$="-notes"]` }, { screen });
  await page.keyboard.type("added by the keyboard-only pass");
  /* The engine's dry run (ADR-0034, #1325) answers ~300 ms after the last
     keystroke and the save is held until it does; wait for the filled form to be
     accepted so the screen is read settled. */
  await expect(page.locator(".pk-save")).toBeEnabled();
}

/* ────────────────────────────────────────────────────────────────────────
 * The journeys. One `test(...)` per pocket screen state.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The dial's bodies are SVG `<g role="button" tabindex="0">` (#851), and
 * pocket.svelte teaches them Enter, Space and Escape. Tab to the first planet,
 * Enter opens its manifest row in place (owner's answer 6a; the item sheet
 * retired in 264acd44) and leaves focus on the planet so a second Enter would go
 * to the item; Escape on the planet puts the row away and focus stays where it
 * was (#1149, owner-decisions §28).
 */
test("home (pocket): a planet's row opens and closes by keyboard", async ({ page }) => {
  await arriveAtHomePocket(page);
  await tabTo(page, { selector: DIAL_PLANET }, { screen: "home (pocket) dial" });
  await page.keyboard.press("Enter");
  await expect(page.locator(OPEN_ROW)).toHaveCount(1);
  await expect(page.locator(`${DIAL_PLANET}.lit`)).toHaveCount(1);
  /* Focus did not move into the row: the second Enter is the item's. */
  const onPlanet = () => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, DIAL_PLANET);
  expect(await onPlanet()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(OPEN_ROW)).toHaveCount(0);
  await expect(page.locator(`${DIAL_PLANET}.lit`)).toHaveCount(0);
  expect(await onPlanet()).toBe(true);
});

/**
 * #852: the account menu is the pocket dialect's own light-dismiss overlay, same
 * shape as the "settings (pocket): the account panel is light-dismiss by
 * keyboard" test below -- opened by Tab+Enter on the toggle, closed by Escape,
 * with focus returned to the toggle.
 */
test("home (pocket): the account menu is light-dismiss by keyboard", async ({ page }) => {
  await arriveAtHomePocket(page);
  await auditLightDismiss(page, "home (pocket)", "#morb", HATCH);
});

/**
 * #852: the real path onto /inbox from pocket home's own chrome -- Tab to the
 * avatar, Enter opens the menu, Tab reaches Inbox inside it, Enter navigates.
 */
test("home (pocket): the account menu's Inbox link is reachable by Tab and navigates on Enter", async ({ page }) => {
  await arriveAtHomePocket(page);
  await tabTo(page, { selector: "#morb" }, { screen: "home (pocket)" });
  await page.keyboard.press("Enter");
  await expect(page.locator(HATCH)).toHaveClass(/open/);
  await tabTo(page, { selector: `${HATCH} nav a`, textIncludes: "Inbox" }, { screen: "home (pocket) account menu" });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/inbox/);
});

test("create (pocket): the whole form is reachable in order", async ({ page }) => {
  await installKeyboardAudit(page);
  await fillPocketCreateForm(page, "Keyboard-only proving ground (pocket audit)");
  /* The kit's top chrome retracts once the page scrolls and comes back when it
     takes focus (TopChrome.svelte's focusin); the audit reads what is shown once,
     up front, so it starts from the top of the form, where the chrome is down, as
     a reader arriving on it finds it. */
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator(TOP_BACK)).toBeInViewport();
  await auditTabOrder(page, "create form (pocket)");
});

test("create (pocket): fillable and submittable by keyboard alone", async ({ page }) => {
  const writes = await rememberWrites(page);
  await installKeyboardAudit(page);
  const name = "Keyboard-only proving ground (pocket)";
  await fillPocketCreateForm(page, name);

  /* The save sits in the pocket's bar at the foot, after the form. */
  await tabTo(page, { selector: ".pk-save" }, { screen: "create form (pocket)" });
  const submit = await currentFocus(page);
  expect(submit?.focusVisible, "create (pocket): the submit button has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");

  /* Saved (#1319, §34): home, with the new item's drawer open, as the desk's
     create lands; the belt it used to approach is gone. */
  await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/);
  const id = new URL(page.url()).searchParams.get("item");
  const row = page.locator(`.pocket .pk-below [data-row-key="${id}"]`);
  /* Home's load runs on the server, which holds the item only because the
     `/create` / `saves-kept` state asked the fixture server to keep this
     browser's saves; without that the address arrives at a workspace that
     lacks it and pocket.svelte gives up opening the row. */
  await expect(row).toHaveAttribute("data-open", "");
  await expect(row).toContainText(name);
  expect(writes.sent.find((one) => one.type === "item.upsert")?.item.title).toBe(name);
  /* And home's pocket lists it as a kit row (#1120), not the desk's `.item`,
     which pocket.svelte never renders. */
  await page.goto(`${APP}/home`);
  await expect(page.locator(".pocket .pk-list .p-row", { hasText: name })).toBeVisible();
});

/**
 * #1319: opens the first planet's manifest row the keyboard's way (Tab to its
 * planet, Enter: owner's answer 6a), then waits for its drawer's foot row. Focus
 * stays on the planet, so the drawer's controls are the Tabs after it. Answers
 * the row, and the item's id and title as the row names them.
 * @param {Page} page
 */
async function openRowFromDial(page) {
  await tabTo(page, { selector: DIAL_PLANET }, { screen: "home (pocket) dial" });
  await page.keyboard.press("Enter");
  const row = page.locator(OPEN_ROW);
  await expect(row).toHaveCount(1);
  const acts = row.getByRole("group", { name: /^Actions for / });
  await expect(acts).toBeVisible();
  const id = /** @type {string} */ (await row.getAttribute("data-row-key"));
  const title = /** @type {string} */ ((await acts.getAttribute("aria-label")) ?? "").replace(/^Actions for /, "");
  return { row, id, title };
}

/** Waits for the chooser sheet's calendar to take focus, then steps (a day with
 *  ArrowRight, a month with PageDown: calendar.js stepDay) and picks that day
 *  with Enter.
 * @param {Page} page @param {Locator} chooser @param {"ArrowRight" | "PageDown"} step */
async function pickByKeyboard(page, chooser, step) {
  await expect(chooser).toBeVisible();
  await expect.poll(() => chooser.evaluate((el) => el.contains(document.activeElement) && document.activeElement?.matches("button.day"))).toBe(true);
  await page.keyboard.press(step);
  await page.keyboard.press("Enter");
  await expect(chooser).toHaveCount(0);
}

/* #1319: was "item page (pocket): fully reachable by keyboard", which audited
   /item/<id> on a phone. The item is its row's drawer on pocket home now, so the
   same audit runs over home with that drawer open.
   #1381: quarantined 2026-10-16 (agent-infra#30) on the stack, and carried over
   as it was (tests/quarantine.txt): a move does not lift a quarantine. */
test("item drawer (pocket): opened from the dial by keyboard, is fully reachable", { tag: ["@quarantine"] }, async ({ page }) => {
  await arriveAtHomePocket(page);
  await openRowFromDial(page);
  await auditTabOrder(page, "home (pocket) with the item drawer open");
});

/* #1319: was "item page (pocket): actions and the back link work by keyboard"
   (reschedule through the belt's Reschedule sheet, then the top chrome's back
   link). The drawer's acts are snooze (the calendar sheet, "snooze until") and
   the pencil, whose due date is the reschedule; the way back is Escape on the
   row, which puts it away (row.js). What the engine would then hold is what the
   write carried, so the saves are read back from `rememberWrites`. */
test("item drawer (pocket): rescheduling, snooze and the way back work by keyboard", async ({ page }) => {
  const writes = await rememberWrites(page);
  await arriveAtHomePocket(page);
  const { row, id, title } = await openRowFromDial(page);
  const workspace = await (await page.request.get(`${APP}/api/workspace`)).json();
  const dueBefore = workspace.workspace.households.flatMap((/** @type {any} */ one) => one.items ?? [])
    .find((/** @type {any} */ item) => item.id === id).dueDate;

  /* Reschedule: the pencil puts the rows into edit, the due date opens the
     calendar sheet, a day picked and save sends it. */
  await tabTo(page, { selector: 'button[aria-label="Edit this item"]' }, { screen: "item drawer (pocket) foot row" });
  const pencil = await currentFocus(page);
  expect(pencil?.focusVisible, "item drawer (pocket): the pencil has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await expect(row.getByRole("textbox", { name: "title" })).toBeFocused();
  await tabTo(page, { selector: '[aria-label^="due: "]' }, { screen: "item drawer (pocket), editing" });
  const due = await currentFocus(page);
  expect(due?.focusVisible, "item drawer (pocket): the due date has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  /* A day on, not a month: a month on carries the item out of "Needs attention",
     and its row is then redrawn as "nothing needs you" and shut (pocket.svelte's
     two manifest branches), which is not what this test is about. */
  await pickByKeyboard(page, page.getByRole("dialog", { name: /due date/i }), "ArrowRight");
  /* save waits on the engine's dry run of the rows (edit-session.svelte.js
     `refused`); until then the button is aria-disabled (still in the Tab order,
     #1327) and Enter on it does nothing */
  const save = row.getByRole("group", { name: `Editing ${title}` }).getByRole("button", { name: "save" });
  await expect(save).toBeEnabled({ timeout: 10_000 }).catch(async () => {
    throw new Error(`item drawer (pocket): save stayed disabled; the row read: ${await row.innerText()}`);
  });
  await tabTo(page, { tag: "BUTTON", textIncludes: "save" }, { screen: "item drawer (pocket), editing" });
  await page.keyboard.press("Enter");
  await expect(row.getByRole("group", { name: `Actions for ${title}` })).toBeVisible();
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => writes.sent.find((one) => one.type === "item.upsert")?.item.dueDate).toBeTruthy();
  expect(writes.sent.find((one) => one.type === "item.upsert")?.item.dueDate, "the save left the due date as it was").not.toBe(dueBefore);

  /* Snooze: the pill opens the calendar sheet; a day picked snoozes. */
  await tabTo(page, { selector: `[aria-label="Snooze ${title}"]` }, { screen: "item drawer (pocket) foot row" });
  const snooze = await currentFocus(page);
  expect(snooze?.focusVisible, "item drawer (pocket): the snooze pill has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  await pickByKeyboard(page, page.getByRole("dialog", { name: /snooze until/i }), "ArrowRight");
  await expect(row.getByText("snoozed until")).toBeVisible();
  await expect.poll(() => writes.sent.find((one) => one.type === "item.snooze")?.snoozedUntil ?? null).not.toBeNull();
  /* The pick hands focus back to the snooze pill (drawer-modes.svelte.js
     closeChooser); a keyboard reader carries on from there, so it must still be
     in the row once the snooze has landed. */
  await expect.poll(() => row.evaluate((el) => el.contains(document.activeElement)),
    { message: "item drawer (pocket): focus left the row after the snooze" }).toBe(true);

  /* The way back: Escape puts the row away. */
  await page.keyboard.press("Escape");
  await expect(page.locator(OPEN_ROW)).toHaveCount(0);
});

/**
 * #1122: the household draws its own pocket (household/[id]/pocket.svelte,
 * proposal §2.10) beside the desk's cards, which are display:none on a phone, so
 * these wait for the pocket's own heading, not the desk's `.cards`. Pocket home
 * has no sun/dial door onto it (that is desk-only chrome) -- direct navigation.
 */
test("household page (pocket): fully reachable by keyboard", async ({ page }) => {
  await installKeyboardAudit(page);
  /* sectionActs (household/[id]/pocket.svelte) omits "move down" for a section
     with nothing after it, so a second section is needed for the first row's move
     act to exist at all (#1122 follow-up); Harlow Home has five. */
  await signedIn("/household/hh-harlow-1", "any-dialect")(page);
  await expect(page.getByRole("heading", { level: 1, name: "Harlow Home" })).toBeVisible();
  /* The pocket's cards rise in over their first ~800ms; audit them drawn. */
  await settle(page);
  /* Scoped away from `.cand`: "Add someone" lists every account the household
     does not hold yet, which is not part of what this test proves.
     #1122: the archive's unselected tab is out of the Tab order by design and
     reached another way, proved below rather than by Tab (§22's tabs, the
     WAI-ARIA tabs pattern: the tablist is one Tab stop and ← → move between its
     tabs). A row's acts are in its panel, which is `hidden` until the row is
     opened (review round §1.1), so a shut row offers only its face to Tab. */
  await auditTabOrder(page, "household page (pocket)", {
    exclude: '.cand, [role="tab"][aria-selected="false"]',
  });
  const archive = page.getByRole("tablist", { name: "The archive" });
  await tabTo(page, { selector: '[role="tab"][aria-selected="true"]' }, { screen: "household page (pocket) archive" });
  await page.keyboard.press("ArrowRight");
  await expect(archive.getByRole("tab", { name: "bring one in" })).toBeFocused();
  await expect(archive.getByRole("tab", { name: "bring one in" })).toHaveAttribute("aria-selected", "true");
  /* A section row's face is the button that opens it; Alt-↑/↓ on it moves the
     section, and its opened panel holds `move up` / `move down` (review round
     §1.1). */
  const section = page.locator(".hh-sections .p-row [data-row-face]").first();
  await expect(section).toHaveJSProperty("tagName", "BUTTON");
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await expect(section).toHaveAttribute("aria-keyshortcuts", /Alt\+ArrowUp Alt\+ArrowDown/);
  await section.focus();
  await page.keyboard.press("Enter");
  await expect(section).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".hh-sections [data-row-panel]:not([hidden])").getByRole("button", { name: /^Move .* down$/ }))
    .toBeVisible();
  await page.keyboard.press("Escape");
  await expect(section).toHaveAttribute("aria-expanded", "false");
});

test("household page (pocket): the back link works by keyboard", async ({ page }) => {
  await installKeyboardAudit(page);
  await signedIn("/household/hh-harlow-1", "any-dialect")(page);
  await expect(page.getByRole("heading", { level: 1, name: "Harlow Home" })).toBeVisible();
  /* On a phone Chrome.svelte's way back is the kit's top chrome. */
  await tabTo(page, { selector: TOP_BACK }, { screen: "household page (pocket)" });
  const back = await currentFocus(page);
  expect(back?.focusVisible, "household page (pocket): the back link has no visible focus indicator").toBe(true);
  await page.keyboard.press("Enter");
  /* door.js's own rule: absent a door marker (the sun link on desk home, which
     the pocket dialect has no equivalent of yet), a direct arrival at this screen
     is "a deep link" and the way back is DEFAULT_DOOR, the helm -- "← SETTINGS",
     /settings -- not /home. */
  await expect(page).toHaveURL(/\/settings/);
});

/**
 * settings/pocket.svelte draws unlit rows until the screen has loaded
 * (v19-keyboard.spec.js's `openSettingsFromHome` documents the desk's race);
 * waiting for the methods' rows here closes the same race on a phone.
 */
test("settings (pocket): fully reachable by keyboard", async ({ page }) => {
  await installKeyboardAudit(page);
  await page.goto(`${APP}/settings`);
  /* #1125: on a phone settings is its own layout (settings/pocket.svelte); the
     desk's `.cards` and `.method` are display:none here. The sign-in methods
     (#915) are read after the screen itself, so an audit that starts before their
     rows exist would meet them by Tab: wait for the email approval row, which is
     drawn once the methods have answered. */
  await expect(page.locator(".st-pocket .p-card").first()).toBeVisible();
  await expect(page.locator(".st-pocket .p-row", { hasText: "email approval" })).toBeVisible();
  /* The cards arrive in turn (a rise of under a second); the audit's snapshot of
     what is visible must wait for the last one to land. */
  await expect(page.locator(".st-pocket .st-sessions")).toHaveCSS("opacity", "1");
  /* The Reminders card's tabs (owner-decisions §22): one tab in the Tab order, ←
     → between them, so the unchosen tab is never met by Tab.
     #1180: the Text size radio group is one Tab stop too (WAI-ARIA radio
     pattern); its unchecked radios are proved by arrow key instead. */
  await auditTabOrder(page, "settings (pocket)", {
    exclude: `[role=tab][aria-selected=false], ${uncheckedRadiosOf("Text size")}`,
  });
  await proveRadioGroupByArrows(page, "Text size", "settings (pocket) text size");
});

test("settings (pocket): the account panel is light-dismiss by keyboard", async ({ page }) => {
  await installKeyboardAudit(page);
  await page.goto(`${APP}/settings`);
  await expect(page.locator(".st-pocket .p-card").first()).toBeVisible();
  /* Below the CON-10 switch Chrome.svelte's account menu is the hatch sheet
     (#1120), opened from the top chrome's orb; the desk dropdown (`button.orb`,
     `#account`) is display:none here. Keyboard-openable, Escape closes it, focus
     returns to the orb. */
  await auditLightDismiss(page, "settings (pocket)", "button.porb", HATCH);
});

test("inbox (pocket): fully reachable by keyboard", async ({ page }) => {
  await installKeyboardAudit(page);
  await page.goto(`${APP}/inbox`);
  /* The inbox draws its queue or its empty-state relay card only once the view
     has loaded -- audit the loaded screen, not the shell. On a phone that is the
     pocket's own inbox (inbox/pocket.svelte, proposal §2.6): its lanes or its
     quiet card, where the desk's `.lanes`/`.quietnote` are display:none. */
  await expect(page.locator(".pk-inbox :is(.pki-lane, .pki-quiet)").first()).toBeVisible();
  /* The pocket's cards rise in; audit them drawn, or a pill still at opacity 0 is
     left out of the visible snapshot and then met by Tab (docs/flakes.md, "inbox
     (pocket)"). */
  await settle(page);
  await auditTabOrder(page, "inbox (pocket)");
});
