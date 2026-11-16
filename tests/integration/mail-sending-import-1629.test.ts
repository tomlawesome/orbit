/**
 * #1629: an install upgraded from v0.3.3 with `SMTP_*` in `.env-orbit` keeps
 * sending with no operator step (design note 54742, "Import"; ADR-0017
 * amendment). Against a real PostgreSQL; only nodemailer's `createTransport`
 * is stood in for.
 *
 * The environment is shaped the way v0.3.3 deployed it: `SMTP_HOST`,
 * `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_FROM` in `.env-orbit`, and
 * the password file-backed through `docker-compose.mail.yml`
 * (`SMTP_PASSWORD_FILE` pointing at the mounted secret), never a direct
 * `SMTP_PASSWORD`.
 *
 * `importSendingFromEnvironment()` is the tests' name for the start-up step;
 * it reads `process.env` as boot would.
 *
 * Reading chosen where the note is silent: with no sending row, a reminder
 * stays queued (status `retry` or `pending`, provider never called), as one
 * does today when the server is unavailable, and goes out on a later cycle
 * once sending is set; it is not cancelled the way today's
 * `smtp_unconfigured` is.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { dueEvents, memberships, notificationDeliveries, reminderRules } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture, lockTheInstance, type IntegrationFixture } from "./support/fixtures";
import {
  RELAY_PASSWORD,
  anotherAccount,
  clearMailState,
  encryptedRowCount,
  fakeTransporter,
  plaintextHits,
  sending,
  targetOf,
} from "./support/mail-sending-1629";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nodemailer")>();
  const replaced = { ...actual, createTransport: mocks.createTransport };
  return { ...replaced, default: { ...actual.default, createTransport: mocks.createTransport } };
});

const { sendBoundedMail } = await import("@/server/invitations/send");
const { runNotificationCycle } = await import("@/server/notification-worker");
const { getAdministratorOperations } = await import("@/server/admin-operations");

const LEGACY_PASSWORD = "fake-legacy-smtp-pass-1629";
const cycleTime = new Date("2026-03-29T08:00:00.000Z");

let fixture: IntegrationFixture;
let admin: string;
let secretDir: string;
let sent: Array<{ target: ReturnType<typeof targetOf>; message: Record<string, unknown> }>;

/** `.env-orbit` and the mail overlay as a v0.3.3 install had them. */
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

beforeEach(async () => {
  fixture = await createIntegrationFixture("mail-import-1629");
  admin = fixture.users.admin.id;
  secretDir = mkdtempSync(path.join(tmpdir(), "orbit-1629-"));
  sent = [];
  vi.stubEnv("VAPID_SUBJECT", "");
  vi.stubEnv("VAPID_PUBLIC_KEY", "");
  vi.stubEnv("VAPID_PRIVATE_KEY", "");
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
  await clearMailState();
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("importing SMTP_* once on first start", () => {
  it("copies a complete v0.3.3 configuration into the sending row, marked imported, password encrypted", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment();
    const before = await encryptedRowCount();

    await importSendingFromEnvironment();

    const view = await readSendingSettings(admin);
    expect(view).toMatchObject({
      configured: true,
      via: "account",
      host: "smtp.legacy.example",
      port: 587,
      security: "starttls",
      user: "orbit@legacy.example",
      sendsAs: "Orbit <orbit@legacy.example>",
      password: "set",
      source: "imported",
    });
    expect(view.setAt).not.toBeNull();
    expect(await encryptedRowCount()).toBe(before + 1);
    expect(await plaintextHits(LEGACY_PASSWORD)).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(LEGACY_PASSWORD);
  });

  it("reports the import on the operations snapshot as mailSending.source: imported", async () => {
    const { importSendingFromEnvironment } = await sending();
    stubV033Environment();

    await importSendingFromEnvironment();

    const operations = await getAdministratorOperations(admin) as Record<string, unknown> & { mailSending?: { source?: unknown } };
    expect(operations.mailSending?.source).toBe("imported");
    expect(JSON.stringify(operations)).not.toContain(LEGACY_PASSWORD);
  });

  it("does not import again on a second start, even with changed lines", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment();
    await importSendingFromEnvironment();
    const first = await readSendingSettings(admin);
    const count = await encryptedRowCount();

    stubV033Environment({ SMTP_HOST: "smtp.changed.example", SMTP_USER: "changed@legacy.example" });
    await importSendingFromEnvironment();

    const second = await readSendingSettings(admin);
    expect(second).toMatchObject({ host: "smtp.legacy.example", user: "orbit@legacy.example", source: "imported" });
    expect(second.setAt).toBe(first.setAt);
    expect(await encryptedRowCount()).toBe(count);
  });

  it("never overwrites sending set from the screen", async () => {
    const { importSendingFromEnvironment, readSendingSettings, setSendingSettings } = await sending();
    await setSendingSettings(admin, null, anotherAccount);
    const count = await encryptedRowCount();
    stubV033Environment();

    await importSendingFromEnvironment();

    expect(await readSendingSettings(admin)).toMatchObject({ host: "smtp.relay.example", user: "relay-user", source: "ui" });
    expect(await encryptedRowCount()).toBe(count);
    expect(await plaintextHits(LEGACY_PASSWORD)).toEqual([]);
  });

  it("imports exactly once when two starts race for it", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment();
    const before = await encryptedRowCount();

    const results = await Promise.allSettled([importSendingFromEnvironment(), importSendingFromEnvironment()]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await encryptedRowCount()).toBe(before + 1);
    expect((await readSendingSettings(admin)).source).toBe("imported");
  });

  it.each([
    ["no password at all", { SMTP_PASSWORD_FILE: undefined }],
    ["no host", { SMTP_HOST: undefined }],
    ["no user", { SMTP_USER: undefined }],
  ] as const)("imports nothing from an incomplete configuration (%s), and imports on a later start once it is complete", async (_label, overrides) => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment(overrides as Record<string, string | undefined>);
    const before = await encryptedRowCount();

    await importSendingFromEnvironment();

    expect((await readSendingSettings(admin)).configured).toBe(false);
    expect(await encryptedRowCount()).toBe(before);

    /* The lines were left alone, so the next start still has them to import. */
    stubV033Environment();
    await importSendingFromEnvironment();
    expect(await readSendingSettings(admin)).toMatchObject({ configured: true, source: "imported", host: "smtp.legacy.example" });
  });

  it("imports nothing while the key cannot be read, and imports on the first start that has it", async () => {
    const { importSendingFromEnvironment, readSendingSettings } = await sending();
    stubV033Environment();
    const before = await encryptedRowCount();

    const restore = lockTheInstance();
    try {
      await importSendingFromEnvironment();
    } finally {
      restore();
    }

    expect((await readSendingSettings(admin)).configured).toBe(false);
    expect(await encryptedRowCount()).toBe(before);
    expect(await plaintextHits(LEGACY_PASSWORD)).toEqual([]);
    const operations = await getAdministratorOperations(admin) as { mailSending?: { source?: unknown } };
    expect(operations.mailSending?.source).toBeNull();

    await importSendingFromEnvironment();
    expect((await readSendingSettings(admin)).source).toBe("imported");
  });
});

