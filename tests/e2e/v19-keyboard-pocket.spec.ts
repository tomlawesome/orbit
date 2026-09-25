import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import {
  auditLightDismiss,
  auditTabOrder,
  currentFocus,
  dismissTourIfShown,
  gotoCreate,
  homeIsLive,
  installKeyboardAudit,
  tabTo,
} from "./support/keyboard";
import { entrancesSettled } from "./support/motion";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #849: the pocket-dialect mirror of v19-keyboard.spec.ts — a keyboard-only
 * pass over the mobile screens, driven entirely by `page.keyboard`. No
 * `.click()` anywhere in this file, same rule as the desktop walk.
 *
 * MOBILE ONLY. `--project=mobile-chromium`. v19-keyboard.spec.ts walks the
 * desk dialect; this file is the pocket dialect's own exercise, because
 * CON-10 (#430) draws them as genuinely different screens with different
 * chrome, not one screen resized. See that file's header for the shared
 * ground rules (what "reachable" means, why light dismiss is not a modal
 * trap, the audit machinery) — restated here only where the pocket dialect
 * actually differs.
 *
 * Every helper this file shares byte-for-byte with the desktop walk
 * (installKeyboardAudit, collectVisible, currentFocus, tabTo, auditTabOrder,
 * auditLightDismiss, dismissTourIfShown, settled, fillCreateForm) lives in
 * ./support/keyboard.ts and is imported by both files rather than kept as two
 * copies. `settled` is desktop-only under the hood (it waits for `#explore`,
 * which only the desk dialect renders) and is not used here; this file waits
 * on the pocket dialect's own always-rendered, data-gated element instead —
 * see `settledPocket` below.
 *
 * PICK OF SCREENS. web/src/routes/home/pocket.svelte (the pocket dialect),
 * pocket.css (the dialect switch and its own rules) and
 * web/src/lib/Chrome.svelte (the sub-screens' shared chrome) were read to
 * find these, rather than guessed:
 *
 *   - /home in its pocket form: the sky strip (`.skies`, #845's own
 *     `tabindex="0"` scrollable region, whose chips link to each household
 *     since #1118), the search line (`.msearch`, a button raising the search
 *     sheet), and the pocket's sheets (#1120, the kit's `.p-sheet-layer`) —
 *     the item sheet a dial body or a row raises, and the hatch. v19-axe-sweep.spec.ts's
 *     own comment on this route confirms the pocket dialect "has no drawers
 *     of its own at all" beyond that: the account panel and the three home
 *     drawers this file's desktop twin light-dismiss-tests are `.desk`-only
 *     chrome (home.css) that pocket.css hides outright below 901px/600px.
 *   - /inbox, /create, /item/<id> and /household/<id> each draw their own
 *     pocket beside the desk's markup since #1120/#1122 (inbox/pocket.svelte,
 *     create/pocket.svelte, the item page's pocket card and sheets,
 *     household/[id]/pocket.svelte), chosen by CSS, so the tests below walk
 *     the pocket's own controls and wait on the pocket's own loaded state.
 *     /settings draws no second dialect of its own; only its shared chrome
 *     (Chrome.svelte) turns into the kit's top chrome and hatch, so the same
 *     controls the desktop file walks are walked again here, at the phone
 *     viewport, to prove they are still fully keyboard-reachable.
 *
 * #852 made the avatar a real `<button>`, reached by Tab and activated by
 * Enter/Space; since #1120 it keeps its id (`#morb`) and opens the kit's
 * hatch, with keyboard access to Inbox, Settings and Administration — see the
 * two tests below. The sub-screen tests still reach their screens by direct
 * navigation, because that is the only way this file can audit a real,
 * rendered screen on its own.
 */

/* #1080: this worker's own administrator, resolved lazily (worker env only). */
const READER = () => workerAccount("administrator");

test.beforeEach(({ isMobile }) => {
  test.skip(!isMobile, "pocket screens only; the desktop walk is v19-keyboard.spec.ts");
});

async function signIn(page: Page, returnTo: string) {
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
     made for #840 everywhere else and missed here and in the desktop twin. */
  await settleArrival(page);
}

