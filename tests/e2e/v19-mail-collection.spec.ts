import { createTransport } from "nodemailer";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";

/**
 * #459: the mail proving ground — no interception anywhere. A real message
 * with a real PDF is SMTP-delivered to the disposable GreenMail sidecar,
 * Orbit's IMAP poller collects it for real, and the suggestion is approved
 * through the v19 row. A malformed claim travels the same pipe into its
 * bounded failure state, visible on the relay.
 *
 * Since ADR-0017 slice 2 (#743) the mailbox is not container configuration:
 * an instance administrator sets it through /api/admin/mailbox and Orbit
 * stores it encrypted, generating the alias key itself. So this spec now
 * configures the mailbox as the administrator before sending anything, and
 * asks the app for the member's own relay address rather than deriving it
 * from a secret it used to be handed. Nothing here knows a mailbox password
 * beyond the throwaway one it sets, and nothing knows the alias key at all.
 */
const MAILBOX_ACCOUNT = "orbit-intake@in.orbit.test";
/* GreenMail runs with -Dgreenmail.auth.disabled, so this is accepted as-is
   and is not a credential to anything. */
const MAILBOX_PASSWORD = "greenmail-proving-ground-only";
// Must match docker-compose.acceptance.yml's GreenMail host-port binding
// exactly -- both read TEST_SMTP_PORT so the test and the compose
// host-binding can never diverge. Defaults to 3025 (CI's fixed value).
const SMTP_PORT = Number(process.env.TEST_SMTP_PORT ?? 3025);

/* #730: the proving ground this file seeds (only when the member has none) is
   removed once both journeys are done — the second one still needs it. The
   sweep runs from the administrator's session, because a hard delete is an
   instance-admin power and the owner here is an ordinary member. */
const HOUSEHOLD = "Collection Proving Ground";
const households = householdRegister();
let seeded = false;

/**
 * The member's own relay address, from the app rather than from a secret.
 *
 * There is no other way to get it now, and that is the point: the alias key
 * lives encrypted in the database and no read path returns it, so the only
 * holder of an address is the member whose address it is.
 */
async function relayAddress(page: Page): Promise<string> {
  const response = await page.request.get("/api/settings/mail-relay");
  const body = (await response.json()) as { relay?: { address?: string } };
  if (!body.relay?.address) throw new Error("the member has no relay address");
  return body.relay.address;
}

const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n" +
    "trailer<</Size 4/Root 1 0 R>>\nstartxref\n164\n%%EOF\n",
  "utf8",
);

async function signInAsMember(page: Page) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Member" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

// A fresh instance promotes its first sign-in to instance admin, and admins
// have an empty relay inbox by design. Claim that promotion for the
// administrator in a throwaway context so the member below is an ordinary
// user with a real inbox.
async function establishInstanceAdmin(browser: Browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await configureMailbox(page);
  await context.close();
}

/**
 * Points the instance at the GreenMail sidecar through the real
 * administrator API (#743), which verifies the credential against the
 * provider before committing it. Idempotent: it reads the current version
 * first, so re-running the suite against a live stack re-sets the same
 * mailbox rather than failing on a version conflict.
 */
async function configureMailbox(page: Page) {
  const outcome = await page.evaluate(async ([account, password]) => {
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
        /* The floor the settings schema allows; the poll loop follows it, so
           a receipt appears within seconds rather than a minute. */
        pollSeconds: 30,
        password,
      }),
    });
    if (!response.ok) throw new Error(`mailbox set failed: ${response.status}`);
    return ((await response.json()) as { outcome?: string }).outcome ?? "";
  }, [MAILBOX_ACCOUNT, MAILBOX_PASSWORD]);
  /* A refusal here is the provider check doing its job, and every assertion
     below would fail for a reason that named the wrong thing. */
  expect(outcome, "the administrator API must verify the GreenMail mailbox before committing it").toBe("verified");
}


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
  /* Nothing to sweep when the member already had a system: this spec did not
     make it, so this spec does not remove it. */
  if (created) {
    households.track(created);
    seeded = true;
  }
}

async function sendMail(alias: string, subject: string, attachment: { filename: string; content: Buffer; contentType: string } | null) {
  const transport = createTransport({ host: "127.0.0.1", port: SMTP_PORT, secure: false, tls: { rejectUnauthorized: false } });
  await transport.sendMail({
    envelope: { from: "spoofer@outside.example", to: MAILBOX_ACCOUNT },
    from: "Spoofed Sender <spoofer@outside.example>",
    to: alias,
    subject,
    text: "A forwarded document for the proving ground.",
    // prepared: nodemailer folds lines over 78 chars and Orbit (rightly)
    // quarantines a folded trusted-recipient header; real MTAs write it unfolded.
    headers: { "X-Orbit-Delivered-To": { prepared: true, value: alias } },
    attachments: attachment ? [attachment] : [],
  });
  transport.close();
}

