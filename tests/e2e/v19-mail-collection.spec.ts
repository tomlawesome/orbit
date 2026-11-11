import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTransport } from "nodemailer";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { INTAKE_MAILBOX, newestSenderCheckUid, waitForSenderCheckLink } from "./support/mail";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { configureMailbox as configureSharedMailbox } from "./support/mailbox";
import { workerAccount, workerEmail } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { signIn } from "./support/signed-in";
import { signMessage, type TestKey } from "../support/dkim-signing";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

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
 *
 * Since ADR-0017 slice 4 (#745), landing on the alias is not enough either:
 * THE SENDER ATTRIBUTES, THE ALIAS CORROBORATES. A message from an address
 * nobody has verified is unattributed, deleted, and never reaches the review
 * lane -- so this spec claims a sending address as the member, proves it
 * through the real one-use-link Orbit mails back (read out of GreenMail, not
 * trusted in-process), and DKIM-signs the forward as the sender's domain.
 *
 * #1681: no `Authentication-Results` header and no trusted authserv-id. Orbit
 * verifies the signature itself, fetching the key through real DNS: the
 * stack's `orbit-dkim-dns` stand-in, which MAIL_IN_DKIM_DNS_SERVERS points the
 * lookup at, publishes the public half of the per-stack key whose private half
 * signs here. The last test proves the converse end to end: the same message
 * unsigned, carrying a forged `Authentication-Results: ...; dmarc=pass`, is
 * not attributed.
 */
const MAILBOX_ACCOUNT = INTAKE_MAILBOX;
/* GreenMail runs with -Dgreenmail.auth.disabled, so this is accepted as-is
   and is not a credential to anything. */
const MAILBOX_PASSWORD = "greenmail-proving-ground-only";
// Must match compose/docker-compose.acceptance.yml's GreenMail host-port binding
// exactly -- both read TEST_SMTP_PORT so the test and the compose
// host-binding can never diverge. Defaults to 3025 (CI's fixed value).
const SMTP_PORT = Number(process.env.TEST_SMTP_PORT ?? 3025);

/* #745, ADR-0017 decision 7c: the only address a member can send from is
   their registered account email, so that is the sender -- this worker's
   member, whose mail also lands in GreenMail (see support/worker-identity.ts),
   which is where the check email is read from. */
const SENDER_ADDRESS = () => workerEmail("member");
const SENDER_DOMAIN = () => SENDER_ADDRESS().slice(SENDER_ADDRESS().indexOf("@") + 1);

/* #1681: the per-stack DKIM key the stack scripts generate (never committed)
   and the selector the orbit-dkim-dns stand-in publishes its record under.
   Both can be overridden by environment for a stack laid out differently;
   the defaults are what the acceptance overlay uses. Read from the
   repository root, as bootstrap-protection.spec.ts reads .orbit-secrets. */
const DKIM_KEY_FILE = process.env.TEST_DKIM_KEY_FILE ?? ".orbit-secrets/dkim-test-key.pem";
const DKIM_SELECTOR = process.env.TEST_DKIM_SELECTOR ?? "orbit-e2e";

function stackDkimKey(): TestKey {
  const privateKeyPem = readFileSync(DKIM_KEY_FILE, "utf8");
  const spki = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" });
  return { kind: "rsa", privateKeyPem, record: `v=DKIM1; k=rsa; p=${spki.toString("base64")}` };
}

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
  const response = await page.request.get("/api/settings/mail-relay", { maxRetries: 2 });
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
  await signIn(page, { account: workerAccount("member") });
  /* The first-run film is not this file's subject, so the member has already
     taken it: the same record "take the walk again" writes (web/tests/rig/v19-tour.spec.js
     puts it back to null when the walk IS the subject). Without it the film
     goes up on the member's first /home with a household, and whether its
     pill had appeared inside a fixed wait decided if the page under its veil
     was usable (#1415). Only when nothing is recorded, so a rerun keeps the
     first timestamp. */
  const walk = (await (await page.request.get("/api/settings/tour", { maxRetries: 2 })).json()) as { tour?: { tourSeenAt: string | null } };
  if (!walk.tour?.tourSeenAt) {
    const recorded = await page.request.put("/api/settings/tour", {
      headers: await sessionHeaders(page),
      data: { tourSeenAt: new Date().toISOString() },
    });
    expect(recorded.ok(), `the member's walk could not be recorded as taken (HTTP ${recorded.status()})`).toBe(true);
  }
}

