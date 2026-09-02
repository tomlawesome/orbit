import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
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
 * The alias derivation mirrors src/server/mail-in/core/imap-recipient.ts
 * exactly, keyed by the DISPOSABLE alias secret this stack runs with.
 */
const RECIPIENT_DOMAIN = "in.orbit.test";
const ALIAS_GENERATION = 1;
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

function deriveAlias(userId: string, secret: string): string {
  const input = `orbit:imap-recipient-alias:v1\0${RECIPIENT_DOMAIN}\0${ALIAS_GENERATION}\0${userId}`;
  const token = createHmac("sha256", secret).update(input, "utf8").digest("base64url");
  return `orbit+${token}@${RECIPIENT_DOMAIN}`;
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
  await context.close();
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

async function sessionUserId(page: Page): Promise<string> {
  const response = await page.request.get("/api/auth/session");
  const body = (await response.json()) as { user?: { id?: string } };
  if (!body.user?.id) throw new Error("no session user");
  return body.user.id;
}

async function sendMail(alias: string, subject: string, attachment: { filename: string; content: Buffer; contentType: string } | null) {
  const transport = createTransport({ host: "127.0.0.1", port: SMTP_PORT, secure: false, tls: { rejectUnauthorized: false } });
  await transport.sendMail({
    envelope: { from: "spoofer@outside.example", to: "orbit-intake@in.orbit.test" },
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

async function waitForReceipts(page: Page, count: number, timeoutMs = 120_000) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/imap-inbox");
        const body = (await response.json()) as { receipts?: unknown[] };
        return body.receipts?.length ?? 0;
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
  const userId = await sessionUserId(page);
  const secret = readFileSync(".orbit-secrets/imap-alias-current-secret", "utf8").trim();
  const alias = deriveAlias(userId, secret);

  await sendMail(alias, "Boiler cover renewal", {
    filename: "spoofed-policy.pdf",
    content: TINY_PDF,
    contentType: "application/pdf",
  });

  // Orbit polls every 30s: the receipt appears without any interception.
  await waitForReceipts(page, 1);

  // The suggestion is on home, from the real pipe.
  await page.goto("/home");
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
  const userId = await sessionUserId(page);
  const secret = readFileSync(".orbit-secrets/imap-alias-current-secret", "utf8").trim();
  const alias = deriveAlias(userId, secret);

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
  const inbox = (await (await page.request.get("/api/imap-inbox")).json()) as {
    receipts: Array<{ canApprove: boolean; classification: string; message: string }>;
  };
  const receipt = inbox.receipts[0];
  expect(receipt.message.length).toBeGreaterThan(0);
  if (!receipt.canApprove && receipt.classification !== "waiting") {
    await page.goto("/settings/mail");
    await expect(page.locator(".failures")).toContainText("arrived, but could not be read");
  }
});
