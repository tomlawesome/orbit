import { expect, test, type Browser, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { INTAKE_MAILBOX, countSenderCheckMails, newestSenderCheckUid, waitForSenderCheckLink } from "./support/mail";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { ensureWorkerAdministrator, workerAccount, workerEmail } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   member starts with an address nobody has checked. */
resetDatabaseBetweenSpecFiles();

/**
 * #1410 (ADR-0017 decision 7c): the sender check, from the screen.
 *
 * `v19-mail-collection.spec.ts` claims the member's registered address through
 * the route, with no screen in the way. This is the same journey the way a
 * member takes it: press the one button on the settings mail screen, read the
 * check email out of the disposable GreenMail sidecar, open the link signed in
 * as the member, and see the screen say the address is checked and the relay
 * is listening. Nothing is intercepted.
 *
 * Its set-up (an administrator who configures the mailbox, a member with one
 * household) is that spec's, repeated here because a spec file cannot lean on
 * another's state: the database is put back to the seed between files.
 */
const MAILBOX_ACCOUNT = INTAKE_MAILBOX;
/* GreenMail runs with -Dgreenmail.auth.disabled, so this is accepted as-is
   and is not a credential to anything. */
const MAILBOX_PASSWORD = "greenmail-proving-ground-only";
const TRUSTED_AUTHSERV_ID = "mx.orbit-proving-ground.test";
/* The only address a member can send from is their registered account email. */
const SENDER_ADDRESS = () => workerEmail("member");

const HOUSEHOLD = "Sender Check Proving Ground";
const households = householdRegister();
let seeded = false;

async function signInAsMember(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("member") }).click();
  await settleArrival(page);
}

/** Points the instance at the GreenMail sidecar through the real administrator API (#743). */
async function configureMailbox(page: Page) {
  const outcome = await page.evaluate(async ([account, password, authservId]) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const current = (await (await fetch("/api/admin/mailbox", { credentials: "same-origin" })).json()) as { mailbox?: { version?: number | null } | null };
    const response = await fetch("/api/admin/mailbox", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        action: "set",
        expectedVersion: current.mailbox?.version ?? null,
        host: "orbit-greenmail",
        port: 3993,
        accountUser: account,
        mailbox: "INBOX",
        tlsServerName: "orbit-greenmail",
        providerProfile: "other",
        trustedRecipientHeader: "X-Orbit-Delivered-To",
        trustedAuthservId: authservId,
        pollSeconds: 30,
        password,
      }),
    });
    if (!response.ok) throw new Error(`mailbox set failed: ${response.status}`);
    return ((await response.json()) as { outcome?: string }).outcome ?? "";
  }, [MAILBOX_ACCOUNT, MAILBOX_PASSWORD, TRUSTED_AUTHSERV_ID]);
  expect(outcome, "the administrator API must verify the GreenMail mailbox before committing it").toBe("verified");
}

async function establishInstanceAdmin(browser: Browser) {
  await claimInstanceAsAdministrator(browser, {
    afterSignIn: async (page) => {
      await settleArrival(page);
      await configureMailbox(page);
    },
  });
}

/* A member with no household is bounced to "/" by the first-run door (#840),
   which would hide the screen under test; see #958 in the collection spec. */
async function seedHousehold(page: Page) {
  const created = await page.evaluate(async (householdName) => {
    const workspace = (await (await fetch("/api/workspace", { credentials: "same-origin" })).json()) as { workspace?: { households?: unknown[] } };
    if (workspace.workspace?.households?.length) return null;
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status}`);
    return { id: householdId, name: householdName };
  }, HOUSEHOLD);
  if (created) {
    households.track(created);
    seeded = true;
  }
}

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await answerPushWithoutAService(page);
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: workerAccount("administrator") }).click();
    await ensureWorkerAdministrator(page);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("a member sends the check email from the settings mail screen, opens the link, and the relay starts listening", async ({ page, browser }) => {
  test.setTimeout(240_000);

  await establishInstanceAdmin(browser);
  await signInAsMember(page);
  await seedHousehold(page);

  const address = SENDER_ADDRESS();
  const mark = await newestSenderCheckUid(address);

  await page.goto("/settings/mail");
  const senderRow = page.locator(".kv, .rl-field").filter({ hasText: "sender check" });
  await expect(page.locator(".kv, .rl-field").filter({ hasText: "sending from" })).toContainText(address);
  await expect(senderRow).toContainText("not yet checked");

  // One press of the one button.
  await page.getByRole("button", { name: "send the check email", exact: true }).click();
  await expect(page.getByRole("button", { name: "send it again", exact: true })).toBeVisible();
  await expect(senderRow).toContainText("email sent · link lapses");

  // The test mailbox received one email, to the registered address.
  const link = new URL(await waitForSenderCheckLink(address, mark));
  expect(await countSenderCheckMails(address, mark), "one press is one email").toBe(1);

  // Opening the link signed in lands on ?sender=verified (the redirect is the
  // route's answer; the screen then removes the parameter from the address bar).
  const landed = page.waitForResponse((response) => response.url().includes("/api/settings/mail-relay/verify?"));
  await page.goto(`${link.pathname}${link.search}`);
  expect((await landed).headers().location ?? "").toContain("/settings/mail?sender=verified");

  await expect(page).toHaveURL(/\/settings\/mail$/u);
  await expect(page.getByText("address checked · your relay is listening")).toBeVisible();
  await expect(senderRow).toHaveText(/sender check\s*checked$/u);
  await expect(page.getByText("connected · listening")).toBeVisible();
  await expect(page.getByRole("button", { name: "send the check email", exact: true })).toHaveCount(0);

  // Pressing again is no longer on offer; the route agrees.
  const again = await page.request.post("/api/settings/mail-relay/verification", { headers: await sessionHeaders(page) });
  expect(again.status()).toBe(409);
});
