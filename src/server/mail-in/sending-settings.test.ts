import { randomBytes } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, mailInSecrets, mailSending } from "@/db/schema";
import { AppError } from "@/lib/app-error";

/**
 * How Orbit sends mail (#1629): the From header, the settings schema, the
 * account a send signs in with, the one-time `SMTP_*` import and the save,
 * against a scripted stand-in for the database (each awaited select gets the
 * next scripted answer; every write is recorded) and the real envelope crypto
 * under a throwaway key.
 */

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  keys: {} as Record<string, Buffer>,
  wrapKey: null as { keyEncryptionKey: Buffer; keyId: string } | null,
  mailbox: undefined as unknown,
  verify: "ready" as string,
}));

vi.mock("@/db", () => ({ getDb: () => state.db }));
vi.mock("@/server/authorization", () => ({ requireInstanceAdministrator: vi.fn(async () => undefined) }));
vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({}),
  keyEncryptionKeyFor: (_config: unknown, keyId: string) => state.keys[keyId] ?? null,
  wrappingKey: () => {
    if (!state.wrapKey) throw new Error("no key");
    return state.wrapKey;
  },
}));
vi.mock("./mailbox-config", () => {
  class MailInCredentialLockedError extends Error {
    readonly keyId: string;
    constructor(keyId: string) { super("locked"); this.keyId = keyId; }
  }
  return {
    MailInCredentialLockedError,
    getImapIngestionConfig: async () => {
      if (state.mailbox instanceof Error) throw state.mailbox;
      return state.mailbox;
    },
  };
});
vi.mock("@/server/notification-worker", async (original) => ({
  ...(await original<typeof import("@/server/notification-worker")>()),
  verifySmtpProviderConnection: vi.fn(async (_config: { smtpUrl: string; smtpFrom: string }) => state.verify),
}));

const settings = await import("./sending-settings");
const { requireInstanceAdministrator } = await import("@/server/authorization");
const { verifySmtpProviderConnection } = await import("@/server/notification-worker");
const { encryptMailInSecret } = await import("./core/secret-crypto");
const { MailInCredentialLockedError } = await import("./mailbox-config");

interface Op { kind: string; table?: unknown; args: Record<string, unknown[]>; returning: boolean }
type Step = unknown | Error | ((op: Op, ops: Op[]) => unknown);