/**
 * A household of the signed-in reader's own — same shape and same commands
 * as v19-keyboard.spec.ts's `seedHousehold`, kept as its own copy (not
 * shared) because it is a fixture builder, not audit machinery, and the two
 * files' own name prefixes must stay distinct on the shared acceptance
 * instance (#730).
 */
async function seedHousehold(page: Page, options: { withItem?: boolean } = {}) {
  const name = `keyboard-pocket-${randomUUID()}`;
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
  if (!created.ok()) throw new Error(`#849: could not seed household "${name}" (${created.status()})`);

  let itemId: string | undefined;
  if (options.withItem) {
    itemId = randomUUID();
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const itemCreated = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId,
        item: {
          id: itemId,
          sectionId,
          title: "Keyboard-reached boiler service",
          currency: "GBP",
          scheduleKind: "service",
          dueDate,
          recurrenceMonths: 12,
          status: "active",
        },
        activity: { id: randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
      },
    });
    if (!itemCreated.ok()) {
      throw new Error(`#849: could not seed item for "${name}" (${itemCreated.status()})`);
    }
  }

  return { id: householdId, name, itemId };
}

/*
 * #1120: pocket home's overlays are the kit's sheets (web/src/lib/pocket),
 * portalled to the end of <body>, each a `.p-sheet-layer` that wears `open`
 * while it is up. The hatch is the one holding the "Go to" nav; the item
 * sheet is the one holding the item's card.
 */
const HATCH = '.p-sheet-layer:has(nav[aria-label="Go to"])';
/* The pocket top chrome's way back. Chrome.svelte also renders the desk
   `a.back`, display:none below the CON-10 switch, so a bare `a.back` matches
   two elements (one hidden) and trips strict mode. */
const TOP_BACK = "header.p-chrome a.back";
const ITEM_SHEET = ".p-sheet-layer:has(.pk-item)";

/** #730: every household this file makes is removed, even when the test fails. */
async function cleanup(page: Page, household: { id: string; name: string }) {
  await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
}

/**
 * The pocket dialect's own settle: `#explore` (v19-keyboard.spec.ts's
 * `settled`) is drawn only by the desk dialect, so pocket.svelte's markup has
 * no equivalent to wait on directly. `.mtop .morb` is rendered unconditionally
 * (outside the `{#if view?.emptySky}` branch) but stays empty text until
 * `view.user` has actually arrived (pocket.svelte: `initials` derives from
 * `view?.user?.displayName ?? ""`, which is "" before the read resolves) —
 * the same "always in the DOM, only meaningful once loaded" shape `#explore`
 * gave the desk audit, confirmed by reading pocket.svelte rather than
 * guessed.
 */
async function settledPocket(p: Page) {
  await dismissTourIfShown(p);
  await p.waitForFunction(() => !document.body.classList.contains("launching"), null, { timeout: 60_000 });
  await expect(p.locator("#morb")).not.toHaveText("", { timeout: 60_000 });
  /* ...and the avatar carries its initials from the server's own render
     (#842), so that says the markup arrived, not that anything is listening
     to it. `homeIsLive` is the wait that means the sheet will open when the
     orb is pressed (#1064). */
  await homeIsLive(p);
}

/**
 * Signs in, seeds a household of the reader's own, installs the keyboard
 * audit and lands settled on `/home` in its pocket form. Same shape as
 * v19-keyboard.spec.ts's `arriveAtHome`, using the pocket settle above.
 */
async function arriveAtHomePocket(page: Page, options: { withItem?: boolean } = {}) {
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page, options);
  await page.goto("/home");
  await settledPocket(page);
  return household;
}

/**
 * #1120, proposal §2.5: on a phone /create is the pocket's own form
 * (create/pocket.svelte over EntryForm.svelte), not the desk card
 * `fillCreateForm` walks, so this is its keyboard-only fill. Its order is
 * the form's own: the type chips, then name, the section (a required
 * choice, #1058), provider, reference, the due date, how often it comes
 * round, cost, reminders, notes. Every control is reached by Tab and
 * activated by Enter; the date goes through `fill()` for the locale reason
 * `fillCreateForm` gives.
 */