// The administrator claims the instance and configures the mailbox, and the
// member below exercises the inbox, so the administrator takes the instance in
// a throwaway context and the member is an ordinary user. Since ADR-0022
// nobody is promoted by signing in: the instance is claimed with the code from the stack's own log, and the mailbox
// is configured on the administrator's own signed-in page.
async function establishInstanceAdmin(browser: Browser) {
  await claimInstanceAsAdministrator(browser, {
    afterSignIn: async (page) => {
      await settleArrival(page);
      await configureMailbox(page);
    },
  });
}

/**
 * Points the instance at the GreenMail sidecar through the real
 * administrator API (#743), which verifies the credential against the
 * provider before committing it. Tolerant of a parallel spec doing the same
 * (#1417): see support/mailbox.ts.
 */
async function configureMailbox(page: Page) {
  await configureSharedMailbox(page, { account: MAILBOX_ACCOUNT, password: MAILBOX_PASSWORD });
}

/**
 * Claims the signed-in member's registered address as their sender and proves
 * it through the real one-use link (ADR-0017 decision 7c, #745).
 *
 * The member asks for the check with `POST /api/settings/mail-relay/verification`
 * (no body: the registered address is the only candidate), the product mails
 * the link to that address, and it is read back out of the member's mailbox in
 * the disposable GreenMail sidecar and opened signed in as the member.
 * Idempotent: a re-run against a live stack finds the address already verified
 * (the route answers 409 `sender_already_verified`) and does nothing further,
 * the same accommodation `configureMailbox` above makes.
 */
