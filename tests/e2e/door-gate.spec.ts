import { expect, test, type Page } from "@playwright/test";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { householdRegister } from "./support/households";
import { seedHousehold, signIn } from "./support/signed-in";
import { workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { settleArrival } from "./support/arrival";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1252: `/` DECIDES ON THE SERVER.
 *
 * A signed-in member who refreshed `/` was served the sign-in door, and only
 * once the browser had asked GET /api/auth/session did Arrival.svelte's
 * decide() hand them on to /home -- long enough to see the door. The hook
 * (web/src/hooks.server.js) now answers that reader 303 to /home before any
 * HTML is sent, so the door's document never exists in their tab at all.
 *
 * What only a browser can show, and so what is asserted here: the FIRST
 * answer to `/` is the redirect, never cached; no document at `/` ever asks
 * for the session; and `.signin-stage` never attaches. The other branches
 * (no household, the invited landing) still get the door, also never cached.
 * Every failure branch of the hook is pinned without a browser in
 * tests/unit/hooks-server-door.test.mjs.
 */

const households = householdRegister();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await claimInstanceAsAdministrator(browser);
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signIn(page, "/home");
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

/** The way every other spec signs in: straight at the engine's login route. */
async function signInAs(page: Page, account: string, returnTo = "/") {
  await answerPushWithoutAService(page);
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: account }).click();
}

/**
 * Records, across every document in the tab, whether `.signin-stage` ever
 * attached and where. sessionStorage survives the same-origin navigation to
 * /home, so a door that rendered for a moment still leaves its mark.
 */
async function witnessSignInStage(page: Page) {
  await page.addInitScript(() => {
    const KEY = "orbit-e2e-signin-stage";
    const look = () => {
      if (document.querySelector(".signin-stage")) sessionStorage.setItem(KEY, location.pathname);
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
    look();
  });
}

async function signInStageSeen(page: Page) {
  return page.evaluate(() => sessionStorage.getItem("orbit-e2e-signin-stage"));
}

/** Session probes sent while the tab's document was `/`. */
function sessionProbesAtTheDoor(page: Page) {
  const probes: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/auth/session") return;
    if (new URL(page.url()).pathname === "/") probes.push(request.url());
  });
  return probes;
}

/** The invited-landing cookie, under the same prefix the session cookie wears. */
async function plantInvitedLanding(page: Page) {
  const cookies = await page.context().cookies();
  const secure = cookies.some((cookie) => cookie.name === "__Host-orbit-session");
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    {
      name: secure ? "__Host-orbit-invited" : "orbit-invited",
      value: "1",
      url: `${origin}/`,
      httpOnly: true,
      secure,
      sameSite: "Lax",
    },
  ]);
}

test("a signed-in member refreshing / is answered 303 to /home and never sees the door", async ({ page }) => {
  test.setTimeout(120_000);

  await signIn(page, "/home");
  const household = households.track(await seedHousehold(page, "door-gate"));
  await page.goto("/home");
  await expect(page).toHaveURL(/\/home$/);

  await witnessSignInStage(page);
  const probes = sessionProbesAtTheDoor(page);
  const documentsAtTheDoor: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname === "/") documentsAtTheDoor.push(frame.url());
  });

  const landed = await page.goto("/");
  const first = landed?.request().redirectedFrom() ?? null;
  expect(first, "the first answer to / was not a redirect").not.toBeNull();
  const answer = await first!.response();
  expect(answer?.status()).toBe(303);
  expect(answer?.headers()["location"]).toBe("/home");
  expect(answer?.headers()["cache-control"]).toBe("no-store");

  await expect(page).toHaveURL(/\/home$/);
  /* Text, not visibility: the phone layouts keep the dial's name hidden. */
  await expect(page.locator("#dial-name")).toHaveText(household.name, { timeout: 30_000 });
  expect(documentsAtTheDoor).toEqual([]);
  expect(probes).toEqual([]);
  expect(await signInStageSeen(page)).toBeNull();
});

test("a session that belongs nowhere is served the door at /, never cached", async ({ page }) => {
  test.setTimeout(120_000);

  await signInAs(page, workerAccount("newcomer"), "/");
  await settleArrival(page, 30_000, "/");
  await expect(page).toHaveURL(/\/$/);

  const response = await page.goto("/");
  expect(response?.request().redirectedFrom() ?? null).toBeNull();
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  await expect(page).toHaveURL(/\/$/);
});

test("a member carrying the invited-landing cookie is served the door, so the arrival still plays", async ({ page }) => {
  test.setTimeout(120_000);

  await signIn(page, "/home");
  await plantInvitedLanding(page);

  const response = await page.goto("/");
  expect(response?.request().redirectedFrom() ?? null).toBeNull();
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe("no-store");
});