const POCKET_FORM = "#pocket-entry";
async function fillPocketCreateForm(page: Page, name: string) {
  const screen = "create form (pocket)";
  await gotoCreate(page);
  const form = page.getByRole("form", { name: "New entry" });
  await expect(form).toBeVisible({ timeout: 30_000 });

  await tabTo(page, { selector: `${POCKET_FORM} .pc-kinds button`, textIncludes: "service" }, { screen });
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "service" })).toHaveAttribute("aria-pressed", "true");

  await tabTo(page, { selector: `${POCKET_FORM} input[id$="-name"]` }, { screen });
  await page.keyboard.type(name);

  await tabTo(page, { selector: `${POCKET_FORM} .pc-sec`, textIncludes: "Home" }, { screen });
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");

  await tabTo(page, { selector: `${POCKET_FORM} input[type="date"]` }, { screen });
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const due = form.locator('input[type="date"]');
  await due.fill(dueDate);
  await expect(due).toHaveValue(dueDate);

  await tabTo(page, { selector: `${POCKET_FORM} textarea[id$="-notes"]` }, { screen });
  await page.keyboard.type("added by the keyboard-only pass");
}

/* ────────────────────────────────────────────────────────────────────────
 * The journeys. One `test(...)` per pocket screen state; each signs in and
 * seeds its own household (where one is needed), and cleans it up in
 * `finally`.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The dial's bodies are SVG `<g role="button" tabindex="0">` (#851), and
 * pocket.svelte teaches them Enter and Space. Tab to the first, Enter raises
 * the item sheet (#1119, the kit's Sheet), Escape puts it away (#1120).
 */
test("home (pocket): the item sheet opens and light-dismisses by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page, { withItem: true });
  try {
    await tabTo(page, { selector: "[data-sheet-title]" }, { screen: "home (pocket) dial" });
    await page.keyboard.press("Enter");
    await expect(page.locator(ITEM_SHEET)).toHaveClass(/open/);
    await page.keyboard.press("Escape");
    await expect(page.locator(ITEM_SHEET)).not.toHaveClass(/open/);
  } finally {
    await cleanup(page, household);
  }
});

/**
 * #852: the account menu is the pocket dialect's own light-dismiss overlay,
 * same shape as the "settings (pocket): the account panel is light-dismiss
 * by keyboard" test below — opened by Tab+Enter on the toggle, closed by
 * Escape, with focus returned to the toggle.
 */
test("home (pocket): the account menu is light-dismiss by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page);
  try {
    await auditLightDismiss(page, "home (pocket)", "#morb", HATCH);
  } finally {
    await cleanup(page, household);
  }
});

/**
 * #852: the real path onto /inbox from pocket home's own chrome — Tab to the
 * avatar, Enter opens the menu, Tab reaches Inbox inside it, Enter navigates.
 */
test("home (pocket): the account menu's Inbox link is reachable by Tab and navigates on Enter", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page);
  try {
    await tabTo(page, { selector: "#morb" }, { screen: "home (pocket)" });
    await page.keyboard.press("Enter");
    await expect(page.locator(HATCH)).toHaveClass(/open/);
    await tabTo(page, { selector: `${HATCH} nav a`, textIncludes: "Inbox" }, { screen: "home (pocket) account menu" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/inbox/);
  } finally {
    await cleanup(page, household);
  }
});

test("create (pocket): the whole form is reachable in order", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page);
  try {
    await fillPocketCreateForm(page, "Keyboard-only proving ground (pocket audit)");
    /* The kit's top chrome retracts once the page scrolls and comes back
       when it takes focus (TopChrome.svelte's focusin); the audit reads what
       is shown once, up front, so it starts from the top of the form, where
       the chrome is down, as a reader arriving on it finds it. */
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.locator(TOP_BACK)).toBeInViewport();
    await auditTabOrder(page, "create form (pocket)");
  } finally {
    await cleanup(page, household);
  }
});

