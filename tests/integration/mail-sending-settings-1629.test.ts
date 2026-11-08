/**
 * #1629: outgoing mail is set on the Administration Mail card and stored by
 * Orbit, not in `SMTP_*` lines (design note 54742, ADR-0017 amendment
 * "outgoing mail is app-managed too"), against a real PostgreSQL.
 *
 * Only the wire is stood in for: nodemailer's `createTransport`, so what is
 * asserted is where Orbit signed in, with what, and what it then stored and
 * showed. The view's field names (`via`, `sendsAs`, `password`, `source`,
 * `credentialSetBy`, `lastSent`, ...) are the tests' choice, written down on
 * #1629; the note names the rows, not the fields.
 *
 * Readings chosen where the note is silent:
 *  - a refused or unreachable server answers with today's bounded words
 *    (`smtp_rejected`, `smtp_unavailable`); a passing save answers `verified`,
 *    as the mailbox does;
 *  - "the mailbox account" on a mailcow (or `other`) mailbox submits to the
 *    mailbox's own host, port 587, STARTTLS, signed in as the mailbox account;
 *  - the admin operations snapshot carries `mailSending.source`
 *    (`"ui" | "imported" | null`), beside `mailboxIngestion`: the field the
 *    launcher (ai/orbit-launcher#339) reads.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupIntegrationEnvironment, createIntegrationFixture, lockTheInstance, type IntegrationFixture } from "./support/fixtures";
import {
  MAILBOX_PASSWORD,
  RELAY_PASSWORD,
  anotherAccount,
  clearMailState,
  encryptedRowCount,
  fakeTransporter,
  mailboxInput,
  plaintextHits,
  refusedSignIn,
  sending,
  targetOf,
  unreachable,
  viaMailbox,
} from "./support/mail-sending-1629";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nodemailer")>();
  const replaced = { ...actual, createTransport: mocks.createTransport };
  return { ...replaced, default: { ...actual.default, createTransport: mocks.createTransport } };
});

const { setMailboxSettings } = await import("@/server/mail-in/mailbox-settings");
const { sendBoundedMail, outgoingMailReady } = await import("@/server/invitations/send");
const { getAdministratorOperations } = await import("@/server/admin-operations");

let fixture: IntegrationFixture;
let admin: string;
let transporters: Array<ReturnType<typeof fakeTransporter> & { sendMail: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> }>;

/** The env an install still carries after #1629: complete, and to be ignored. */
function stubStaleSmtpEnvironment() {
  vi.stubEnv("SMTP_HOST", "smtp.stale-env.example");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_SECURITY", "starttls");
  vi.stubEnv("SMTP_USER", "stale-user@stale-env.example");
  vi.stubEnv("SMTP_PASSWORD", "fake-stale-env-pass");
  vi.stubEnv("SMTP_FROM", "Stale <stale@stale-env.example>");
}

