import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { homeIsLive } from "./support/keyboard";

/**
 * #1074: the account panel on an empty sky.
 *
 * The account panel is chrome, not household data: the avatar, Inbox,
 * Settings, the THEME row and sign-out belong to every reader on /home,
 * whether or not they are in a household. Both dialects draw all of it while
 * the sky is empty (the markup sits outside `{#if view?.emptySky}` in
 * +page.svelte and pocket.svelte), so a reader who is adrift can see the
 * whole menu.
 *
 * Seeing it is not the same as being able to use it. +page.svelte's mount
 * takes an empty-sky branch of its own, and only `mountHome`/`mountPocket`
 * bind `button.orb` and `#morb` — so on the empty sky the orb had nothing
 * listening to it and the panel never opened. Sub-screens were never
 * affected: $lib/Chrome.svelte binds its own orb.
 *
 * These two journeys are the reproduction #1074 was filed without. They
 * stand up a real reader with no household, wait for home to say it is live
 * (`body[data-home-ready]`, #1064 — so a failure here is "nothing is
 * listening", never "the test was early"), and then work the panel: open it,
 * change the theme, arm sign-out, and walk out of it onto /settings.
 */

const READER = "Orbit Outsider";

async function signIn(page: Page, account: string) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

/**
 * THE READER'S OWN ARRIVAL ON /home, ADRIFT (#840) — the same route
 * v19-hit-routing.spec.ts and v19-membership.spec.ts take, for the same
 * reason. hooks.server.js sends a session with no household of its own to
 * the arrival at `/` instead of /home; the one road left open is the
 * carve-out its comment names, a session whose OWN activeHouseholdId is set,
 * even to a household since hard-deleted. So this reader is given a
 * household, the administrator removes it from underneath them, and only
 * then is /home asked for. Their real membership set is empty either way,
 * which is what the empty sky is a picture of.
 */
async function arriveAdrift(page: Page, browser: Browser, account: string) {
  await signIn(page, account);
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };
  const household = { id: randomUUID(), name: `${account} throwaway ${Date.now()}` };
  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: { ...household, timezone: "Europe/London", currency: "GBP", onboardingComplete: true },
    },
  });
  if (!created.ok()) throw new Error(`could not seed a throwaway household for ${account} (${created.status()})`);

  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const adminPage = await adminContext.newPage();
  try {
    await signIn(adminPage, "Orbit Administrator");
    await cleanupHousehold(adminPage, await sessionHeaders(adminPage), household.id, household.name);
  } finally {
    await adminContext.close();
  }

  await page.goto("/home");
}

/**
 * The launch flight, then the moment home can answer.
 *
 * Not support/keyboard.ts's `dismissTourIfShown`: that one WAITS for the tour
 * card whenever the reader's record says they have never taken the tour, and
 * the empty sky never draws it — the tour walks the dial, and an adrift
 * reader has no dial. Waiting for it here timed out at 60s on both dialects
 * before the sky's own screen was ever touched. Escape it if it is there and
 * carry on if it is not.
 */
async function settleEmptySky(page: Page) {
  await page.waitForFunction(() => !document.body.classList.contains("launching"), null, { timeout: 60_000 });
  await homeIsLive(page);
  const tour = page.locator(".tourcard");
  if (await tour.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(tour).toBeHidden();
  }
}

/** The live theme, which both dialects' THEME rows write to <html>. */
const liveTheme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);

test.describe.configure({ mode: "serial" });

test("home (desk, empty sky): the account panel opens and its controls answer", async ({ page, browser }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the desk dialect; the pocket has its own journey below");
  test.setTimeout(120_000);

  await arriveAdrift(page, browser, READER);
  await expect(page.getByRole("heading", { name: "you’re adrift" })).toBeVisible();
  await settleEmptySky(page);

  /* The orb is drawn for this reader — the panel's whole contents are chrome,
     not household data — so the press below lands on something real. */
  const orb = page.locator("button.orb");
  const panel = page.locator("#account");
  await expect(orb).toBeVisible();
  await orb.click();
  await expect(panel).toHaveClass(/open/);
  await expect(orb).toHaveAttribute("aria-expanded", "true");
  await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

  /* THEME answers: the swatch row is wired, not just painted. */
  await panel.locator(".swatches button[title='after dark']").click();
  await expect.poll(() => liveTheme(page)).toBe("afterdark");

  /* Sign-out arms on the first tap (the second one revokes the session, so
     this stops at one). */
  const signout = panel.locator("button.signout");
  await expect(signout).toBeVisible();
  await signout.click();
  await expect(signout).toHaveText(/tap again to sign out/);

  /* And the panel is a way out of home, not an ornament. */
  await panel.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
});

test("home (pocket, empty sky): the account menu opens and its controls answer", async ({ page, browser }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "the pocket dialect; the desk has its own journey above");
  test.setTimeout(120_000);

  await arriveAdrift(page, browser, READER);
  await expect(page.locator(".mgroup.adrift")).toBeVisible();
  await settleEmptySky(page);

  const morb = page.locator("#morb");
  const menu = page.locator("#maccount");
  await expect(morb).toBeVisible();
  await morb.click();
  await expect(menu).toHaveClass(/open/);
  await expect(morb).toHaveAttribute("aria-expanded", "true");
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

  await menu.locator(".mswatches button[title='after dark']").click();
  await expect.poll(() => liveTheme(page)).toBe("afterdark");

  const signout = menu.locator("#msignout");
  await expect(signout).toBeVisible();
  await signout.click();
  await expect(signout).toHaveText(/tap again to sign out/);

  await menu.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
});