async function verifySenderAddress(page: Page) {
  const mark = await newestSenderCheckUid(SENDER_ADDRESS());
  const asked = await page.request.post("/api/settings/mail-relay/verification", { headers: await sessionHeaders(page) });
  if (asked.status() === 409) return;
  if (asked.status() !== 202) throw new Error(`the sender check was not sent: ${asked.status()}`);

  const link = new URL(await waitForSenderCheckLink(SENDER_ADDRESS(), mark));
  const verified = await page.request.get(`${link.pathname}${link.search}`, { maxRetries: 2 });
  if (!verified.ok() || !verified.url().includes("sender=verified")) {
    throw new Error(`sender verification link did not confirm: ${verified.status()} ${verified.url()}`);
  }
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

type Attachment = { filename: string; content: Buffer; contentType: string };

/**
 * Sends a forward from the member to their relay address.
 *
 * `signed` (the default): the message is built, DKIM-signed with the stack's
 * key as the sender's domain, and sent byte for byte as signed.
 * `forgedAuthenticationResults`: the same message, unsigned, carrying an
 * `Authentication-Results` header that claims dmarc=pass for the sender's
 * domain -- what anyone can write into a message they send.
 *
 * The trusted recipient header is prepended after signing, as the receiving
 * provider GreenMail does not have would prepend it, and unfolded: nodemailer
 * folds lines over 78 chars and Orbit (rightly) quarantines a folded trusted
 * recipient header; real MTAs write it unfolded.
 */
async function sendMail(
  alias: string,
  subject: string,
  attachment: Attachment | null,
  mode: "signed" | "forgedAuthenticationResults" = "signed",
) {
  const composer = createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const built = await composer.sendMail({
    from: `Forwarding Member <${SENDER_ADDRESS()}>`,
    to: alias,
    subject,
    text: "A forwarded document for the proving ground.",
    ...(mode === "forgedAuthenticationResults"
      ? { headers: { "Authentication-Results": { prepared: true, value: `mx.forged.test; dmarc=pass header.from=${SENDER_DOMAIN()}` } } }
      : {}),
    attachments: attachment ? [attachment] : [],
  });
  const composed = (built.message as Buffer).toString("latin1");
  const message = mode === "signed"
    ? await signMessage(composed, { domain: SENDER_DOMAIN(), selector: DKIM_SELECTOR, key: stackDkimKey() })
    : Buffer.from(composed, "latin1");
  const raw = Buffer.concat([Buffer.from(`X-Orbit-Delivered-To: ${alias}\r\n`, "latin1"), message]);

  const transport = createTransport({ host: "127.0.0.1", port: SMTP_PORT, secure: false, tls: { rejectUnauthorized: false } });
  await transport.sendMail({ envelope: { from: SENDER_ADDRESS(), to: MAILBOX_ACCOUNT }, raw });
  transport.close();
}

type Receipt = { canApprove: boolean; classification: string; message: string; attachments?: Array<{ displayName: string }> };

/* review-state.ts's words for a sender_unsigned failure (#1681, note 52496). */
const SENDER_UNSIGNED_MESSAGE = "Orbit could not confirm this came from you, so it was not kept. Your mail service did not sign it (DKIM). Send it again from a service that signs, or ask whoever runs your mail domain to turn signing on.";

async function waitForReceipts(page: Page, count: number, timeoutMs = 120_000, of: (receipt: Receipt) => boolean = () => true) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/imap-inbox", { maxRetries: 2 });
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
    /* #1080: no URL wait -- signIn lands on the arrival or /home, whichever a
       fresh worker administrator belongs to, and holds administrator access:
       the sweep's hard delete is an instance-admin power. */
    await signIn(page);
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
  // #958: seed the household BEFORE verifying the sender address. Success
  // there follows a real one-use link, whose 303 lands on /settings --
  // a plain page route, not /api/*, so hooks.server.js's first-run door (#840)
  // applies to it. A member with zero households fails hasOnwardHousehold and
  // is bounced to "/" instead, which is indistinguishable here from a failed
  // verification: `sender=verified` never appears on the URL. Whether this
  // member already had a household depended on what else had run against the
  // shared instance first, which is exactly what made it flaky rather than
  // simply broken.
  await seedHousehold(page);
  await verifySenderAddress(page);
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
  /* The member has taken the first-run film (signInAsMember), so no veil
     stands over the row about to be pressed. Said by the read /home itself
     makes of the record (the film starts only when it comes back empty), not
     by asking whether a pill is up yet, which is true before the film mounts
     whether or not it is about to. */
  const filmRecord = page.waitForResponse(
    (response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/settings/tour",
    { timeout: 30_000 },
  );
  await page.goto("/home");
  const walkAsHomeReadIt = (await (await filmRecord).json()) as { tour?: { tourSeenAt: string | null } };
  expect(walkAsHomeReadIt.tour?.tourSeenAt, "home read the member's walk as already taken").toBeTruthy();
  const row = page.locator(".item.suggest").first();
  await expect(row).toBeVisible({ timeout: 30_000 });

  // The full serial suite shares this member with other specs, so the created
  // item is found by diffing the workspace around the approval, never by
  // position.
  const itemsOf = async () => {
    const workspace = (await (await page.request.get("/api/workspace", { maxRetries: 2 })).json()) as {
      workspace: { households: Array<{ id: string; items: Array<{ id: string; title: string; importance?: string | null }> }> };
    };
    return workspace.workspace.households.flatMap((household) =>
      household.items.map((item) => ({ ...item, householdId: household.id })));
  };
  const before = new Set((await itemsOf()).map((item) => item.id));

  // The decisions live in the drawer the row opens into (#1145).
  await row.click();
  const drawer = page.locator(".itemview.suggestview");
  await expect(drawer).toBeVisible();

  // The spoofed PDF proposes nothing, and a reviewed intake is an import: it
  // may leave the importance unset (#1463, workspace-repository.ts), so the
  // one-tap approval creates the item, where the retired type once held it.
  await drawer.getByRole("button", { name: "Add to orbit" }).click();
  await drawer.getByRole("button", { name: "tap again to approve" }).click();
  await expect(page.locator(".item.suggest")).toHaveCount(0, { timeout: 30_000 });
  // Home then says what the import left unset, and offers the one-time pass.
  await expect(page.getByText(/no importance yet/u).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });

  // The item is real workspace truth now, with its document attached.
  const created = (await itemsOf()).filter((item) => !before.has(item.id));
  expect(created.length).toBe(1);
  expect(created[0].importance ?? null, "an import leaves the importance unset").toBeNull();
  const documents = (await (
    await page.request.get(`/api/households/${created[0].householdId}/items/${created[0].id}/documents`, { maxRetries: 2 })
  ).json()) as { documents: Array<{ displayName: string }> };
  expect(documents.documents.length).toBeGreaterThanOrEqual(1);
});

