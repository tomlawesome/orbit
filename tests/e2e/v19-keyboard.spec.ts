import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { dropSession, settleArrival } from "./support/arrival";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { currentFocus, installKeyboardAudit, settled, tabTo } from "./support/keyboard";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #496: the two keyboard-only journeys that need the full stack, driven
 * entirely by `page.keyboard.press`/`.type` (no `.click()`): the sign-in door
 * through the identity provider, and the sign-out control ending a real
 * session and the provider sending the browser back to /logout.
 *
 * Every other desk keyboard walk (home, drawers, create, household, settings,
 * inbox, the sign-in-methods and administration controls) moved to the rig,
 * web/tests/rig/v19-keyboard.spec.js, against the fixture app (ADR-0039,
 * #1609). DESKTOP ONLY here too; the pocket walk is
 * web/tests/rig/v19-keyboard-pocket.spec.js.
 *
 * Each test signs in fresh, seeds its own household and cleans it up in
 * `finally`; nothing is shared between tests.
 */

/* #1080: this worker's own administrator, resolved lazily (worker env only). */
const READER = () => workerAccount("administrator");
const ITEM_TITLE = "Keyboard-reached boiler service";

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "desktop screens only; the pocket walk is on the rig");
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
    const dueDate = householdDateFromToday(20);
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

/**
 * Signs in, seeds a household of the reader's own, installs the keyboard
 * audit and lands settled on `/home`. The keyboard-audit machinery lives in
 * ./support/keyboard.ts, shared with the rig's keyboard walks. Callers clean
 * up the returned household in `finally`.
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
  /* #1554: not `context.clearCookies()` under the live page -- see dropSession. */
  await dropSession(page, context);
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

/** The test identity provider (tests/oidc/server.mjs); its end-session path sends the browser back to Orbit's /logout. */
const PROVIDER_ORIGIN = "https://orbit-oidc:4443";

test("sign out: the one-press control ends the session by keyboard alone", async ({ page }) => {
  test.setTimeout(60_000);
  const household = await arriveAtHome(page);
  try {
    await tabTo(page, { selector: "button.orb" }, { screen: "home" });
    await page.keyboard.press("Enter");
    await tabTo(page, { selector: ".signout" }, { screen: "home account panel" });
    const signOut = await currentFocus(page);
    expect(signOut?.focusVisible, "home: the sign-out control has no visible focus indicator").toBe(true);
    /* The goodbye hands the browser to the identity provider's end-session
       address, and the provider sends it back to Orbit's /logout. The /logout
       the URL shows first is only a replaceState during the goodbye, so
       navigating on at once races that hand-off (Firefox lost the race in
       pipeline 2588: "Navigation to /api/auth/login is interrupted by another
       navigation to /logout"). The first fix waited for the /logout response
       redirected from the provider and then called waitForLoadState, but a
       response resolves when its headers arrive, before the new document has
       replaced the goodbye: waitForLoadState saw the old, already loaded page
       and returned, and the goto was aborted by the commit (ERR_ABORTED). So
       wait for what proves the trip is over: the response from the provider,
       then the load of the document it brought back. Both are registered
       before the press so neither can be missed, and settled to true/false so
       a failure earlier in the test leaves no unhandled rejection. */
    const cameBackFromProvider = page
      .waitForResponse(
        (response) => {
          const request = response.request();
          return (
            request.isNavigationRequest() &&
            new URL(response.url()).pathname === "/logout" &&
            (request.redirectedFrom()?.url().startsWith(`${PROVIDER_ORIGIN}/`) ?? false)
          );
        },
        { timeout: 30_000 },
      )
      .then(
        () => true,
        () => false,
      );
    const returnedDocumentLoaded = page.waitForEvent("load", { timeout: 30_000 }).then(
      () => true,
      () => false,
    );
    await page.keyboard.press("Enter"); // revokes the session, then plays the descent (one press: owner, 2026-10-06)

    await expect(page).toHaveURL(/\/logout$/, { timeout: 15_000 });
    expect(await cameBackFromProvider, "sign out: the browser never came back from the provider's end-session page to /logout").toBe(true);
    expect(await returnedDocumentLoaded, "sign out: the /logout document the provider returned to never finished loading").toBe(true);
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
