import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { waitForInvitationLink } from "./support/mail";
import { claimInstanceAsAdministrator } from "./support/bootstrap";

/**
 * #481: THE MAILED INVITATION, end to end. An owner sends one to an address
 * with no Orbit account yet, and that address ends up a member -- with no
 * interception anywhere. The mail is a real SMTP delivery to the disposable
 * GreenMail sidecar, read back the way a real mail client would
 * (tests/e2e/support/mail.ts), and the invitee signs in through the real
 * identity provider.
 *
 * The mail's own words are a placeholder -- src/server/invitations/mail.ts
 * says so directly, the owner is still choosing a direction on #481 -- so
 * nothing here is asserted against them. The only thing pulled out of the
 * mail is the `/invite/<token>` link.
 *
 * "Orbit Newcomer" is the one identity in tests/oidc/server.mjs that belongs
 * to nothing between specs (v19-arrival.spec.ts's own comment explains why:
 * the database is never reset between specs, so a dedicated identity is the
 * only way to have a reader with no membership at all). This spec hands that
 * newcomer a real membership, so it ends by hard-deleting the household it
 * joined -- the same #730 sweep every other spec's fixtures get -- which
 * cascades the membership away too and gives the invariant back.
 */

const OWNER_ACCOUNT = "Orbit Member";
const ADMIN_ACCOUNT = "Orbit Administrator";
const NEWCOMER_ACCOUNT = "Orbit Newcomer";
const NEWCOMER_EMAIL = "newcomer@example.test";
const HOUSEHOLD = `Invitation Proving Ground ${Date.now()}`;

const households = householdRegister();
let seeded = false;

async function signInAs(page: Page, account: string) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  /* Not a fixed destination: #840 sends a session with no household of its
     own to the arrival at `/` instead of /home, and both callers below sign
     in before any household exists for that account (establishInstanceAdmin
     is the instance's very first sign-in; the owner's own signInAs runs
     before createHousehold). Neither needs the landing page -- only a real
     session, which every request after this one carries regardless of which
     screen is showing. */
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
}

async function createHousehold(page: Page, name: string) {
  const headers = await sessionHeaders(page);
  const response = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: { id: randomUUID(), name, timezone: "Europe/London", currency: "GBP", onboardingComplete: true },
    },
  });
  if (!response.ok()) throw new Error(`household.create failed: ${response.status()} ${await response.text()}`);
  const { workspace } = (await response.json()) as {
    workspace: { households: { id: string; name: string; canManage: boolean }[] };
  };
  const created = workspace.households.find((one) => one.name === name);
  if (!created) throw new Error("household.create did not return the household it just made");
  return created;
}