function scriptedDb(steps: Step[], options: { execute?: () => unknown } = {}) {
  const ops: Op[] = [];
  const queue = [...steps];
  const take = (op: Op) => {
    if (!queue.length) return [];
    const step = queue.shift();
    const value = typeof step === "function" ? (step as (o: Op, all: Op[]) => unknown)(op, ops) : step;
    if (value instanceof Error) throw value;
    return value;
  };
  const chain = (kind: string, table?: unknown, consumes = true) => {
    const op: Op = { kind, table, args: {}, returning: false };
    ops.push(op);
    const proxy: unknown = new Proxy({}, {
      get(_target, property: string) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve().then(() => (consumes || op.returning ? take(op) : [])).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          op.args[property] = args;
          if (property === "returning") op.returning = true;
          if (property === "from" && !op.table) op.table = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db: Record<string, unknown> = {
    select: () => chain("select"),
    selectDistinct: () => chain("select"),
    insert: (table: unknown) => chain("insert", table, false),
    update: (table: unknown) => chain("update", table, false),
    delete: (table: unknown) => chain("delete", table, false),
    execute: () => Promise.resolve().then(() => (options.execute ? options.execute() : [])),
    transaction: async (body: (executor: unknown) => unknown) => body(db),
  };
  return { db: db as never, ops, remaining: () => queue.length };
}


const render = (node: unknown) => new PgDialect().sqlToQuery(node as SQL);
const KEY = randomBytes(32);
const NOW = new Date("2026-11-01T12:00:00.000Z");
const accountRow = {
  id: "row1", via: "account", host: "smtp.example.test", port: 587, security: "starttls", accountUser: "mailer",
  senderName: "Orbit", senderAddress: "orbit@example.test", passwordSecretId: "sec1", source: "ui", setByUserId: "u1",
  setAt: NOW, updatedAt: NOW, lastSentAt: null, lastSentWhat: null, version: 3,
} as Record<string, unknown>;
const mailboxRow = { ...accountRow, via: "mailbox", host: "", accountUser: "", passwordSecretId: null } as Record<string, unknown>;
const readyMailbox = { configured: true, host: "imap.example.test", user: "box@example.test", password: "box-pass" };

function secretRow(password: string, host = "smtp.example.test", user = "mailer") {
  const encrypted = encryptMailInSecret(Buffer.from(password, "utf8"), { secretId: "sec1", kind: "smtp_password", host, user }, KEY, "k1");
  return { id: "sec1", ciphertext: encrypted.ciphertext, ...encrypted.envelope };
}

const use = (steps: Step[]) => {
  const script = scriptedDb(steps);
  state.db = script.db;
  return script;
};
const inserts = (ops: Op[], table: unknown) => ops.filter((op) => op.kind === "insert" && op.table === table)
  .map((op) => op.args.values![0] as Record<string, unknown>);

beforeEach(() => {
  state.keys = { k1: KEY };
  state.wrapKey = { keyEncryptionKey: KEY, keyId: "k1" };
  state.mailbox = readyMailbox;
  state.verify = "ready";
  vi.mocked(requireInstanceAdministrator).mockClear();
  vi.mocked(verifySmtpProviderConnection).mockClear();
});
afterEach(() => { state.db = undefined; });

describe("sendsAsOf", () => {
  it("is the bare address with no name, the plain name when nothing in it is special", () => {
    expect(settings.sendsAsOf("", "orbit@example.test")).toBe("orbit@example.test");
    expect(settings.sendsAsOf("Orbit Home", "orbit@example.test")).toBe("Orbit Home <orbit@example.test>");
  });

  it.each([
    ["Smith, Jo", '"Smith, Jo" <a@example.test>'],
    ['Jo "JJ"', '"Jo \\"JJ\\"" <a@example.test>'],
    ["back\\slash", '"back\\\\slash" <a@example.test>'],
    ["Orbit (home)", '"Orbit (home)" <a@example.test>'],
    ["a@b", '"a@b" <a@example.test>'],
    ["Dr. Who", '"Dr. Who" <a@example.test>'],
  ])("quotes %s because it holds an address-list special", (name, expected) => {
    expect(settings.sendsAsOf(name, "a@example.test")).toBe(expected);
  });
});

describe("configFor", () => {
  it("signs in as the account, percent-encoding what is in the URL, and sends as the given From", () => {
    const starttls = settings.configFor({ host: "smtp.example.test", port: 587, security: "starttls", user: "me@example.test", password: "p:w/d" }, "Orbit <o@example.test>");
    expect(starttls.smtpUrl).toBe("smtp://me%40example.test:p%3Aw%2Fd@smtp.example.test:587");
    expect(starttls.smtpSecurity).toBe("starttls");
    expect(starttls.smtpFrom).toBe("Orbit <o@example.test>");
    const implicit = settings.configFor({ host: "smtp.example.test", port: 465, security: "implicit_tls", user: "u", password: "p" }, "o@example.test");
    expect(implicit.smtpUrl).toBe("smtps://u:p@smtp.example.test:465");
    expect(implicit.smtpSecurity).toBe("implicit_tls");
  });
});

describe("sendingSettingsInputSchema", () => {
  const account = { via: "account", host: "smtp.example.test", port: 587, security: "starttls", user: "mailer", password: "secret", senderName: "Orbit", senderAddress: "orbit@example.test" };
  const parse = (value: unknown) => settings.sendingSettingsInputSchema.safeParse(value);

  it("accepts the mailbox form and the account form, trimming names but never the password", () => {
    expect(parse({ via: "mailbox", senderName: "  Orbit ", senderAddress: "orbit@example.test" })).toMatchObject({ success: true, data: { senderName: "Orbit" } });
    const parsed = parse({ ...account, host: " smtp.example.test ", password: " spaced " });
    expect(parsed).toMatchObject({ success: true, data: { host: "smtp.example.test", password: " spaced " } });
  });

  it.each([
    ["an unknown via", { ...account, via: "carrier" }],
    ["a host with a scheme", { ...account, host: "smtp://example.test" }],
    ["a host with a port", { ...account, host: "example.test:25" }],
    ["a host starting with a dot", { ...account, host: ".example.test" }],
    ["an empty host", { ...account, host: "  " }],
    ["a host over 253 characters", { ...account, host: "a".repeat(254) }],
    ["port 0", { ...account, port: 0 }],
    ["port 65536", { ...account, port: 65_536 }],
    ["a fractional port", { ...account, port: 25.5 }],
    ["an unknown security", { ...account, security: "none" }],
    ["a password with a control character", { ...account, password: "a\nb" }],
    ["a password with DEL", { ...account, password: "a\u007fb" }],
    ["an empty password", { ...account, password: "" }],
    ["a user with a control character", { ...account, user: "a\tb" }],
    ["an empty user", { ...account, user: "" }],
    ["a sender name with an angle bracket", { ...account, senderName: "A <B>" }],
    ["a sender name with a quote", { ...account, senderName: 'A "B"' }],
    ["a sender name with a backslash", { ...account, senderName: "A\\B" }],
    ["a sender name with a newline", { ...account, senderName: "A\nB" }],
    ["a sender name over 80 characters", { ...account, senderName: "n".repeat(81) }],
    ["a bad sender address", { ...account, senderAddress: "not-an-address" }],
  ])("refuses %s", (_name, value) => {
    expect(parse(value).success).toBe(false);
  });

  it("allows internal names with underscores and the edge ports", () => {
    expect(parse({ ...account, host: "relay_1.internal", port: 1 }).success).toBe(true);
    expect(parse({ ...account, host: "192.0.2.5", port: 65_535 }).success).toBe(true);
  });
});

describe("resolveSendingAccount", () => {
  it("is unconfigured with no row", async () => {
    use([[]]);
    expect(await settings.resolveSendingAccount()).toEqual({ state: "unconfigured" });
  });

  it("signs in as the account with its decrypted password and the From it sends as", async () => {
    use([[accountRow], [secretRow("hunter2")]]);
    expect(await settings.resolveSendingAccount()).toEqual({
      state: "ready", host: "smtp.example.test", port: 587, security: "starttls", user: "mailer", password: "hunter2", from: "Orbit <orbit@example.test>",
    });
  });

  it("is unconfigured for an account with no password reference or a dangling one", async () => {
    use([[{ ...accountRow, passwordSecretId: null }]]);
    expect(await settings.resolveSendingAccount()).toEqual({ state: "unconfigured" });
    use([[accountRow], []]);
    expect(await settings.resolveSendingAccount()).toEqual({ state: "unconfigured" });
  });

  it("is locked when the key is gone, or when the password was sealed for another host or user", async () => {
    use([[accountRow], [secretRow("hunter2")]]);
    state.keys = {};
    expect(await settings.resolveSendingAccount()).toEqual({ state: "locked" });
    state.keys = { k1: KEY };
    use([[accountRow], [secretRow("hunter2", "other.example.test")]]);
    expect(await settings.resolveSendingAccount()).toEqual({ state: "locked" });
    use([[accountRow], [secretRow("hunter2", "smtp.example.test", "someone-else")]]);
    expect(await settings.resolveSendingAccount()).toEqual({ state: "locked" });
  });

  it("through the mailbox account: Gmail's server for a Gmail profile, the mailbox's own host otherwise", async () => {
    use([[mailboxRow], [{ providerProfile: "gmail" }]]);
    expect(await settings.resolveSendingAccount()).toEqual({
      state: "ready", host: "smtp.gmail.com", port: 587, security: "starttls", user: "box@example.test", password: "box-pass", from: "Orbit <orbit@example.test>",
    });
    use([[mailboxRow], [{ providerProfile: "other" }]]);
    expect(await settings.resolveSendingAccount()).toMatchObject({ state: "ready", host: "imap.example.test" });
    use([[mailboxRow], []]);
    expect(await settings.resolveSendingAccount()).toMatchObject({ state: "ready", host: "imap.example.test" });
  });

  it("through the mailbox account: locked when the mailbox credential will not open, unconfigured with no mailbox", async () => {
    use([[mailboxRow]]);
    state.mailbox = new Error("cannot decrypt");
    expect(await settings.resolveSendingAccount()).toEqual({ state: "locked" });
    use([[mailboxRow]]);
    state.mailbox = { configured: false };
    expect(await settings.resolveSendingAccount()).toEqual({ state: "unconfigured" });
  });
});

describe("outgoingMailConfig", () => {
  it("has an empty smtpUrl when sending is not set up, locked, or the lookup fails", async () => {
    use([[]]);
    expect((await settings.outgoingMailConfig()).smtpUrl).toBe("");
    use([[accountRow], [secretRow("hunter2")]]);
    state.keys = {};
    expect((await settings.outgoingMailConfig()).smtpUrl).toBe("");
    state.db = { select: () => { throw new Error("database down"); } };
    expect((await settings.outgoingMailConfig()).smtpUrl).toBe("");
  });

  it("signs in as the stored account and sends as its From when ready", async () => {
    use([[accountRow], [secretRow("hunter2")]]);
    const config = await settings.outgoingMailConfig();
    expect(config.smtpUrl).toBe("smtp://mailer:hunter2@smtp.example.test:587");
    expect(config.smtpFrom).toBe("Orbit <orbit@example.test>");
    expect(config.smtpSecurity).toBe("starttls");
  });
});

describe("sendingConfigured", () => {
  it("is false with no row; an account is configured by its password reference alone", async () => {
    use([[]]);
    expect(await settings.sendingConfigured()).toBe(false);
    use([[accountRow]]);
    expect(await settings.sendingConfigured()).toBe(true);
    use([[{ ...accountRow, passwordSecretId: null }]]);
    expect(await settings.sendingConfigured()).toBe(false);
  });

  it("through the mailbox it needs the mailbox's host, user and password", async () => {
    use([[mailboxRow], [{ host: "imap.example.test", accountUser: "box", passwordSecretId: "x" }]]);
    expect(await settings.sendingConfigured()).toBe(true);
    use([[mailboxRow], [{ host: "imap.example.test", accountUser: "", passwordSecretId: "x" }]]);
    expect(await settings.sendingConfigured()).toBe(false);
    use([[mailboxRow], [{ host: "imap.example.test", accountUser: "box", passwordSecretId: null }]]);
    expect(await settings.sendingConfigured()).toBe(false);
    use([[mailboxRow], []]);
    expect(await settings.sendingConfigured()).toBe(false);
  });
});

describe("sendingSource", () => {
  it("is null with no row, else the row's source", async () => {
    use([[]]);
    expect(await settings.sendingSource()).toBeNull();
    use([[{ ...accountRow, source: "imported" }]]);
    expect(await settings.sendingSource()).toBe("imported");
  });

  it("with `usable` is null unless the stored password opens (#1817)", async () => {
    use([[{ ...accountRow, source: "imported" }], [{ ...accountRow, source: "imported" }], [secretRow("hunter2")]]);
    expect(await settings.sendingSource({ usable: true })).toBe("imported");
    use([[{ ...accountRow, source: "imported" }], [{ ...accountRow, source: "imported" }], [secretRow("hunter2")]]);
    state.keys = {};
    expect(await settings.sendingSource({ usable: true })).toBeNull();
  });
});

describe("sendingImportedFromEnvironment", () => {
  it("is true once an import record exists, false before", async () => {
    use([[{ id: "a" }]]);
    expect(await settings.sendingImportedFromEnvironment()).toBe(true);
    use([[]]);
    expect(await settings.sendingImportedFromEnvironment()).toBe(false);
  });
});

describe("noteMailSent", () => {
  it("records what went and when, the label cut to 80 characters", async () => {
    const { ops } = use([]);
    await settings.noteMailSent("x".repeat(100), NOW);
    const update = ops.find((op) => op.kind === "update" && op.table === mailSending)!;
    expect(update.args.set![0]).toEqual({ lastSentAt: NOW, lastSentWhat: "x".repeat(80) });
  });

  it("never fails the send when the card cannot be updated", async () => {
    state.db = { update: () => { throw new Error("down"); } };
    await expect(settings.noteMailSent("reminder")).resolves.toBeUndefined();
  });
});

describe("readSendingSettings", () => {
  it("asks for an administrator first, and shows 'not set up' with no row", async () => {
    use([[]]);
    const view = await settings.readSendingSettings("admin");
    expect(requireInstanceAdministrator).toHaveBeenCalledWith("admin");
    expect(view).toMatchObject({ configured: false, via: null, password: null, version: null });
  });

  it("refuses a non-administrator before reading anything", async () => {
    vi.mocked(requireInstanceAdministrator).mockRejectedValueOnce(new AppError("forbidden", "no", 403));
    const { ops } = use([]);
    await expect(settings.readSendingSettings("member")).rejects.toMatchObject({ status: 403 });
    expect(ops).toHaveLength(0);
  });

  it("shows another account without its password: that one is set, by whom and when", async () => {
    const created = new Date("2026-10-01T08:00:00.000Z");
    use([
      [{ ...accountRow, lastSentAt: NOW, lastSentWhat: "reminder" }], [{ displayName: "Ada" }],
      [{ createdAt: created, createdByUserId: "u2" }], [{ displayName: "Grace" }],
    ]);
    const view = await settings.readSendingSettings("admin");
    expect(view).toEqual({
      configured: true, via: "account", host: "smtp.example.test", port: 587, security: "starttls", user: "mailer",
      senderName: "Orbit", senderAddress: "orbit@example.test", sendsAs: "Orbit <orbit@example.test>", password: "set",
      credentialSetBy: "Grace", credentialSetAt: created.toISOString(), source: "ui", setBy: "Ada", setAt: NOW.toISOString(),
      lastSent: { what: "reminder", at: NOW.toISOString() }, version: 3,
    });
    expect(JSON.stringify(view)).not.toContain("hunter2");
  });

  it("shows an account with no password, no setter and a dangling secret reference as not configured", async () => {
    use([[{ ...accountRow, passwordSecretId: null, setByUserId: null }]]);
    expect(await settings.readSendingSettings("admin")).toMatchObject({ configured: false, password: null, setBy: null, credentialSetBy: null, credentialSetAt: null });
    use([[accountRow], [], [], []]);
    expect(await settings.readSendingSettings("admin")).toMatchObject({ configured: true, password: "set", credentialSetAt: null, setBy: null });
  });

  it("through the mailbox it shows the mailbox's submission server and says the password is the mailbox's", async () => {
    use([[mailboxRow], [{ displayName: "Ada" }], [{ host: "imap.gmail.com", providerProfile: "gmail", accountUser: "box", passwordSecretId: "p" }]]);
    expect(await settings.readSendingSettings("admin")).toMatchObject({
      configured: true, via: "mailbox", host: "smtp.gmail.com", port: 587, security: "starttls", user: "box", password: "mailbox", credentialSetBy: null,
    });
    use([[mailboxRow], [{ displayName: "Ada" }], []]);
    expect(await settings.readSendingSettings("admin")).toMatchObject({ configured: false, host: null, port: null, security: null, user: null, password: "mailbox" });
  });
});

describe("setSendingSettings", () => {
  const accountInput = { via: "account", host: "smtp.example.test", port: 465, security: "implicit_tls", user: "me@example.test", password: "typed-pw", senderName: "Orbit, Home", senderAddress: "orbit@example.test" } as const;
  const mailboxInput = { via: "mailbox", senderName: "Orbit", senderAddress: "orbit@example.test" } as const;

  it("refuses with a conflict when the caller's version is not the stored one, writing nothing", async () => {
    const { ops } = use([[accountRow]]);
    await expect(settings.setSendingSettings("admin", 2, accountInput)).rejects.toMatchObject({ status: 409, code: "sending_version_conflict" });
    expect(ops.filter((op) => op.kind !== "select")).toHaveLength(0);
    use([[]]);
    await expect(settings.setSendingSettings("admin", 1, accountInput)).rejects.toMatchObject({ code: "sending_version_conflict" });
  });

  it("refuses an invalid input before anything is read", async () => {
    const { ops } = use([]);
    await expect(settings.setSendingSettings("admin", null, { ...accountInput, port: 0 })).rejects.toThrow();
    expect(ops).toHaveLength(0);
  });

  it("verifies with exactly what was typed and writes nothing when the server refuses it", async () => {
    state.verify = "smtp_rejected";
    const { ops } = use([[], []]);
    const result = await settings.setSendingSettings("admin", null, accountInput);
    expect(result).toMatchObject({ outcome: "smtp_rejected", settings: { configured: false } });
    const candidate = vi.mocked(verifySmtpProviderConnection).mock.calls[0]![0]!;
    expect(candidate.smtpUrl).toBe("smtps://me%40example.test:typed-pw@smtp.example.test:465");
    expect(candidate.smtpFrom).toBe('"Orbit, Home" <orbit@example.test>');
    expect(ops.filter((op) => op.kind !== "select")).toHaveLength(0);
  });

  it.each(["smtp_unavailable", "smtp_unconfigured", "unsafe_input"])("answers smtp_unavailable for %s, with the existing settings", async (verdict) => {
    state.verify = verdict;
    use([[accountRow], [{ displayName: "Ada" }], [{ createdAt: NOW, createdByUserId: "u2" }], [{ displayName: "Grace" }]]);
    const result = await settings.setSendingSettings("admin", 3, accountInput);
    expect(result.outcome).toBe("smtp_unavailable");
    expect(result.settings.version).toBe(3);
  });

  it("first setup of another account: stores the password encrypted, the row, and an audit with no secret in it", async () => {
    const script = use([
      [], [],
      [{ id: "row9" }],
      [{ ...accountRow, id: "row9", version: 1, port: 465, security: "implicit_tls", accountUser: "me@example.test" }], [{ displayName: "Ada" }], [], [],
    ]);
    const result = await settings.setSendingSettings("admin", null, accountInput);
    expect(result.outcome).toBe("verified");
    expect(result.settings).toMatchObject({ via: "account", version: 1 });
    const [secret] = inserts(script.ops, mailInSecrets);
    expect(secret).toMatchObject({ kind: "smtp_password", keyId: "k1", createdByUserId: "admin" });
    expect(JSON.stringify(secret)).not.toContain("typed-pw");
    const [row] = inserts(script.ops, mailSending);
    expect(row).toMatchObject({
      via: "account", host: "smtp.example.test", port: 465, security: "implicit_tls", accountUser: "me@example.test",
      senderName: "Orbit, Home", passwordSecretId: secret!.id, source: "ui", setByUserId: "admin",
    });
    const [audit] = inserts(script.ops, auditLog);
    expect(audit).toMatchObject({ entityType: "mail_sending", entityId: "row9", action: "mail_sending_set", actorUserId: "admin", householdId: null });
    expect(audit!.changes).toEqual({ via: "account", keyId: "k1" });
  });

  it("replacing: bumps the version under the stored one and deletes the superseded password in the same transaction", async () => {
    const script = use([[accountRow], [accountRow], [{ id: "row1" }], [accountRow], [], [], []]);
    await settings.setSendingSettings("admin", 3, accountInput);
    const update = script.ops.find((op) => op.kind === "update" && op.table === mailSending)!;
    expect(update.args.set![0]).toMatchObject({ version: 4, via: "account", source: "ui" });
    const removed = script.ops.filter((op) => op.kind === "delete" && op.table === mailInSecrets);
    expect(removed).toHaveLength(1);
    expect(render(removed[0]!.args.where![0]).params).toEqual(["sec1"]);
    expect(inserts(script.ops, mailInSecrets)[0]!.id).not.toBe("sec1");
    expect(inserts(script.ops, auditLog)[0]!.entityId).toBe("row1");
  });

  it("through the mailbox it stores no password and resets to the standard submission settings", async () => {
    const script = use([[accountRow], [{ providerProfile: "gmail" }], [accountRow], [{ id: "row1" }], [mailboxRow], [], []]);
    await settings.setSendingSettings("admin", 3, mailboxInput);
    const candidate = vi.mocked(verifySmtpProviderConnection).mock.calls[0]![0]!;
    const url = new URL(candidate.smtpUrl);
    expect([url.protocol, decodeURIComponent(url.username), url.password, url.hostname, url.port]).toEqual(["smtp:", "box@example.test", "box-pass", "smtp.gmail.com", "587"]);
    expect(inserts(script.ops, mailInSecrets)).toHaveLength(0);
    const update = script.ops.find((op) => op.kind === "update" && op.table === mailSending)!;
    expect(update.args.set![0]).toMatchObject({ via: "mailbox", host: "", port: 587, security: "starttls", accountUser: "", passwordSecretId: null });
    expect(inserts(script.ops, auditLog)[0]!.changes).toEqual({ via: "mailbox" });
  });

  it("through the mailbox: a locked mailbox credential is a 503, an unset mailbox a 409, anything else passes through", async () => {
    use([[]]);
    state.mailbox = new MailInCredentialLockedError("k1");
    await expect(settings.setSendingSettings("admin", null, mailboxInput)).rejects.toMatchObject({ code: "credential_locked", status: 503 });
    use([[]]);
    state.mailbox = { configured: false };
    await expect(settings.setSendingSettings("admin", null, mailboxInput)).rejects.toMatchObject({ code: "mailbox_not_configured", status: 409 });
    use([[]]);
    state.mailbox = new TypeError("boom");
    await expect(settings.setSendingSettings("admin", null, mailboxInput)).rejects.toBeInstanceOf(TypeError);
  });

  it("is a conflict when the row changed between the check and the write", async () => {
    use([[accountRow], [{ ...accountRow, version: 4 }]]);
    await expect(settings.setSendingSettings("admin", 3, accountInput)).rejects.toMatchObject({ code: "sending_version_conflict" });
    use([[], [accountRow]]);
    await expect(settings.setSendingSettings("admin", null, accountInput)).rejects.toMatchObject({ code: "sending_version_conflict" });
    use([[accountRow], []]);
    await expect(settings.setSendingSettings("admin", 3, accountInput)).rejects.toMatchObject({ code: "sending_version_conflict" });
  });

  it("is a conflict when the versioned update matches nothing", async () => {
    use([[accountRow], [accountRow], []]);
    await expect(settings.setSendingSettings("admin", 3, accountInput)).rejects.toMatchObject({ code: "sending_version_conflict" });
  });

  it.each([
    ["a bare unique violation", Object.assign(new Error("dup"), { code: "23505" })],
    ["a wrapped unique violation", Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("dup"), { code: "23505" }) })],
  ])("treats %s on the first save as losing the race: a conflict", async (_name, error) => {
    use([[], [], error]);
    await expect(settings.setSendingSettings("admin", null, accountInput)).rejects.toMatchObject({ code: "sending_version_conflict" });
  });

  it("rethrows any other insert failure, and a first insert that returns no row is a conflict", async () => {
    use([[], [], new Error("disk full")]);
    await expect(settings.setSendingSettings("admin", null, accountInput)).rejects.toThrow("disk full");
    use([[], [], []]);
    await expect(settings.setSendingSettings("admin", null, accountInput)).rejects.toMatchObject({ code: "sending_version_conflict" });
  });
});