test("create (pocket): fillable and submittable by keyboard alone", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page);
  try {
    const name = "Keyboard-only proving ground (pocket)";
    await fillPocketCreateForm(page, name);

    /* The save sits in the pocket's bar at the foot, after the form. */
    await tabTo(page, { selector: ".pk-save" }, { screen: "create form (pocket)" });
    const submit = await currentFocus(page);
    expect(submit?.focusVisible, "create (pocket): the submit button has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");

    /* Saved (§2.5): the new item is approached on its belt. */
    await expect(page).toHaveURL(/\/item\/[0-9a-f-]{36}$/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name })).toBeVisible();
    /* And home's pocket lists it as a kit row (#1120), not the desk's
       `.item`, which pocket.svelte never renders. */
    await page.goto("/home");
    await expect(page.locator(".pocket .pk-list .p-row", { hasText: name })).toBeVisible({ timeout: 30_000 });
  } finally {
    await cleanup(page, household);
  }
});

/**
 * item/[id]/+page.svelte draws no second dialect (only column-reflow media
 * queries) and is reached from pocket home only through the bottom sheet's
 * dead "open" button (see the file header) — direct navigation is the real
 * way onto this screen in the pocket build today.
 */
test("item page (pocket): fully reachable by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page, { withItem: true });
  try {
    await page.goto(`/item/${household.itemId}`);
    await expect(page.locator(TOP_BACK)).toBeVisible({ timeout: 30_000 });
    await auditTabOrder(page, "item page (pocket)");
  } finally {
    await cleanup(page, household);
  }
});

test("item page (pocket): actions and the back link work by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page, { withItem: true });
  try {
    await page.goto(`/item/${household.itemId}`);
    await expect(page.locator(TOP_BACK)).toBeVisible({ timeout: 30_000 });

    await tabTo(page, { tag: "BUTTON", textIncludes: "reschedule" }, { screen: "item page (pocket) actions" });
    await page.keyboard.press("Enter");
    /* On a phone reschedule is the kit Sheet's "Reschedule" face (#1072),
       not the desk inline `.panel`; by role and name, since the closed hatch
       is a `.panel` too. */
    const reschedule = page.getByRole("dialog", { name: "Reschedule" });
    await expect(reschedule).toBeVisible();
    await tabTo(page, { selector: "#p-due" }, { screen: "item page (pocket) reschedule sheet" });
    const dueField = await currentFocus(page);
    expect(dueField?.focusVisible, "item page (pocket): the reschedule date field has no visible focus indicator").toBe(true);
    const newDue = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await page.locator("#p-due").fill(newDue);
    await tabTo(page, { selector: ".bp-go" }, { screen: "item page (pocket) reschedule sheet" });
    await page.keyboard.press("Enter");
    await expect(reschedule).toBeHidden();
    await expect(page.locator(".problem")).toBeHidden();

    await tabTo(page, { selector: TOP_BACK }, { screen: "item page (pocket)" });
    const back = await currentFocus(page);
    expect(back?.focusVisible, "item page (pocket): the back link has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/home/);
  } finally {
    await cleanup(page, household);
  }
});

/**
 * #1122: the household draws its own pocket (household/[id]/pocket.svelte,
 * proposal §2.10) beside the desk's cards, which are display:none on a
 * phone, so these wait for the pocket's own heading, not the desk's
 * `.cards`. Pocket home has no sun/dial door onto it (that is desk-only
 * chrome) — direct navigation.
 */