async function workspaceOf(page: Page) {
  const response = await page.request.get("/api/workspace");
  if (!response.ok()) throw new Error(`workspace read failed: ${response.status()}`);
  const { workspace } = (await response.json()) as {
    workspace: { households: { id: string; name: string; canManage: boolean }[] };
  };
  return workspace;
}

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signInAs(page, ADMIN_ACCOUNT);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("a mailed invitation makes a stranger a member, through the real pipe", async ({ page, browser }) => {
  test.setTimeout(180_000);

  /* Only an administrator can hard-delete a household in the cleanup below,
     and since ADR-0022 nobody is promoted by signing in: the instance is
     claimed with the code from its own log. Idempotent, as both callers
     below need it. */
  await claimInstanceAsAdministrator(browser);

  await signInAs(page, OWNER_ACCOUNT);
  const created = await createHousehold(page, HOUSEHOLD);
  households.track(created);
  seeded = true;
  expect(created.canManage).toBe(true);

  const headers = await sessionHeaders(page);
  const sendResponse = await page.request.post(`/api/households/${created.id}/invitations`, {
    headers,
    data: { email: NEWCOMER_EMAIL },
  });
  expect(sendResponse.ok(), `invitation send failed: ${sendResponse.status()}`).toBe(true);

  // The real pipe: SMTP delivery to GreenMail, read back like a real client.
  const link = await waitForInvitationLink(NEWCOMER_EMAIL, HOUSEHOLD);
  expect(link).toMatch(/\/invite\//u);

  // #871: redemption now lands on the arrival at `/` -- the newcomer's own
  // climb, sky and count -- before moving on to `/home`. Reduced motion
  // collapses that to a beat rather than a wait, so this journey's own
  // assertion (a member ends up on their household) stays exactly as fast
  // and exactly as it read before that changed.
  const newcomerContext = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  const newcomerPage = await newcomerContext.newPage();
  try {
    await newcomerPage.goto(link);
    // Signed out: the load handler parks the token in its own cookie and
    // sends the browser to the identity provider -- the same door every
    // other spec signs in through.
    await newcomerPage.getByRole("link", { name: NEWCOMER_ACCOUNT }).click();
    // The callback reads the parked token back, redeems it, and lands here.
    await expect(newcomerPage).toHaveURL(/\/home$/, { timeout: 30_000 });

    const workspace = await workspaceOf(newcomerPage);
    const joined = workspace.households.find((one) => one.id === created.id);
    expect(joined, "the invited household is not in the newcomer's own workspace").toBeTruthy();
    expect(joined?.canManage).toBe(false);
  } finally {
    await newcomerContext.close();
  }
});

test("an invited reader's arrival never draws the chooser: the sky moves to the household instead (#871)", async ({ page, browser }) => {
  test.setTimeout(180_000);

  /* Only an administrator can hard-delete a household in the cleanup below,
     and since ADR-0022 nobody is promoted by signing in: the instance is
     claimed with the code from its own log. Idempotent, as both callers
     below need it. */
  await claimInstanceAsAdministrator(browser);

  await signInAs(page, OWNER_ACCOUNT);
  const invitedHousehold = `${HOUSEHOLD} (invited landing)`;
  const created = await createHousehold(page, invitedHousehold);
  households.track(created);
  seeded = true;

  const headers = await sessionHeaders(page);
  const sendResponse = await page.request.post(`/api/households/${created.id}/invitations`, {
    headers,
    data: { email: NEWCOMER_EMAIL },
  });
  expect(sendResponse.ok(), `invitation send failed: ${sendResponse.status()}`).toBe(true);

  const link = await waitForInvitationLink(NEWCOMER_EMAIL, invitedHousehold);
  expect(link).toMatch(/\/invite\//u);

  /* Reduced motion, deliberately: `.nf .belong` never renders REGARDLESS of
     motion (Newcomer.svelte leaves it out of the DOM entirely for INVITED --
     see its own note), so this is for speed and determinism, not to dodge a
     race the product itself does not have. */
  const newcomerContext = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  const newcomerPage = await newcomerContext.newPage();
  try {
    await newcomerPage.goto(link);
    await newcomerPage.getByRole("link", { name: NEWCOMER_ACCOUNT }).click();

    // The redemption's own redirect target (#871): the arrival, not /home
    // directly -- this is the newcomer's landing, playing for a reader whose
    // household was already decided.
    await expect(newcomerPage).toHaveURL(/\/$/, { timeout: 30_000 });

    // NO CHOOSER, AT ANY FRAME: not merely hidden -- absent from the DOM for
    // the entire time this reader is on this surface, which is what "not
    // rendered then hidden" (#871's own rule) means in a running browser.
    await expect(newcomerPage.locator(".nf .belong")).toHaveCount(0);

    // NOTHING NAMES THE HOUSEHOLD BEFORE THE MOVE (#871 criterion 4). The
    // point of the invited landing is that the reader is carried somewhere
    // rather than asked to pick it, so the destination must not be spoken
    // aloud on the way. `textContent` rather than `innerText` deliberately:
    // it reads hidden and off-screen nodes too, so a name parked in a
    // not-yet-revealed element still fails this. Asserted here, while the
    // URL is still the arrival's, because after the move /home names the
    // household legitimately.
    const beforeMove = await newcomerPage.evaluate(() => document.body.textContent ?? "");
    expect(beforeMove, "the arrival named the household before moving to it").not.toContain(invitedHousehold);

    // THE COUNT STILL SHOWS: this reader's own household is one of the
    // systems the universe answers with (`listVisibleHouseholds` does not
    // exclude it), so the boxless count is a real, positive number -- not
    // asserted exactly, because the shared instance's total household count
    // is not this file's to pin (other specs make and sweep their own).
    const countText = await newcomerPage.locator(".nf .disc .big").textContent();
    expect(Number(countText)).toBeGreaterThan(0);

    // THE MOVE: the sky lands the reader on their own household, by the same
    // road any arriving member already takes -- no second landing invented.
    await expect(newcomerPage).toHaveURL(/\/home$/, { timeout: 15_000 });
    // and the chooser stays gone for good measure: this surface draws none.
    await expect(newcomerPage.locator(".nf .belong")).toHaveCount(0);

    const workspace = await workspaceOf(newcomerPage);
    const joined = workspace.households.find((one) => one.id === created.id);
    expect(joined, "the invited household is not in the invited reader's own workspace").toBeTruthy();

    // AND THE TOUR STILL RUNS (#871 criterion 3). The invited landing skips
    // the chooser, not the welcome: this reader has never seen /home before,
    // so the first-run tour is exactly as due to them as to any newcomer.
    // #864 is why this is asserted rather than assumed -- the tour was
    // offered to a reader it could light nothing for, and nothing caught it.
    await expect(newcomerPage.locator(".tourcard")).toBeVisible({ timeout: 30_000 });
    await expect(newcomerPage.locator(".tourcard")).toHaveAttribute("data-tour-stop", "1");
  } finally {
    await newcomerContext.close();
  }
});
