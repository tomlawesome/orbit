import { expect, test, type Browser, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { INTAKE_MAILBOX, countSenderCheckMails, newestSenderCheckUid, waitForSenderCheckLink } from "./support/mail";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { configureMailbox as configureSharedMailbox } from "./support/mailbox";
import { ensureWorkerAdministrator, workerAccount, workerEmail, type WorkerRole } from "./support/worker-identity";
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
/* The only address a member can send from is their registered account email.
   The worker's `member` is tried first; one an earlier run (or the collection
   spec) already checked cannot show the button, so the worker's `outsider` --
   also an ordinary, non-administrator account with its own mailbox -- stands
   in. Nothing else about the journey differs. */
const CANDIDATE_ROLES: WorkerRole[] = ["member", "outsider"];

const HOUSEHOLD = "Sender Check Proving Ground";
const households = householdRegister();
let seeded = false;

async function signInAs(page: Page, role: WorkerRole) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount(role) }).click();
  await settleArrival(page);
}

/** Signs in as the first candidate whose sending address is still unchecked. */
async function signInAsUncheckedMember(page: Page): Promise<WorkerRole> {
  for (const role of CANDIDATE_ROLES) {
    await page.context().clearCookies();
    await signInAs(page, role);
    const body = (await (await page.request.get("/api/settings/mail-relay")).json()) as { relay?: { sender?: { verified?: boolean } | null } };
    if (body.relay?.sender && !body.relay.sender.verified) return role;
  }
  throw new Error(`#1410: no unchecked member among ${CANDIDATE_ROLES.join(", ")} for this worker`);
}

/** Points the instance at the GreenMail sidecar; tolerant of a parallel spec doing the same (#1417). */
async function configureMailbox(page: Page) {
  await configureSharedMailbox(page, { account: MAILBOX_ACCOUNT, password: MAILBOX_PASSWORD, authservId: TRUSTED_AUTHSERV_ID });
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
  const role = await signInAsUncheckedMember(page);
  await seedHousehold(page);

  const address = workerEmail(role);
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
  await expect(
    page.locator(".kv, .rl-field").filter({ has: page.getByText("status", { exact: true }) }),
  ).toContainText("connected · listening");
  await expect(page.getByRole("button", { name: "send the check email", exact: true })).toHaveCount(0);

  // Pressing again is no longer on offer; the route agrees.
  const again = await page.request.post("/api/settings/mail-relay/verification", { headers: await sessionHeaders(page) });
  expect(again.status()).toBe(409);
});