describe("importSendingFromEnvironment", () => {
  const lines = { SMTP_HOST: "smtp.example.test", SMTP_USER: "mailer", SMTP_PASSWORD: "hunter2", SMTP_FROM: "Orbit <orbit@example.test>" } as NodeJS.ProcessEnv;

  it("does nothing, and queries nothing, when no SMTP line is set", async () => {
    const { ops } = use([]);
    expect(await settings.importSendingFromEnvironment({})).toBe("absent");
    expect(await settings.importSendingFromEnvironment({ SMTP_HOST: "   " })).toBe("absent");
    expect(ops).toHaveLength(0);
    expect(settings.sendingImportSkipped()).toBeNull();
  });

  it("leaves a row set from the screen (or an earlier import) alone", async () => {
    const { ops } = use([[{ id: "x" }]]);
    expect(await settings.importSendingFromEnvironment(lines)).toBe("already_set");
    expect(ops.filter((op) => op.kind !== "select")).toHaveLength(0);
  });

  it.each([
    ["a half-written set", { SMTP_HOST: "smtp.example.test" }],
    ["a port out of range", { ...lines, SMTP_PORT: "70000" }],
    ["a port that is not a number", { ...lines, SMTP_PORT: "abc" }],
    ["a host that is not a server name", { ...lines, SMTP_HOST: "bad host!" }],
    ["a password in two forms", { ...lines, SMTP_PASSWORD_FILE: "/nonexistent/pw" }],
    ["an unreadable password file", { SMTP_HOST: lines.SMTP_HOST, SMTP_USER: "mailer", SMTP_PASSWORD_FILE: "/nonexistent/pw" }],
    ["a password with a control character", { ...lines, SMTP_PASSWORD: "a\nb" }],
    ["a user with a control character", { ...lines, SMTP_USER: "a\tb" }],
  ])("reports %s as unusable and writes nothing", async (_name, environment) => {
    const { ops } = use([[]]);
    expect(await settings.importSendingFromEnvironment(environment as NodeJS.ProcessEnv)).toBe("lines_unusable");
    expect(settings.sendingImportSkipped()).toEqual({ reason: "lines_unusable" });
    expect(ops.filter((op) => op.kind !== "select")).toHaveLength(0);
  });

  it("reports an unreadable key so that a later start can still import", async () => {
    use([[]]);
    state.wrapKey = null;
    expect(await settings.importSendingFromEnvironment(lines)).toBe("key_unavailable");
    expect(settings.sendingImportSkipped()).toEqual({ reason: "key_unavailable" });
  });

  it("copies a complete set once, marked imported, the password encrypted, with an audit of the key only", async () => {
    const script = use([[], [], [{ id: "row1" }]]);
    expect(await settings.importSendingFromEnvironment(lines)).toBe("imported");
    expect(settings.sendingImportSkipped()).toBeNull();
    const [secret] = inserts(script.ops, mailInSecrets);
    expect(JSON.stringify(secret)).not.toContain("hunter2");
    expect(inserts(script.ops, mailSending)[0]).toMatchObject({
      via: "account", host: "smtp.example.test", port: 587, security: "starttls", accountUser: "mailer",
      senderName: "Orbit", senderAddress: "orbit@example.test", passwordSecretId: secret!.id, source: "imported", setByUserId: null,
    });
    expect(inserts(script.ops, auditLog)[0]).toMatchObject({ action: "mail_sending_imported", actorUserId: null, changes: { keyId: "k1" } });
  });

  it("takes implicit TLS to port 465 and an explicit port as given", async () => {
    const implicit = use([[], [], [{ id: "r" }]]);
    await settings.importSendingFromEnvironment({ ...lines, SMTP_SECURITY: "implicit_tls" });
    expect(inserts(implicit.ops, mailSending)[0]).toMatchObject({ security: "implicit_tls", port: 465 });
    const explicit = use([[], [], [{ id: "r" }]]);
    await settings.importSendingFromEnvironment({ ...lines, SMTP_PORT: "2525" });
    expect(inserts(explicit.ops, mailSending)[0]).toMatchObject({ security: "starttls", port: 2525 });
  });

  it("reads a quoted display name with a comma as one sender", async () => {
    const script = use([[], [], [{ id: "r" }]]);
    await settings.importSendingFromEnvironment({ ...lines, SMTP_FROM: '"Home, Sweet" <home@example.test>' });
    expect(inserts(script.ops, mailSending)[0]).toMatchObject({ senderName: "Home, Sweet", senderAddress: "home@example.test" });
  });

  it("with no address in SMTP_FROM, sends as the user when that is an address, else as the old default sender", async () => {
    const asUser = use([[], [], [{ id: "r" }]]);
    await settings.importSendingFromEnvironment({ ...lines, SMTP_USER: "me@example.test", SMTP_FROM: "Orbit" });
    expect(inserts(asUser.ops, mailSending)[0]).toMatchObject({ senderName: "Orbit", senderAddress: "me@example.test" });
    const legacy = use([[], [], [{ id: "r" }]]);
    await settings.importSendingFromEnvironment({ ...lines, SMTP_FROM: "Orbit" });
    expect(inserts(legacy.ops, mailSending)[0]).toMatchObject({ senderName: "Orbit", senderAddress: "orbit@localhost" });
  });

  it("reads the password from its file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = mkdtempSync(join(tmpdir(), "orbit-smtp-"));
    const file = join(directory, "pw");
    writeFileSync(file, "from-file\n");
    const script = use([[], [], [{ id: "r" }]]);
    let result: Awaited<ReturnType<typeof settings.importSendingFromEnvironment>>;
    try {
      result = await settings.importSendingFromEnvironment({ SMTP_HOST: lines.SMTP_HOST, SMTP_USER: "mailer", SMTP_PASSWORD_FILE: file } as NodeJS.ProcessEnv);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(result).toBe("imported");
    expect(inserts(script.ops, mailInSecrets)).toHaveLength(1);
  });

  it("answers already_set when a concurrent start imported first, and removes its own password when its insert lost", async () => {
    const early = use([[], [{ id: "winner" }]]);
    expect(await settings.importSendingFromEnvironment(lines)).toBe("already_set");
    expect(inserts(early.ops, mailInSecrets)).toHaveLength(0);
    const late = use([[], [], []]);
    expect(await settings.importSendingFromEnvironment(lines)).toBe("already_set");
    expect(inserts(late.ops, mailInSecrets)).toHaveLength(1);
    const removed = late.ops.filter((op) => op.kind === "delete" && op.table === mailInSecrets);
    expect(removed).toHaveLength(1);
    expect(render(removed[0]!.args.where![0]).params).toEqual([inserts(late.ops, mailInSecrets)[0]!.id]);
    expect(inserts(late.ops, auditLog)).toHaveLength(0);
  });
});

describe("the mailbox account's submission server (#1780)", () => {
  it("keeps Gmail's default submission server", () => {
    expect(settings.mailboxSubmissionServer({ host: "imap.gmail.com", providerProfile: "gmail" })).toEqual({ host: "smtp.gmail.com", port: 587, security: "starttls" });
  });

  it("submits through the mailbox's own host for other and a stored outlook profile", () => {
    expect(settings.mailboxSubmissionServer({ host: "mail.example.test", providerProfile: "other" }).host).toBe("mail.example.test");
    expect(settings.mailboxSubmissionServer({ host: "outlook.office365.com", providerProfile: "outlook" }).host).toBe("outlook.office365.com");
  });
});
