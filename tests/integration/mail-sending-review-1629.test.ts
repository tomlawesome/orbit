/**
 * #1629 review findings on app-managed outgoing mail (ADR-0017 amendment
 * "outgoing mail is app-managed too": "From then on the SMTP_* values are
 * ignored"). Written before the fixes; the behaviour each case pins was
 * decided by the orchestrator from the spec:
 *
 *  2. The import is no stricter than what sent mail before the upgrade: a set
 *     the old code sent with imports, and sends as the old code did (the
 *     verbatim SMTP_FROM, or its default "Orbit <orbit@localhost>").
 *  3. An import that cannot run (key unreadable, or a set the old code could
 *     not have sent with either) is exposed on the operations snapshot as
 *     `mailSending.importSkipped: { reason }` beside `mailSending.source`.
 *  4. Receipt and review-ready mails are held, not cancelled, while sending is
 *     not set up or its password cannot be opened: no attempt is spent, and
 *     they go out once sending is set.
 *  5. An imported row edited from the screen keeps a lasting marker:
 *     `mailSending.importedFromEnvironment` stays true once source is `ui`.
 *
 * Plus the reviewer's gaps: a stale expectedVersion is refused; switching to
 * the mailbox account deletes the old password; a half-written SMTP_* set
 * next to a sending row changes nothing.
 *
 * Only nodemailer's `createTransport` is stood in for. All hosts are
 * `.example` or `.invalid`; every password is obviously fake.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  dueEvents,
  imapIngestionMessages,
  imapNotificationDeliveries,
  mailInSecrets,
  memberships,
  notificationDeliveries,
  reminderRules,
} from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture, lockTheInstance, type IntegrationFixture } from "./support/fixtures";
import {
  RELAY_PASSWORD,
  anotherAccount,
  clearMailState,
  fakeTransporter,
  mailboxInput,
  sending,
  targetOf,
  viaMailbox,
} from "./support/mail-sending-1629";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nodemailer")>();
  const replaced = { ...actual, createTransport: mocks.createTransport };
  return { ...replaced, default: { ...actual.default, createTransport: mocks.createTransport } };
});

const { sendBoundedMail } = await import("@/server/invitations/send");
const { runNotificationCycle } = await import("@/server/notification-worker");
const { runImapReceiptCycle } = await import("@/server/mail-in/imap-receipt-worker");
const { getAdministratorOperations } = await import("@/server/admin-operations");
const { setMailboxSettings } = await import("@/server/mail-in/mailbox-settings");

const LEGACY_PASSWORD = "fake-legacy-smtp-pass-review";
const cycleTime = new Date("2026-03-29T08:00:00.000Z");

type MailSendingSnapshot = { source?: unknown; importSkipped?: unknown; importedFromEnvironment?: unknown };

let fixture: IntegrationFixture;
let admin: string;
let secretDir: string;
let sent: Array<{ target: ReturnType<typeof targetOf>; message: Record<string, unknown> }>;

/** `.env-orbit` and the mail overlay as a v0.3.3 install had them; `undefined` removes a line. */
function stubV033Environment(overrides: Record<string, string | undefined> = {}) {
  const passwordFile = path.join(secretDir, "orbit-smtp-password");
  writeFileSync(passwordFile, `${LEGACY_PASSWORD}\n`, { mode: 0o600 });
  const values: Record<string, string | undefined> = {
    SMTP_HOST: "smtp.legacy.example",
    SMTP_PORT: "587",
    SMTP_SECURITY: "starttls",
    SMTP_USER: "orbit@legacy.example",
    SMTP_PASSWORD_FILE: passwordFile,
    SMTP_FROM: "Orbit <orbit@legacy.example>",
    ...overrides,
  };
  vi.stubEnv("SMTP_PASSWORD", undefined as unknown as string);
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value as string);
}

async function mailSendingSnapshot(): Promise<MailSendingSnapshot | undefined> {
  const operations = await getAdministratorOperations(admin) as { mailSending?: MailSendingSnapshot };
  return operations.mailSending;
}

