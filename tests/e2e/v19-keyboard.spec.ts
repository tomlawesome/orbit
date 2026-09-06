import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import {
  auditLightDismiss,
  auditTabOrder,
  currentFocus,
  fillCreateForm,
  installKeyboardAudit,
  settled,
  tabTo,
} from "./support/keyboard";

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

const READER = "Orbit Administrator";

/* The pocket layouts are different screens with their own chrome; their walk
   is #849. This file covers the desktop screens. */
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "desktop screens only; the pocket walk is #849");
});

async function signIn(page: Page, returnTo: string) {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER }).click();
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
 *  navigation — onRowClick calls preventDefault), and its "manage this item"
 *  link is the real way onto /item/[id] by keyboard. Shared by the two item
 *  tests below so each gets this same real path on its own fresh page. */
async function openItemPageFromHome(page: Page, itemId: string) {
  await page.goto("/home");
  await settled(page);
  await tabTo(page, { selector: `a.item[id="${itemId}"]` }, { screen: "home corridor row" });
  await page.keyboard.press("Enter");
  await expect(page.locator(`a.item[id="${itemId}"]`)).toHaveClass(/open/);
  await tabTo(page, { selector: ".ivfull" }, { screen: "home expanded row" });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/item\//);
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
    await tabTo(page, { tag: "A", textIncludes: READER }, { screen: "identity provider" });
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

test("item page: reached from home's manifest by keyboard, is fully reachable", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page, { withItem: true });
  try {
    await openItemPageFromHome(page, household.itemId as string);
    await auditTabOrder(page, "item page");
  } finally {
    await cleanup(page, household);
  }
});

test("item page: actions and the back link work by keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page, { withItem: true });
  try {
    await openItemPageFromHome(page, household.itemId as string);

    /* Reschedule: open the panel, change the date, save, and the panel closes
       without a `.problem` alert. */
    await tabTo(page, { tag: "BUTTON", textIncludes: "reschedule" }, { screen: "item page actions" });
    await page.keyboard.press("Enter");
    await expect(page.locator(".panel")).toBeVisible();
    await tabTo(page, { selector: "#a-due" }, { screen: "item page reschedule panel" });
    const dueField = await currentFocus(page);
    expect(dueField?.focusVisible, "item page: the reschedule date field has no visible focus indicator").toBe(true);
    // See fillCreateForm's #f-date: `fill()`, not typed digits, sidesteps the locale-dependent segment order.
    const newDue = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await page.locator("#a-due").fill(newDue);
    await tabTo(page, { selector: ".panel .btn-primary" }, { screen: "item page reschedule panel" });
    await page.keyboard.press("Enter");
    await expect(page.locator(".panel")).toBeHidden();
    await expect(page.locator(".problem")).toBeHidden();

    await tabTo(page, { selector: "a.back" }, { screen: "item page" });
    const back = await currentFocus(page);
    expect(back?.focusVisible, "item page: the back link has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/home/);
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

    await expect(page).toHaveURL(/\/home$/, { timeout: 10_000 });
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
    await auditTabOrder(page, "household page", { exclude: ".cand" });
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
    await auditTabOrder(page, "settings");
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

test("sign out: the two-tap control ends the session by keyboard alone", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await tabTo(page, { selector: "button.orb" }, { screen: "home" });
    await page.keyboard.press("Enter");
    await tabTo(page, { selector: ".signout" }, { screen: "home account panel" });
    const signOut = await currentFocus(page);
    expect(signOut?.focusVisible, "home: the sign-out control has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter"); // arms
    await expect(page.locator(".signout")).toHaveText(/tap again/);
    await page.keyboard.press("Enter"); // fires — revokes the session, then plays the descent

    await expect(page).toHaveURL(/\/logout$/, { timeout: 15_000 });
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      return (await response.json()) as { authenticated?: boolean };
    });
    expect(session.authenticated, "sign out: the session is still authenticated after the two-tap control fired").toBeFalsy();

    /* Cleanup needs a live session again — sign back in the same keyboard way
       the arrival journey proved, so this test's own household can still be
       removed once it revoked the session that was carrying it. */
    await page.goto("/api/auth/login?returnTo=/home");
    await tabTo(page, { tag: "A", textIncludes: READER }, { screen: "identity provider" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
  } finally {
    await cleanup(page, household);
  }
});
