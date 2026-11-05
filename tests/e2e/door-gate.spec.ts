import { expect, test, type Page } from "@playwright/test";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { householdRegister } from "./support/households";
import { seedHousehold, signIn } from "./support/signed-in";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1252: `/` DECIDES ON THE SERVER, and what only a browser can show is kept
 * here (#1612 part A review; ADR-0039).
 *
 * The server's own answers at `/` -- 303 to /home with `no-store` for a member,
 * the door with `no-store` and no ETag for everyone else, every failure branch
 * of the hook -- are pinned without a browser in
 * tests/unit/hooks-server-door.test.mjs. What stays here needs a real signed-in
 * member and a real tab, so it cannot move to the rig (whose fixture app has no
 * database and so no session, and serves the door to everyone): the redirect is
 * still the FIRST answer to `/` with the service worker in the way (#1329),
 * no document at `/` ever asks for the session, and `.signin-stage` never
 * attaches.
 */

const households = householdRegister();

/* #1329: what this file asserts includes the server's own first answer to `/`.
   Orbit's worker now answers page navigations (network first, the offline
   page only when the fetch fails), and Firefox does not report a redirect
   that came back through a worker's answer: `redirectedFrom()` is null and
   the 303 is invisible, though the reader still lands on /home and never
   sees the door (checked by hand, pipeline 2382). Chromium still reports it,
   so only Firefox keeps the worker out here, to watch the server directly. */
test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "firefox" ? "block" : "allow");
  },
});

test.beforeAll(async ({ browser }) => {
  await claimInstanceAsAdministrator(browser);
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signIn(page, { returnTo: "/home" });
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

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

test("a signed-in member refreshing / is answered 303 to /home and never sees the door", async ({ page }) => {
  test.setTimeout(120_000);

  await signIn(page, { returnTo: "/home" });
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
  /* Soft, so the door checks below still report beside a missing redirect. */
  expect.soft(first, "the first answer to / was not a redirect").not.toBeNull();
  expect.soft((await first?.response())?.status(), "the first answer to / was not a 303").toBe(303);

  await expect(page).toHaveURL(/\/home$/);
  /* Text, not visibility: the phone layouts keep the dial's name hidden. */
  await expect(page.locator("#dial-name")).toHaveText(household.name, { timeout: 30_000 });
  expect.soft(documentsAtTheDoor, "a document at / was shown").toEqual([]);
  expect.soft(probes, "a document at / asked for the session").toEqual([]);
  expect.soft(await signInStageSeen(page), ".signin-stage attached").toBeNull();
});