test("household page (pocket): fully reachable by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.goto(`/household/${household.id}`);
    await expect(page.getByRole("heading", { level: 1, name: household.name })).toBeVisible({ timeout: 30_000 });
    /* The pocket's cards rise in over their first ~800ms; audit them drawn. */
    await entrancesSettled(page.locator(".hh-pocket"));
    /* Scoped away from `.cand`, same reason as the desktop file: "Add
       someone" lists every account on this shared acceptance instance not
       yet in the household, genuinely unbounded and not part of what this
       test proves. */
    /* #1122: two kinds of control on the pocket household are out of the
       Tab order by design and reached another way, proved below rather
       than by Tab: the archive's unselected tab (§22's tabs, the WAI-ARIA
       tabs pattern: the tablist is one Tab stop and ← → move between its
       tabs), and a section row's "Move … up/down" buttons, visually hidden
       for a screen reader, whose keyboard way is Alt-↑/↓ on the row itself
       (Row.svelte). */
    await auditTabOrder(page, "household page (pocket)", {
      exclude: '.cand, [role="tab"][aria-selected="false"], .p-row .move',
    });
    const archive = page.getByRole("tablist", { name: "The archive" });
    await tabTo(page, { selector: '[role="tab"][aria-selected="true"]' }, { screen: "household page (pocket) archive" });
    await page.keyboard.press("ArrowRight");
    await expect(archive.getByRole("tab", { name: "bring one in" })).toBeFocused();
    await expect(archive.getByRole("tab", { name: "bring one in" })).toHaveAttribute("aria-selected", "true");
    const section = page.locator(".hh-sections .p-row [data-row-face]").first();
    await expect(section).toHaveAttribute("tabindex", "0");
    await expect(section).toHaveAttribute("aria-keyshortcuts", /Alt\+ArrowUp Alt\+ArrowDown/);
  } finally {
    await cleanup(page, household);
  }
});

test("household page (pocket): the back link works by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.goto(`/household/${household.id}`);
    await expect(page.getByRole("heading", { level: 1, name: household.name })).toBeVisible({ timeout: 30_000 });
    /* On a phone Chrome.svelte's way back is the kit's top chrome. */
    await tabTo(page, { selector: TOP_BACK }, { screen: "household page (pocket)" });
    const back = await currentFocus(page);
    expect(back?.focusVisible, "household page (pocket): the back link has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    /* door.js's own rule: absent a door marker (the sun link on desk home,
       which the pocket dialect has no equivalent of yet — see the file
       header), a direct arrival at this screen is "a deep link" and the way
       back is DEFAULT_DOOR, the helm — "← SETTINGS", /settings — not /home.
       Confirmed by reading door.js rather than assumed. */
    await expect(page).toHaveURL(/\/settings/);
  } finally {
    await cleanup(page, household);
  }
});

/**
 * settings/+page.svelte gates its cards behind `{#if view}`
 * (v19-keyboard.spec.ts's `openSettingsFromHome` documents the exact race);
 * waiting for `.cards` here closes the same race on a direct navigation.
 */
test("settings (pocket): fully reachable by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.goto("/settings");
    await expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 });
    /* The sign-in methods block (#915) is read after the helm itself, so an
       audit that starts on `.cards` alone collects its expected set before the
       block's buttons exist and then meets them by Tab. Wait for the rows. */
    await expect(page.locator(".method").first()).toBeVisible({ timeout: 30_000 });
    await auditTabOrder(page, "settings (pocket)");
  } finally {
    await cleanup(page, household);
  }
});

test("settings (pocket): the account panel is light-dismiss by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.goto("/settings");
    await expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 });
    /* Below the CON-10 switch Chrome.svelte's account menu is the hatch
       sheet (#1120), opened from the top chrome's orb; the desk dropdown
       (`button.orb`, `#account`) is display:none here. Keyboard-openable,
       Escape closes it, focus returns to the orb. */
    await auditLightDismiss(page, "settings (pocket)", "button.porb", HATCH);
  } finally {
    await cleanup(page, household);
  }
});

test("inbox (pocket): fully reachable by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.goto("/inbox");
    /* The inbox draws its queue or its empty-state relay card only once the
       view has loaded — audit the loaded screen, not the shell, same as the
       desktop file. On a phone that is the pocket's own inbox
       (inbox/pocket.svelte, proposal §2.6): its lanes or its quiet card,
       where the desk's `.lanes`/`.quietnote` are display:none. */
    await expect(page.locator(".pk-inbox :is(.pki-lane, .pki-quiet)").first()).toBeVisible({ timeout: 30_000 });
    await auditTabOrder(page, "inbox (pocket)");
  } finally {
    await cleanup(page, household);
  }
});