beforeEach(async () => {
  fixture = await createIntegrationFixture("mail-review-1629");
  admin = fixture.users.admin.id;
  secretDir = mkdtempSync(path.join(tmpdir(), "orbit-1629-review-"));
  sent = [];
  vi.stubEnv("VAPID_SUBJECT", "");
  vi.stubEnv("VAPID_PUBLIC_KEY", "");
  vi.stubEnv("VAPID_PRIVATE_KEY", "");
  vi.stubEnv("APP_URL", "https://orbit.invalid.example");
  mocks.createTransport.mockReset();
  mocks.createTransport.mockImplementation((argument: unknown) => {
    const base = fakeTransporter();
    return {
      ...base,
      sendMail: vi.fn(async (message: Record<string, unknown>) => {
        sent.push({ target: targetOf(argument), message });
        return base.sendMail(message);
      }),
    };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  rmSync(secretDir, { recursive: true, force: true });
  await getDb().delete(imapNotificationDeliveries);
  await getDb().delete(imapIngestionMessages);
  await clearMailState();
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("the import is no stricter than what sent mail before the upgrade (finding 2)", () => {
  it("imports a user that is not an address with no SMTP_FROM, and sends as the old default, Orbit <orbit@localhost>", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment({ SMTP_USER: "apikey", SMTP_FROM: undefined });

    await importSendingFromEnvironment();

    expect(await readSendingSettings(admin)).toMatchObject({ configured: true, source: "imported", user: "apikey" });
    const outcome = await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });
    expect(outcome.sendError).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toMatchObject({ host: "smtp.legacy.example", user: "apikey", pass: LEGACY_PASSWORD });
    expect(sent[0].message).toMatchObject({ from: "Orbit <orbit@localhost>" });
  });

  it("imports a host with an underscore in it, and sends through it", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment({ SMTP_HOST: "smtp_relay.legacy.example" });

    await importSendingFromEnvironment();

    expect(await readSendingSettings(admin)).toMatchObject({ configured: true, source: "imported", host: "smtp_relay.legacy.example" });
    await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });
    expect(sent[0]?.target).toMatchObject({ host: "smtp_relay.legacy.example" });
  });

  it("imports a non-standard port, and sends on it", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment({ SMTP_PORT: "2525" });

    await importSendingFromEnvironment();

    expect(await readSendingSettings(admin)).toMatchObject({ configured: true, source: "imported", port: 2525 });
    await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });
    expect(sent[0]?.target).toMatchObject({ host: "smtp.legacy.example", port: 2525 });
  });

  it("keeps a display name with a comma in it, and sends as SMTP_FROM said", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    const from = "\"Harlow, Ned\" <orbit@harlow.example>";
    stubV033Environment({ SMTP_FROM: from });

    await importSendingFromEnvironment();

    expect(await readSendingSettings(admin)).toMatchObject({ source: "imported", senderName: "Harlow, Ned", senderAddress: "orbit@harlow.example" });
    await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });
    expect(sent[0]?.message).toMatchObject({ from });
  });
});

describe("an import that could not run is on the operations snapshot (finding 3)", () => {
  it("reports importSkipped with reason key_unavailable while the key cannot be read, and nothing once it imports", async () => {
    const { importSendingFromEnvironment } = await sending();
    stubV033Environment();

    const restore = lockTheInstance();
    try {
      await importSendingFromEnvironment();
    } finally {
      restore();
    }

    const skipped = await mailSendingSnapshot();
    expect(skipped).toMatchObject({ source: null, importSkipped: { reason: "key_unavailable" } });
    expect(JSON.stringify(skipped)).not.toContain(LEGACY_PASSWORD);

    await importSendingFromEnvironment();
    expect(await mailSendingSnapshot()).toMatchObject({ source: "imported", importSkipped: null });
  });

  it("reports importSkipped with reason lines_unusable for a set the old code could not send with either (port 70000)", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment({ SMTP_PORT: "70000" });

    await importSendingFromEnvironment();

    expect((await readSendingSettings(admin)).configured).toBe(false);
    expect(await mailSendingSnapshot()).toMatchObject({ source: null, importSkipped: { reason: "lines_unusable" } });
  });

  it("reports importSkipped: null when there are no SMTP lines at all", async () => {
    const { importSendingFromEnvironment } = await sending();
    for (const name of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PASSWORD_FILE", "SMTP_FROM"]) {
      vi.stubEnv(name, undefined as unknown as string);
    }

    await importSendingFromEnvironment();

    const snapshot = await mailSendingSnapshot();
    expect(snapshot).toHaveProperty("importSkipped", null);
  });
});

