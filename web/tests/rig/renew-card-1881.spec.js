import { expect, test } from "@playwright/test";

import { APP, door, onPhone } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Locator} Locator */

/*
 * THE RENEW CARD (#1881, design/v19/password-after-refusal/round-1, direction
 * R, owner verdict 60a), on the desk and on the phone (rig-desktop, rig-phone).
 *
 * A refused sign-in marks the password; the next sign-in, once approved,
 * gets no session but the change-password hold, and the door shows the ring
 * card again in its renew mode. The server's half is proved against
 * PostgreSQL in tests/integration/forced-reset-after-refusal-1881.test.ts;
 * this file holds what only a browser can: the card is drawn, fits the
 * screen, speaks the wording table's words, and its pill saves and goes on.
 * The API answers are faked here exactly as the engine gives them.
 */
test.use({ baseURL: APP });

const REFUSED_AT = "2026-11-11T21:14:00.000Z";
const RETURN_TO = "/?arrival=newcomer&drawer=1";
const NEW_PASSWORD = "a-brand-new-password-1881";

/**
 * Walks the local door to the renew card: the password is typed, the
 * approval is "pressed", and the poll answers with the hold.
 * @param {Page} page
 */
async function reachTheRenewCard(page) {
  await door("login", "local-card")(page);
  await page.route("**/api/auth/local/login", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      authenticated: false,
      pending: {
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        canResendAt: new Date(Date.now() + 60_000).toISOString(),
        limited: false,
      },
    }),
  }));
  await page.route("**/api/auth/local/login/pending", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ state: "password_change_required", refusedAt: REFUSED_AT }),
  }));
  await page.goto(`/login?returnTo=${encodeURIComponent(RETURN_TO)}`);
  await page.fill("#idemail", "ned@harlow.example");
  await page.fill("#idpassword", "the password somebody knew");
  await page.locator("#idbtn").click();
  await expect(page.locator(".card.renew")).toBeVisible({ timeout: 30_000 });
}

/**
 * The box of `locator` lies inside the viewport's width, and the page itself
 * does not scroll sideways.
 * @param {Page} page
 * @param {Locator} locator
 * @param {string} what
 */
async function expectWithinWidth(page, locator, what) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  if (!box) throw new Error(`${what} has no box`);
  expect(box.x, `${what} starts left of the screen`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} runs off the right of the screen`).toBeLessThanOrEqual(width + 0.5);
}

test("a marked password's approved sign-in lands on the renew card, which saves and goes on", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await reachTheRenewCard(page);
  const card = page.locator(".card.renew");

  /* The wording table's words, the moment with its month in full. */
  await expect(page.locator("#cardask")).toHaveText("Choose a new password");
  await expect(card.locator(".note.why")).toHaveText(
    "A sign-in with this password was refused on 11 November 2026 at 21:14 UTC — somebody else knew it. Choose a new one and you’re in.",
  );
  await expect(card.locator("label[for=idpassword]")).toHaveText("new password");
  await expect(card.locator("label[for=idagain]")).toHaveText("new password again");
  await expect(card.locator("#idrule")).toHaveText("at least 12 characters · not the old one");
  await expect(page.locator("#idbtn")).toHaveText("Continue");
  /* Nothing of the sign-in card is left on it. */
  await expect(card.locator("#idemail")).toHaveCount(0);

  /* It fits this screen: no sideways scroll, and every part inside the width. */
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways, `the ${onPhone(testInfo) ? "phone" : "desk"} page scrolls sideways`).toBeLessThanOrEqual(0);
  for (const [what, part] of /** @type {[string, Locator][]} */ ([
    ["the note", card.locator(".note.why")],
    ["the new password field", page.locator("#idpassword")],
    ["the second field", page.locator("#idagain")],
    ["the rule line", card.locator("#idrule")],
    ["the pill", page.locator("#idbtn")],
  ])) {
    await expect(part, `${what} is not visible`).toBeVisible();
    await expectWithinWidth(page, part, what);
  }
  /* The note sits above the fields and does not cover them. */
  const note = await card.locator(".note.why").boundingBox();
  const field = await page.locator("#idpassword").boundingBox();
  if (!note || !field) throw new Error("the note or the first field has no box");
  expect(note.y + note.height, "the note runs into the first field").toBeLessThanOrEqual(field.y + 0.5);

  /* Two entries that differ are said so before anything is sent, and the pill waits. */
  await page.fill("#idpassword", NEW_PASSWORD);
  await page.fill("#idagain", `${NEW_PASSWORD}-typo`);
  await expect(card.locator(".err.shown")).toHaveText("Those two passwords are not the same.");
  await expect(page.locator("#idbtn")).toBeDisabled();

  /** @type {unknown[]} */
  const posted = [];
  await page.route("**/api/auth/local/login/new-password", async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true }) });
  });
  await page.fill("#idagain", NEW_PASSWORD);
  await expect(page.locator("#idbtn")).toBeEnabled();
  await page.locator("#idbtn").click();

  await expect(page).toHaveURL(/\/\?arrival=newcomer/, { timeout: 30_000 });
  expect(posted).toEqual([{ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }]);
});

test("the renew card answers the refused password in its own words and keeps its place", async ({ page }) => {
  test.setTimeout(90_000);
  await reachTheRenewCard(page);
  await page.route("**/api/auth/local/login/new-password", (route) => route.fulfill({
    status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "password_unchanged" } }),
  }));
  await page.fill("#idpassword", "the password somebody knew");
  await page.fill("#idagain", "the password somebody knew");
  await page.locator("#idbtn").click();

  await expect(page.locator(".card.renew .err.shown"))
    .toHaveText("That is the password that was refused. Choose a different one.");
  await expect(page.locator(".card.renew")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("a lapsed hold turns the card into its lapsed state, with the way back to sign in", async ({ page }) => {
  test.setTimeout(90_000);
  await reachTheRenewCard(page);
  await page.route("**/api/auth/local/login/new-password", (route) => route.fulfill({
    status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "password_change_lapsed" } }),
  }));
  await page.fill("#idpassword", NEW_PASSWORD);
  await page.fill("#idagain", NEW_PASSWORD);
  await page.locator("#idbtn").click();

  const card = page.locator(".card.renew.lapsed");
  await expect(card).toBeVisible();
  await expect(card.locator(".note.why"))
    .toHaveText("This sign-in has lapsed before a new password was saved. Sign in again and choose one then.");
  await expect(page.locator("#idpassword")).toBeHidden();
  await expect(page.locator("#idbtn")).toBeHidden();
  const back = card.locator(".note.after").getByRole("button", { name: "sign in" });
  await expect(back).toBeVisible();
  await expectWithinWidth(page, back, "the sign-in line");
});