beforeEach(async () => {
  fixture = await createIntegrationFixture("mail-sending-1629");
  admin = fixture.users.admin.id;
  transporters = [];
  mocks.createTransport.mockReset();
  mocks.createTransport.mockImplementation(() => {
    const base = fakeTransporter();
    const transporter = { ...base, sendMail: vi.fn(base.sendMail), verify: vi.fn(base.verify) };
    transporters.push(transporter);
    return transporter;
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await clearMailState();
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function setUpMailbox() {
  await setMailboxSettings(admin, null, mailboxInput, { verifyImap: async () => "ready" });
}

describe("saving another account (verify, then store)", () => {
  it("signs in to the server first, with exactly what was typed, before anything is stored", async () => {
    const { setSendingSettings } = await sending();
    const before = await encryptedRowCount();
    let storedWhenVerified = -1;
    mocks.createTransport.mockImplementationOnce(() => {
      const base = fakeTransporter();
      const transporter = {
        ...base,
        sendMail: vi.fn(base.sendMail),
        verify: vi.fn(async () => { storedWhenVerified = await encryptedRowCount(); return true as const; }),
      };
      transporters.push(transporter);
      return transporter;
    });

    const { outcome } = await setSendingSettings(admin, null, anotherAccount);

    expect(outcome).toBe("verified");
    expect(transporters[0].verify).toHaveBeenCalledTimes(1);
    expect(targetOf(mocks.createTransport.mock.calls[0][0])).toMatchObject({
      host: "smtp.relay.example", port: 465, user: "relay-user", pass: RELAY_PASSWORD, implicitTls: true,
    });
    /* The sign-in ran while nothing had been written yet. */
    expect(storedWhenVerified).toBe(before);
    /* A sign-in check sends nothing. */
    expect(transporters[0].sendMail).not.toHaveBeenCalled();
  });

  it.each([
    ["a refused sign-in", refusedSignIn, "smtp_rejected"],
    ["a server that cannot be reached", unreachable, "smtp_unavailable"],
  ] as const)("on %s stores nothing at all and says why", async (_label, failure, reason) => {
    const { setSendingSettings, readSendingSettings } = await sending();
    const before = await encryptedRowCount();
    mocks.createTransport.mockImplementationOnce(() => ({
      ...fakeTransporter(), verify: vi.fn(async () => { throw failure(); }),
    }));

    const { outcome, settings } = await setSendingSettings(admin, null, anotherAccount);

    expect(outcome).toBe(reason);
    expect(settings.configured).toBe(false);
    expect((await readSendingSettings(admin)).configured).toBe(false);
    expect(await encryptedRowCount()).toBe(before);
    expect(await plaintextHits(RELAY_PASSWORD)).toEqual([]);
    expect(JSON.stringify(settings)).not.toContain(RELAY_PASSWORD);
  });

  it("on success writes the row as set from the screen, by whom and when, with the password encrypted and never read back", async () => {
    const { setSendingSettings, readSendingSettings } = await sending();
    const before = await encryptedRowCount();
    const startedAt = Date.now();

    const { settings } = await setSendingSettings(admin, null, anotherAccount);

    expect(settings).toMatchObject({
      configured: true,
      via: "account",
      host: "smtp.relay.example",
      port: 465,
      security: "implicit_tls",
      user: "relay-user",
      sendsAs: "Orbit <orbit@orbit-test.example>",
      password: "set",
      credentialSetBy: "Integration admin",
      source: "ui",
      setBy: "Integration admin",
    });
    expect(Date.parse(String(settings.setAt))).toBeGreaterThanOrEqual(startedAt - 1_000);
    expect(Date.parse(String(settings.credentialSetAt))).toBeGreaterThanOrEqual(startedAt - 1_000);

    /* Exactly one new envelope-encrypted row, and the password in plain text nowhere. */
    expect(await encryptedRowCount()).toBe(before + 1);
    expect(await plaintextHits(RELAY_PASSWORD)).toEqual([]);

    /* No read returns it: the engine's view, the admin operations snapshot. */
    const read = await readSendingSettings(admin);
    expect(JSON.stringify(read)).not.toContain(RELAY_PASSWORD);
    expect(JSON.stringify(settings)).not.toContain(RELAY_PASSWORD);
    expect(JSON.stringify(await getAdministratorOperations(admin))).not.toContain(RELAY_PASSWORD);
  });

  it("refuses someone who is not an instance administrator, and tries no sign-in for them", async () => {
    const { setSendingSettings } = await sending();
    await expect(setSendingSettings(fixture.users.member.id, null, anotherAccount)).rejects.toMatchObject({ status: 403 });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    /* The neighbour: the administrator's own save still goes through. */
    expect((await setSendingSettings(admin, null, anotherAccount)).outcome).toBe("verified");
  });

  it("lets only one of two first saves at once win; the other is told the settings changed", async () => {
    const { setSendingSettings, readSendingSettings } = await sending();
    const before = await encryptedRowCount();

    const results = await Promise.allSettled([
      setSendingSettings(admin, null, anotherAccount),
      setSendingSettings(admin, null, { ...anotherAccount, host: "smtp.second.example" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    expect(refused?.reason).toMatchObject({ status: 409 });
    expect(await encryptedRowCount()).toBe(before + 1);
    expect((await readSendingSettings(admin)).configured).toBe(true);
  });
});

describe("the mailbox account (no second password)", () => {
  it("stores no password of its own and shows the password as the mailbox's", async () => {
    const { setSendingSettings } = await sending();
    await setUpMailbox();
    const before = await encryptedRowCount();

    const { settings } = await setSendingSettings(admin, null, viaMailbox);

    expect(await encryptedRowCount()).toBe(before);
    expect(settings).toMatchObject({
      configured: true,
      via: "mailbox",
      host: "mail.orbit-test.example",
      port: 587,
      security: "starttls",
      user: "orbit@orbit-test.example",
      sendsAs: "Orbit <orbit@orbit-test.example>",
      password: "mailbox",
      source: "ui",
      setBy: "Integration admin",
    });
    expect(JSON.stringify(settings)).not.toContain(MAILBOX_PASSWORD);
  });

  it("sends through the mailbox's submission server, port 587 STARTTLS, signed in with the mailbox credential", async () => {
    const { setSendingSettings } = await sending();
    await setUpMailbox();
    await setSendingSettings(admin, null, viaMailbox);
    mocks.createTransport.mockClear();
    transporters = [];

    const outcome = await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });

    expect(outcome.sendError).toBeNull();
    expect(targetOf(mocks.createTransport.mock.calls.at(-1)?.[0])).toMatchObject({
      host: "mail.orbit-test.example", port: 587, user: "orbit@orbit-test.example", pass: MAILBOX_PASSWORD,
      implicitTls: false, requireTls: true,
    });
    expect(transporters.at(-1)?.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "Orbit <orbit@orbit-test.example>", to: "someone@orbit-test.example",
    }));
  });
});

describe("sendBoundedMail reads the sending row, not SMTP_*", () => {
  it("sends through the saved account even with a complete, different SMTP_* environment", async () => {
    const { setSendingSettings } = await sending();
    await setSendingSettings(admin, null, anotherAccount);
    stubStaleSmtpEnvironment();
    mocks.createTransport.mockClear();
    transporters = [];

    const outcome = await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });

    expect(outcome.sendError).toBeNull();
    expect(outcome.sentAt).not.toBeNull();
    expect(mocks.createTransport).toHaveBeenCalled();
    for (const [argument] of mocks.createTransport.mock.calls) {
      expect(targetOf(argument)).toMatchObject({ host: "smtp.relay.example", port: 465, user: "relay-user", pass: RELAY_PASSWORD, implicitTls: true });
    }
    expect(transporters.at(-1)?.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "Orbit <orbit@orbit-test.example>", to: "someone@orbit-test.example",
    }));
  });

  it("with no row, sends nothing and says outgoing mail is not set up, whatever SMTP_* holds", async () => {
    stubStaleSmtpEnvironment();

    const outcome = await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });

    expect(outcome).toEqual({ sentAt: null, sendError: "smtp_unconfigured" });
    expect(await outgoingMailReady()).toBe(false);
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("with the key missing, cannot read the password, so sends nothing and never falls back to SMTP_*", async () => {
    const { setSendingSettings } = await sending();
    await setSendingSettings(admin, null, anotherAccount);
    stubStaleSmtpEnvironment();
    mocks.createTransport.mockClear();
    transporters = [];
    const restore = lockTheInstance();
    try {
      const outcome = await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });
      expect(outcome.sentAt).toBeNull();
      expect(transporters.every((transporter) => transporter.sendMail.mock.calls.length === 0)).toBe(true);
      for (const [argument] of mocks.createTransport.mock.calls) {
        expect(targetOf(argument).host).not.toBe("smtp.stale-env.example");
      }
    } finally {
      restore();
    }
  });

  it("records the last send, which the card shows as last sent", async () => {
    const { setSendingSettings, readSendingSettings } = await sending();
    await setSendingSettings(admin, null, anotherAccount);
    expect((await readSendingSettings(admin)).lastSent).toBeNull();
    const startedAt = Date.now();

    await sendBoundedMail("someone@orbit-test.example", { subject: "Hello", text: "A test." });

    const { lastSent } = await readSendingSettings(admin);
    expect(lastSent).not.toBeNull();
    expect(Date.parse(String(lastSent?.at))).toBeGreaterThanOrEqual(startedAt - 1_000);
    expect(typeof lastSent?.what).toBe("string");
  });
});

