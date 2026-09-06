import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { waitForInvitationLink } from "./support/mail";

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
  await expect(page).toHaveURL(/\/home$/);
}

/* A fresh instance promotes its first sign-in to instance admin, and only an
   administrator can hard-delete a household in the cleanup below. Claiming it
   here is idempotent: every other spec that needs it does the same. */
async function establishInstanceAdmin(browser: Browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signInAs(page, ADMIN_ACCOUNT);
  } finally {
    await context.close();
  }
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

  await establishInstanceAdmin(browser);

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

  const newcomerContext = await browser.newContext({ ignoreHTTPSErrors: true });
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
