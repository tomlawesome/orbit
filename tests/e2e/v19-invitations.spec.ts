import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { waitForInvitationLink } from "./support/mail";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { ensureWorkerAdministrator, workerAccount, workerEmail } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

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

/* The second test of this file, an invited reader's arrival never drawing the
   chooser (#871), moved to web/tests/rig/v19-invitations.spec.js (#1611). */

/* #1080: this worker's own identities, resolved lazily (worker env only).
   The invited address must be the newcomer identity's own, so the invite
   mail lands in the mailbox that identity signs in from. */
const OWNER_ACCOUNT = () => workerAccount("member");
const ADMIN_ACCOUNT = () => workerAccount("administrator");
const NEWCOMER_ACCOUNT = () => workerAccount("newcomer");
const NEWCOMER_EMAIL = () => workerEmail("newcomer");
const HOUSEHOLD = `Invitation Proving Ground ${Date.now()}`;

const households = householdRegister();
let seeded = false;

async function signInAs(page: Page, account: string) {
  await answerPushWithoutAService(page);
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
    await signInAs(page, ADMIN_ACCOUNT());
    /* #1080: the sweep's hard delete is an instance-admin power. */
    await ensureWorkerAdministrator(page);
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

  await signInAs(page, OWNER_ACCOUNT());
  const created = await createHousehold(page, HOUSEHOLD);
  households.track(created);
  seeded = true;
  expect(created.canManage).toBe(true);

  const headers = await sessionHeaders(page);
  const sendResponse = await page.request.post(`/api/households/${created.id}/invitations`, {
    headers,
    data: { email: NEWCOMER_EMAIL() },
  });
  expect(sendResponse.ok(), `invitation send failed: ${sendResponse.status()}`).toBe(true);

  // The real pipe: SMTP delivery to GreenMail, read back like a real client.
  const link = await waitForInvitationLink(NEWCOMER_EMAIL(), HOUSEHOLD);
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
    await newcomerPage.getByRole("link", { name: NEWCOMER_ACCOUNT() }).click();
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