describe("the administrator's sending view and the operations snapshot", () => {
  it("shows nothing set up as nothing: no via, no password, no source, never sent", async () => {
    const { readSendingSettings } = await sending();
    stubStaleSmtpEnvironment();

    const view = await readSendingSettings(admin);

    expect(view).toMatchObject({ configured: false, via: null, password: null, source: null, lastSent: null });
    expect(JSON.stringify(view)).not.toContain("fake-stale-env-pass");
  });

  it("is refused to someone who is not an instance administrator", async () => {
    const { readSendingSettings } = await sending();
    await expect(readSendingSettings(fixture.users.member.id)).rejects.toMatchObject({ status: 403 });
  });

  it("reports the sending source as mailSending.source: null, then ui once set from the screen", async () => {
    const { setSendingSettings } = await sending();
    stubStaleSmtpEnvironment();
    const before = await getAdministratorOperations(admin) as Record<string, unknown> & { mailSending?: { source?: unknown } };
    expect(before.mailSending).toBeDefined();
    expect(before.mailSending?.source).toBeNull();
    /* The SMTP_* lines alone are no longer outgoing mail. */
    expect((before as { providers: { smtp: string } }).providers.smtp).toBe("unconfigured");

    await setSendingSettings(admin, null, anotherAccount);

    const after = await getAdministratorOperations(admin) as Record<string, unknown> & { mailSending?: { source?: unknown } };
    expect(after.mailSending?.source).toBe("ui");
    expect((after as { providers: { smtp: string } }).providers.smtp).toBe("configured");
  });
});