describe("after the import", () => {
  it("ignores SMTP_*: a send goes through the imported account whatever the lines now say", async () => {
    const { importSendingFromEnvironment } = await sending();
    stubV033Environment();
    await importSendingFromEnvironment();
    stubV033Environment({ SMTP_HOST: "smtp.changed.example", SMTP_USER: "changed@legacy.example", SMTP_FROM: "Changed <changed@legacy.example>" });

    const outcome = await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });

    expect(outcome.sendError).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toMatchObject({ host: "smtp.legacy.example", port: 587, user: "orbit@legacy.example", pass: LEGACY_PASSWORD, requireTls: true });
    expect(sent[0].message).toMatchObject({ from: "Orbit <orbit@legacy.example>", to: "someone@orbit-test.example" });
  });

  it("keeps sending reminders: the worker's own transport uses the imported account", async () => {
    const { importSendingFromEnvironment } = await sending();
    stubV033Environment();
    await importSendingFromEnvironment();
    const eventId = await seedReminder(fixture);

    await runNotificationCycle(undefined, { now: () => cycleTime });

    const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
    expect(delivery?.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toMatchObject({ host: "smtp.legacy.example", port: 587, user: "orbit@legacy.example", pass: LEGACY_PASSWORD });
    expect(sent[0].message).toMatchObject({ from: "Orbit <orbit@legacy.example>", to: fixture.users.owner.email });
  });
});

describe("with no sending row", () => {
  it("keeps a reminder queued rather than dropping it, and sends it once sending is set", async () => {
    const { setSendingSettings } = await sending();
    const eventId = await seedReminder(fixture);
    let providerCalls = 0;

    await runNotificationCycle(undefined, {
      now: () => cycleTime,
      retryDelayMs: () => 0,
      providers: {
        async sendEmail() { providerCalls += 1; },
        async sendPush() { providerCalls += 1; },
      },
    });

    const [queued] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
    expect(["pending", "retry"]).toContain(queued?.status);
    expect(providerCalls).toBe(0);

    await setSendingSettings(admin, null, anotherAccount);
    await runNotificationCycle(undefined, { now: () => new Date(cycleTime.getTime() + 60 * 60_000), retryDelayMs: () => 0 });

    const [delivered] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
    expect(delivered?.status).toBe("sent");
    expect(sent.at(-1)?.target).toMatchObject({ host: "smtp.relay.example", pass: RELAY_PASSWORD });
  });
});

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