test("a message with no readable document lands in a bounded state on the relay", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "relay assertion covered on desktop");
  test.setTimeout(240_000);

  await signInAsMember(page);
  await verifySenderAddress(page);
  const alias = await relayAddress(page);

  // A hostile claim: says PDF, is not one.
  await sendMail(alias, "Definitely a real invoice", {
    filename: "not-really.pdf",
    content: Buffer.from("<html>this is not a pdf</html>", "utf8"),
    contentType: "application/pdf",
  });

  // A2-Q8 (#1151): "waiting" (src/server/mail-in/core/review-state.ts) is
  // the one classification still in flight -- "Orbit is still preparing
  // this private review" -- so stopping at the first poll that merely
  // *found* the receipt let this test land on that transient state and skip
  // its only real assertion below without ever proving the hostile payload
  // actually bounces. Same override as the canApprove wait above: hold for
  // the classification to settle first.
  await waitForReceipts(page, 1, 120_000, (receipt) => receipt.classification !== "waiting");

  // Whatever bounded state it reached, the user can SEE that mail arrived:
  // either it is reviewable (a suggestion) or its failure is dated on the
  // relay in the server's own words — never silence.
  const inbox = (await (await page.request.get("/api/imap-inbox", { maxRetries: 2 })).json()) as { receipts: Receipt[] };
  const receipt = inbox.receipts[0];
  expect(receipt.message.length).toBeGreaterThan(0);
  expect(receipt.classification).not.toBe("waiting");
  if (!receipt.canApprove) {
    await page.goto("/settings#mail");
    await expect(page.locator(".failures")).toContainText("arrived, but could not be read");
  }
});

test("an unsigned forward with a forged Authentication-Results dmarc=pass is not attributed", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "covered on desktop");
  test.setTimeout(240_000);

  await signInAsMember(page);
  await verifySenderAddress(page);
  const alias = await relayAddress(page);
  const tag = `${Date.now().toString(36)}-${test.info().parallelIndex}`;
  const forgedName = `forged-${tag}.pdf`;
  const controlName = `signed-control-${tag}.pdf`;
  const named = (name: string) => (receipt: Receipt) =>
    (receipt.attachments ?? []).some((attachment) => attachment.displayName.includes(name.replace(/\.pdf$/u, "")));

  // The forgery first, then a signed control: the poller reads the mailbox in
  // arrival order, so once the control is a receipt the forgery has been
  // read too, and its absence is a verdict, not a poll that had not run yet.
  /* #1681, note 52496: the forgery is unsigned and its From is the member's
     verified address, so it is filed for the member as one content-free
     sender_unsigned failure. The row carries nothing of the message, so it is
     told apart by its words (review-state.ts), counted before and after. */
  const unsignedFailure = (receipt: Receipt) => receipt.classification === "unavailable"
    && !receipt.canApprove
    && receipt.message === SENDER_UNSIGNED_MESSAGE;
  const before = (await (await page.request.get("/api/imap-inbox", { maxRetries: 2 })).json()) as { receipts: Receipt[] };
  const unsignedBefore = before.receipts.filter(unsignedFailure).length;

  await sendMail(alias, "Forged attestation", { filename: forgedName, content: TINY_PDF, contentType: "application/pdf" }, "forgedAuthenticationResults");
  await sendMail(alias, "Signed control", { filename: controlName, content: TINY_PDF, contentType: "application/pdf" });

  await waitForReceipts(page, 1, 120_000, named(controlName));
  const inbox = (await (await page.request.get("/api/imap-inbox", { maxRetries: 2 })).json()) as { receipts: Receipt[] };
  expect(inbox.receipts.filter(named(controlName)), "the signed control is attributed to the member").toHaveLength(1);
  expect(inbox.receipts.filter(named(forgedName)), "the forged Authentication-Results attributed nothing").toHaveLength(0);
  expect(
    inbox.receipts.filter(unsignedFailure).length,
    "the forgery is exactly one sender_unsigned failure row in the member's failed list",
  ).toBe(unsignedBefore + 1);
  expect(
    inbox.receipts.filter(unsignedFailure).flatMap((receipt) => receipt.attachments ?? []),
    "the sender_unsigned row is content-free: no PDF, no name",
  ).toEqual([]);
});