describe("an imported row edited from the screen stays marked as imported (finding 5)", () => {
  it("reports importedFromEnvironment: true after the edit, though source is now ui", async () => {
    const { importSendingFromEnvironment, readSendingSettings, setSendingSettings } = await sending();
    stubV033Environment();
    await importSendingFromEnvironment();
    const imported = await readSendingSettings(admin);
    expect(await mailSendingSnapshot()).toMatchObject({ source: "imported", importedFromEnvironment: true });

    await setSendingSettings(admin, imported.version, anotherAccount);

    expect(await mailSendingSnapshot()).toMatchObject({ source: "ui", importedFromEnvironment: true });
  });

  it("reports importedFromEnvironment: false on an install that never imported, before and after setting sending", async () => {
    const { setSendingSettings } = await sending();
    expect(await mailSendingSnapshot()).toHaveProperty("importedFromEnvironment", false);

    await setSendingSettings(admin, null, anotherAccount);

    expect(await mailSendingSnapshot()).toMatchObject({ source: "ui", importedFromEnvironment: false });
  });
});

describe("receipt and review-ready mails wait for sending (finding 4)", () => {
  it("holds both, spending no attempt, while sending is not set up, and sends them once it is", async () => {
    const { setSendingSettings } = await sending();
    const ids = await seedImapNotifications(fixture);

    await runImapReceiptCycle();

    const held = await imapDeliveries(ids);
    expect(held.map((row) => row.status)).toEqual(["retry", "retry"]);
    expect(held.map((row) => row.attempts)).toEqual([0, 0]);
    expect(sent).toEqual([]);

    await setSendingSettings(admin, null, anotherAccount);
    await getDb().update(imapNotificationDeliveries).set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(inArray(imapNotificationDeliveries.id, ids));
    await runImapReceiptCycle();

    expect((await imapDeliveries(ids)).map((row) => row.status)).toEqual(["sent", "sent"]);
    expect(sent).toHaveLength(2);
    expect(sent[0].target).toMatchObject({ host: "smtp.relay.example", pass: RELAY_PASSWORD });
  });

  it("holds both, spending no attempt, while the sending password cannot be opened", async () => {
    const { setSendingSettings } = await sending();
    await setSendingSettings(admin, null, anotherAccount);
    /* A stored password that no longer authenticates: the key cannot open it. */
    await getDb().execute(sql`update mail_in_secrets set ciphertext = decode('00', 'hex') || ciphertext where kind = 'smtp_password'`);
    const ids = await seedImapNotifications(fixture);

    await runImapReceiptCycle();

    const held = await imapDeliveries(ids);
    expect(held.map((row) => row.status)).toEqual(["retry", "retry"]);
    expect(held.map((row) => row.attempts)).toEqual([0, 0]);
    expect(sent).toEqual([]);
  });
});

