import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import {
  auditLightDismiss,
  auditTabOrder,
  currentFocus,
  dismissTourIfShown,
  fillCreateForm,
  installKeyboardAudit,
  tabTo,
} from "./support/keyboard";

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
 *     `tabindex="0"` scrollable region), the pocket search (`.msearch
 *     input`), and the one overlay the pocket dialect has — the bottom sheet
 *     (`#sheet`) a dial body or a signal row raises. v19-axe-sweep.spec.ts's
 *     own comment on this route confirms the pocket dialect "has no drawers
 *     of its own at all" beyond that: the account panel and the three home
 *     drawers this file's desktop twin light-dismiss-tests are `.desk`-only
 *     chrome (home.css) that pocket.css hides outright below 901px/600px.
 *   - /inbox, /create, /item/<id>, /household/<id>, /settings and /admin:
 *     none of these routes draw a second dialect (no `.pocket`/`.desk` switch
 *     in their own CSS — checked each file; every @media rule found only
 *     reflows columns) so the same controls the desktop file walks are
 *     walked again here, at the phone viewport, to prove the phone's own
 *     rendering of them is still fully keyboard-reachable.
 *
 * A KNOWN GAP, NOW PARTLY CLOSED (#852): mtop's avatar (`.morb`) used to bind
 * no keyboard handler of any kind — it is a real `<button>` now
 * (pocket.svelte), reached by Tab and activated natively by Enter/Space, and
 * it opens the account menu (`#maccount`) with keyboard access to Inbox,
 * Settings and Administration — see the two tests below. `/household` still
 * has no route from pocket home's own chrome (the desk account panel #852
 * mirrors has none either), and the dial's own item/suggestion bodies are
 * unchanged by this issue. The sub-screen tests below still reach their
 * screens by direct navigation as well, because that is the only way this
 * file can audit a real, rendered screen on its own. The bottom-sheet test
 * below (raising `#sheet` from a dial body) is unrelated to #852 and
 * unchanged — see its own comment.
 */

const READER = "Orbit Administrator";

test.beforeEach(({ isMobile }) => {
  test.skip(!isMobile, "pocket screens only; the desktop walk is v19-keyboard.spec.ts");
});

async function signIn(page: Page, returnTo: string) {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER }).click();
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
  await expect(p.locator(".morb")).not.toHaveText("", { timeout: 60_000 });
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

/* ────────────────────────────────────────────────────────────────────────
 * The journeys. One `test(...)` per pocket screen state; each signs in and
 * seeds its own household (where one is needed), and cleans it up in
 * `finally`.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * KNOWN PRODUCT BUG, kept failing on purpose: the closed `#sheet`'s seven
 * controls (`#sh-acts-item`'s "open"/"documents"/"close", `#sh-acts-sugg`'s
 * "Add to orbit"/"Dismiss"/"close", and the "review & amend →" link) are all
 * real Tab stops even while the sheet sits off-screen. pocket.css moves the
 * closed sheet out of view with `transform:translateY(105%)` alone — no
 * `visibility:hidden` — and its own `.sheet .acts{display:flex}` rule
 * (an ordinary author rule, which always outranks the user-agent stylesheet
 * regardless of specificity) overrides the `hidden` attribute `#sh-acts-sugg`
 * and `#sh-amend` are marked with in the markup, so even those stay
 * `display:flex`/`display:block` rather than `display:none`. A transform
 * alone does not remove an element from the Tab order in a real browser —
 * only `display:none`, `visibility:hidden`, `inert`, `tabindex="-1"` or
 * `disabled` do — which is exactly the lesson `web/src/lib/Chrome.svelte`'s
 * own `.account` panel already carries a comment about (its #847 fix): "opacity
 * and pointer-events alone still let Tab land on the links... visibility is
 * delayed to match the close animation". That same delayed-`visibility`
 * treatment was never applied to pocket's `#sheet`. Not fixed here — see the
 * rules in this file's own brief.
 */
test("home (pocket): every control is reachable, focus is visible, and Tab is not trapped", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page, { withItem: true });
  try {
    await auditTabOrder(page, "home (pocket)");
  } finally {
    await cleanup(page, household);
  }
});

test("home (pocket): the sky strip is reachable and keeps focus visible", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page);
  try {
    /* #845: the strip of other systems scrolls sideways under a thumb, and
       is reachable to scroll by keyboard via its own tabindex — proved
       directly (not just as part of the whole-page walk above) since it is
       the one piece of #845's own work this file exists to cover. */
    await tabTo(page, { selector: ".skies" }, { screen: "home (pocket)" });
    const skies = await currentFocus(page);
    expect(skies?.focusVisible, "home (pocket): the sky strip has no visible focus indicator").toBe(true);
  } finally {
    await cleanup(page, household);
  }
});

/**
 * KNOWN PRODUCT BUG, kept failing on purpose (see the file header): the
 * dial's item bodies (`[data-sheet-title]`) and its suggestion markers
 * (`[data-sheet-sugg]`) are plain SVG `<circle>`/`<g>` elements.
 * pocket.behaviour.js binds only `click` listeners to them — no `tabindex`,
 * no `role`, no `keydown` handler anywhere — so Tab can never land on one and
 * the bottom sheet (`#sheet`) has no keyboard path to open at all. This test
 * drives that real path (Tab to the first dial body, Enter) rather than
 * inventing a keyboard-only substitute, so it fails with a precise, honest
 * message instead of silently passing on a path nobody can actually take.
 */