type Receipt = { canApprove: boolean; classification: string; message: string };

async function waitForReceipts(page: Page, count: number, timeoutMs = 120_000, of: (receipt: Receipt) => boolean = () => true) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/imap-inbox");
        const body = (await response.json()) as { receipts?: Receipt[] };
        return (body.receipts ?? []).filter(of).length;
      },
      { timeout: timeoutMs, intervals: [5_000] },
    )
    .toBeGreaterThanOrEqual(count);
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: "Orbit Administrator" }).click();
    await expect(page).toHaveURL(/\/home$/);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("a spoofed PDF travels the real pipe: SMTP → IMAP → suggestion → item", async ({ page, browser }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket has no suggestion rows yet (#434 follow-up)");
  test.setTimeout(240_000);

  await establishInstanceAdmin(browser);
  await signInAsMember(page);
  await seedHousehold(page);
  const alias = await relayAddress(page);

  await sendMail(alias, "Boiler cover renewal", {
    filename: "spoofed-policy.pdf",
    content: TINY_PDF,
    contentType: "application/pdf",
  });

  // Orbit polls every 30s: the receipt appears without any interception.
  // Home reads the inbox once on arrival and only an approvable receipt is a
  // suggestion row, so wait until the server has finished reading the mail —
  // a receipt still "waiting" renders nothing on home (seen locally, 2026-09-06).
  await waitForReceipts(page, 1, 120_000, (receipt) => receipt.canApprove);

  // The suggestion is on home, from the real pipe.
  await page.goto("/home");
  /* The member's first landing on a fresh stack gets the first-run tour,
     and the dimmed page behind it is inert (#844) — a reader has to skip
     the walk before tapping anything, so this test does too. */
  const tour = page.locator(".tourcard");
  if (await tour.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) {
    await page.locator("#tour-skip").click();
    await expect(tour).toHaveCount(0);
  }
  const row = page.locator(".item.suggest").first();
  await expect(row).toBeVisible({ timeout: 30_000 });

  // The full serial suite shares this member with other specs, so the created
  // item is found by diffing the workspace around the approval, never by
  // position.
  const itemsOf = async () => {
    const workspace = (await (await page.request.get("/api/workspace")).json()) as {
      workspace: { households: Array<{ id: string; items: Array<{ id: string; title: string }> }> };
    };
    return workspace.workspace.households.flatMap((household) =>
      household.items.map((item) => ({ ...item, householdId: household.id })));
  };
  const before = new Set((await itemsOf()).map((item) => item.id));

  // Two taps approve it for real: item created, document transferred.
  await row.getByRole("button", { name: "Add to orbit" }).click();
  await row.getByRole("button", { name: "tap again to approve" }).click();
  await expect(page.locator(".item.suggest")).toHaveCount(0, { timeout: 30_000 });

  // The item is real workspace truth now, with its document attached.
  const created = (await itemsOf()).filter((item) => !before.has(item.id));
  expect(created.length).toBe(1);
  const documents = (await (
    await page.request.get(`/api/households/${created[0].householdId}/items/${created[0].id}/documents`)
  ).json()) as { documents: Array<{ displayName: string }> };
  expect(documents.documents.length).toBeGreaterThanOrEqual(1);
});

test("a message with no readable document lands in a bounded state on the relay", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "relay assertion covered on desktop");
  test.setTimeout(240_000);

  await signInAsMember(page);
  const alias = await relayAddress(page);

  // A hostile claim: says PDF, is not one.
  await sendMail(alias, "Definitely a real invoice", {
    filename: "not-really.pdf",
    content: Buffer.from("<html>this is not a pdf</html>", "utf8"),
    contentType: "application/pdf",
  });

  await waitForReceipts(page, 1);

  // Whatever bounded state it reached, the user can SEE that mail arrived:
  // either it is reviewable (a suggestion) or its failure is dated on the
  // relay in the server's own words — never silence.
  const inbox = (await (await page.request.get("/api/imap-inbox")).json()) as { receipts: Receipt[] };
  const receipt = inbox.receipts[0];
  expect(receipt.message.length).toBeGreaterThan(0);
  if (!receipt.canApprove && receipt.classification !== "waiting") {
    await page.goto("/settings/mail");
    await expect(page.locator(".failures")).toContainText("arrived, but could not be read");
  }
});