describe("the reviewer's gaps", () => {
  it("refuses an update made with a stale expectedVersion, with a conflict, and changes nothing", async () => {
    const { readSendingSettings, setSendingSettings } = await sending();
    await setSendingSettings(admin, null, anotherAccount);
    const first = await readSendingSettings(admin);
    await setSendingSettings(admin, first.version, { ...anotherAccount, senderName: "Orbit Two" });
    const current = await readSendingSettings(admin);

    await expect(setSendingSettings(admin, first.version, { ...anotherAccount, senderName: "Orbit Stale" }))
      .rejects.toMatchObject({ code: "sending_version_conflict", status: 409 });

    expect(await readSendingSettings(admin)).toEqual(current);
  });

  it("deletes the old account's password when sending switches to the mailbox account", async () => {
    const { setSendingSettings, readSendingSettings } = await sending();
    await setMailboxSettings(admin, null, mailboxInput, { verifyImap: async () => "ready" });
    await setSendingSettings(admin, null, anotherAccount);
    expect(await sendingPasswords()).toHaveLength(1);

    const { version } = await readSendingSettings(admin);
    await setSendingSettings(admin, version, viaMailbox);

    expect(await sendingPasswords()).toEqual([]);
    expect((await readSendingSettings(admin)).password).toBe("mailbox");
  });

  it("changes nothing when a half-written SMTP_* set sits next to a sending row: the row sends reminders and mail", async () => {
    const { importSendingFromEnvironment, readSendingSettings, setSendingSettings } = await sending();
    await setSendingSettings(admin, null, anotherAccount);
    const before = await readSendingSettings(admin);
    vi.stubEnv("SMTP_PASSWORD", undefined as unknown as string);
    vi.stubEnv("SMTP_PASSWORD_FILE", undefined as unknown as string);
    vi.stubEnv("SMTP_HOST", "smtp.half-written.example");
    vi.stubEnv("SMTP_USER", "orbit@half-written.example");

    await importSendingFromEnvironment();
    expect(await readSendingSettings(admin)).toEqual(before);

    const eventId = await seedReminder(fixture);
    await runNotificationCycle(undefined, { now: () => cycleTime });
    const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
    expect(delivery?.status).toBe("sent");

    const outcome = await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });
    expect(outcome.sendError).toBeNull();
    expect(sent).toHaveLength(2);
    for (const { target } of sent) expect(target).toMatchObject({ host: "smtp.relay.example", user: "relay-user" });
  });
});

async function sendingPasswords() {
  return getDb().select({ id: mailInSecrets.id }).from(mailInSecrets).where(eq(mailInSecrets.kind, "smtp_password"));
}

/** One message in review for the member, with its receipt and its review-ready mail waiting. */
async function seedImapNotifications(target: IntegrationFixture): Promise<string[]> {
  const [message] = await getDb().insert(imapIngestionMessages).values({
    mailbox: "private", mailboxUidValidity: "review-1629", mailboxUid: 1629,
    contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "review-1629",
    userId: target.users.member.id, householdId: target.household.id, status: "pending_review",
    expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
  }).returning({ id: imapIngestionMessages.id });
  const rows = await getDb().insert(imapNotificationDeliveries).values([
    { messageId: message.id, userId: target.users.member.id, kind: "receipt" as const },
    { messageId: message.id, userId: target.users.member.id, kind: "review_ready" as const },
  ]).returning({ id: imapNotificationDeliveries.id });
  return rows.map((row) => row.id);
}

async function imapDeliveries(ids: string[]) {
  const rows = await getDb().select({
    id: imapNotificationDeliveries.id,
    kind: imapNotificationDeliveries.kind,
    status: imapNotificationDeliveries.status,
    attempts: imapNotificationDeliveries.attempts,
  }).from(imapNotificationDeliveries).where(inArray(imapNotificationDeliveries.id, ids));
  return rows.sort((a, b) => a.kind.localeCompare(b.kind));
}

/** One email reminder due now for the household's owner alone (the worker suite's shape). */
async function seedReminder(target: IntegrationFixture): Promise<string> {
  const db = getDb();
  await db.delete(memberships).where(and(
    eq(memberships.householdId, target.household.id),
    eq(memberships.userId, target.users.member.id),
  ));
  const [event] = await db.insert(dueEvents).values({
    householdId: target.household.id,
    itemId: target.item.id,
    kind: "renewal",
    dueDate: "2026-03-29",
  }).returning({ id: dueEvents.id });
  await db.insert(reminderRules).values({ itemId: target.item.id, daysBefore: 0, emailEnabled: true, pushEnabled: false });
  return event.id;
}