test("home (pocket): the item sheet opens and light-dismisses by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHomePocket(page, { withItem: true });
  try {
    await tabTo(page, { selector: "[data-sheet-title]" }, { screen: "home (pocket) dial" });
    await page.keyboard.press("Enter");
    await expect(page.locator("#sheet")).toHaveClass(/open/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#sheet")).not.toHaveClass(/open/);
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
    await auditLightDismiss(page, "home (pocket)", "#morb", "#maccount");
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
    await expect(page.locator("#maccount")).toHaveClass(/open/);
    await tabTo(page, { selector: "#maccount nav a", textIncludes: "Inbox" }, { screen: "home (pocket) account menu" });
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
    await fillCreateForm(page, "Keyboard-only proving ground (pocket audit)");
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
    await fillCreateForm(page, name);

    await tabTo(page, { selector: ".btn-primary" }, { screen: "create form (pocket)" });
    const submit = await currentFocus(page);
    expect(submit?.focusVisible, "create (pocket): the submit button has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/home$/, { timeout: 10_000 });
    /* The pocket dialect draws a created item as a `.mitem` row (its manifest
       is a list, not the desk's dial + corridor pair) — not the desk's
       `.item`, which pocket.svelte never renders. */
    await expect(page.locator(".mitem", { hasText: name })).toBeVisible({ timeout: 30_000 });
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
    await expect(page.locator("a.back")).toBeVisible({ timeout: 30_000 });
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
    await expect(page.locator("a.back")).toBeVisible({ timeout: 30_000 });

    await tabTo(page, { tag: "BUTTON", textIncludes: "reschedule" }, { screen: "item page (pocket) actions" });
    await page.keyboard.press("Enter");
    await expect(page.locator(".panel")).toBeVisible();
    await tabTo(page, { selector: "#a-due" }, { screen: "item page (pocket) reschedule panel" });
    const dueField = await currentFocus(page);
    expect(dueField?.focusVisible, "item page (pocket): the reschedule date field has no visible focus indicator").toBe(true);
    const newDue = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await page.locator("#a-due").fill(newDue);
    await tabTo(page, { selector: ".panel .btn-primary" }, { screen: "item page (pocket) reschedule panel" });
    await page.keyboard.press("Enter");
    await expect(page.locator(".panel")).toBeHidden();
    await expect(page.locator(".problem")).toBeHidden();

    await tabTo(page, { selector: "a.back" }, { screen: "item page (pocket)" });
    const back = await currentFocus(page);
    expect(back?.focusVisible, "item page (pocket): the back link has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/home/);
  } finally {
    await cleanup(page, household);
  }
});

/**
 * household/[id]/+page.svelte is likewise dialect-blind, and pocket home has
 * no sun/dial door onto it (that is desk-only chrome) — direct navigation.
 */
test("household page (pocket): fully reachable by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.goto(`/household/${household.id}`);
    await expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 });
    /* Scoped away from `.cand`, same reason as the desktop file: "Add
       someone" lists every account on this shared acceptance instance not
       yet in the household, genuinely unbounded and not part of what this
       test proves. */
    await auditTabOrder(page, "household page (pocket)", { exclude: ".cand" });
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
    await expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 });
    await tabTo(page, { selector: "a.back" }, { screen: "household page (pocket)" });
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
    /* Chrome.svelte's account panel is the same component instance
       v19-keyboard.spec.ts's desk settings test exercises; walked again here
       to prove it still light-dismisses at the phone viewport, since it is
       not itself dialect-switched. */
    await auditLightDismiss(page, "settings (pocket)", "button.orb", "#account");
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
    /* The inbox draws its queue or its empty-state relay bar only once the
       view has loaded (inbox/+page.svelte: `{#if view}`) — audit the loaded
       screen, not the shell, same as the desktop file. */
    await expect(page.locator(".inbox-page .lanes, .inbox-page .quietnote").first()).toBeVisible({ timeout: 30_000 });
    await auditTabOrder(page, "inbox (pocket)");
  } finally {
    await cleanup(page, household);
  }
});

/**
 * admin/+page.svelte (the observatory) is server-loaded (+page.js's `load`
 * resolves before the component renders, no client-side data race) and is
 * not on the desktop file's own list of screens at all — audited here on its
 * own since #849 names it explicitly. It has no back link and no Chrome; its
 * nav is six plain `<a href="#">` stops (one "Operations", five inert
 * placeholders the product itself documents as "named in the nav and have no
 * design behind them yet" — admin/+page.svelte's own comment), so this is a
 * genuine reachability audit, not a journey through other chrome.
 */
test("admin (pocket): fully reachable by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await installKeyboardAudit(page);
  await signIn(page, "/home");
  await page.goto("/admin");
  await expect(page.locator(".obs")).toBeVisible({ timeout: 30_000 });
  await auditTabOrder(page, "admin (pocket)");
});
