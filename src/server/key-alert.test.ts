import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { log } from "@/lib/logger";
import type { KeyFaultReason, KeyState } from "@/server/key-state";

/**
 * The operator key alert (#1405, #1629). The database and the mailer are
 * stood in for: selects answer from a queue in call order, inserts are
 * recorded, so what is written and what is mailed can be asserted.
 */
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), sendBoundedMail: vi.fn() }));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/invitations/send")>(),
  sendBoundedMail: mocks.sendBoundedMail,
}));

type Inserted = { action: string; changes: Record<string, unknown>; [key: string]: unknown };

function fakeDb(selects: unknown[][], options: { insertFails?: boolean; selectFails?: boolean } = {}) {
  const inserted: Inserted[] = [];
  const queue = [...selects];
  const wheres: Array<{ sql: string; params: unknown[] }> = [];
  const chain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const name of ["from", "orderBy", "limit"]) self[name] = () => self;
    self.where = (condition: SQL) => { wheres.push(new PgDialect().sqlToQuery(condition)); return self; };
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      (options.selectFails ? Promise.reject(new Error("conn string postgres://u:secret@h/db")) : Promise.resolve(queue.shift() ?? [])).then(resolve, reject);
    return self;
  };
  const db = {
    select: () => chain(),
    insert: () => ({
      values: async (row: Inserted) => {
        if (options.insertFails) throw new Error("postgres://u:secret@h/db refused");
        inserted.push(row);
      },
    }),
  };
  mocks.getDb.mockReturnValue(db);
  return { inserted, wheres };
}

const logged = () => JSON.stringify([
  ...vi.mocked(log.info).mock.calls,
  ...vi.mocked(log.warn).mock.calls,
]);

const original = { alert: process.env.OPERATOR_ALERT_ADDRESS, url: process.env.APP_URL };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  mocks.sendBoundedMail.mockResolvedValue({ sentAt: new Date(), sendError: null });
  process.env.OPERATOR_ALERT_ADDRESS = "ops@harlow.example";
  process.env.APP_URL = "https://orbit.harlow.example/";
});

afterEach(() => {
  for (const [name, value] of [["OPERATOR_ALERT_ADDRESS", original.alert], ["APP_URL", original.url]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const hash = (address: string) => createHash("sha256").update(address).digest("hex").slice(0, 16);

describe("sendKeyAlert", () => {
  it.each<KeyState>([{ verdict: "unknown" }, { verdict: "usable", heldKeyId: "k1" }])(
    "does nothing for a $verdict verdict",
    async (state) => {
      const { inserted } = fakeDb([]);
      const { sendKeyAlert } = await import("@/server/key-alert");
      await sendKeyAlert(state);
      expect(inserted).toEqual([]);
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    },
  );

  it.each([["unset", undefined], ["blank", "   "]])("writes nothing and says so in the log when the address is %s", async (_name, value) => {
    if (value === undefined) delete process.env.OPERATOR_ALERT_ADDRESS; else process.env.OPERATOR_ALERT_ADDRESS = value;
    const { inserted } = fakeDb([]);
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "missing" });
    expect(inserted).toEqual([]);
    expect(logged()).toContain("not_configured");
    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
  });

  it("logs a mistyped address as invalid, not as unset, and records nothing", async () => {
    process.env.OPERATOR_ALERT_ADDRESS = "not-an-address";
    const { inserted } = fakeDb([]);
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "missing" });
    expect(inserted).toEqual([]);
    expect(logged()).toContain("configuration_optional");
    expect(logged()).not.toContain("not_configured");
  });

  it("records the fault once, with a hash of the address and never the address, and does not mail", async () => {
    const { inserted } = fakeDb([[], []]);
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "mismatch", heldKeyId: "held-1", storedKeyId: "stored-1" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      action: "encryption_key_alert_held",
      entityType: "instance_authority",
      householdId: null,
      actorUserId: null,
      changes: { reason: "mismatch", heldKeyId: "held-1", storedKeyId: "stored-1", addressHash: hash("ops@harlow.example") },
    });
    expect(JSON.stringify(inserted)).not.toContain("ops@harlow.example");
    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(logged()).toContain("key_unavailable");
  });

  it("leaves heldKeyId and storedKeyId out of the record when the state has none", async () => {
    const { inserted } = fakeDb([[], []]);
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "missing" });
    expect(Object.keys(inserted[0].changes).sort()).toEqual(["addressHash", "reason"]);
  });

  it("does not record again when the same fault is already held since the last working-again record, and reads only held rows newer than that record", async () => {
    const fault = { reason: "missing", addressHash: hash("ops@harlow.example") };
    const restoredAt = new Date("2026-11-01T00:00:00Z");
    const { inserted, wheres } = fakeDb([[{ createdAt: restoredAt }], [{ changes: fault }]]);
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "missing" });
    expect(inserted).toEqual([]);
    expect(wheres[0].sql).toContain('"action" = $1');
    expect(wheres[0].params).toEqual(["encryption_key_restored"]);
    expect(wheres[1].sql).toContain('"action" = $1');
    expect(wheres[1].sql).toContain('"created_at" > $2');
    expect(wheres[1].params[0]).toBe("encryption_key_alert_held");
    expect(new Date(wheres[1].params[1] as string).getTime()).toBe(restoredAt.getTime());
    expect(logged()).toContain("key_unavailable");
  });

  it("does not record again for a held fault when there has never been a working-again record", async () => {
    const fault = { reason: "unreadable", heldKeyId: "a", addressHash: hash("ops@harlow.example") };
    const { inserted, wheres } = fakeDb([[], [{ changes: fault }]]);
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "unreadable", heldKeyId: "a" });
    expect(inserted).toEqual([]);
    expect(wheres[1].sql).toContain('"action" = $1');
    expect(wheres[1].sql).not.toContain("created_at");
    expect(wheres[1].params).toEqual(["encryption_key_alert_held"]);
  });

  it.each<[string, Record<string, unknown> | null, KeyState]>([
    ["a different reason", { reason: "missing", addressHash: hash("ops@harlow.example") }, { verdict: "unusable", reason: "malformed" }],
    ["a different held key", { reason: "mismatch", heldKeyId: "a", addressHash: hash("ops@harlow.example") }, { verdict: "unusable", reason: "mismatch", heldKeyId: "b" }],
    ["a different stored key", { reason: "mismatch", storedKeyId: "a", addressHash: hash("ops@harlow.example") }, { verdict: "unusable", reason: "mismatch", storedKeyId: "b" }],
    ["a corrected address", { reason: "missing", addressHash: hash("old@harlow.example") }, { verdict: "unusable", reason: "missing" }],
    ["a record with no changes at all", null, { verdict: "unusable", reason: "missing" }],
  ])("records a new row for %s", async (_name, recorded, state) => {
    const { inserted } = fakeDb([[], [{ changes: recorded }]]);
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert(state);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].action).toBe("encryption_key_alert_held");
  });

  it("resolves and logs one bounded line, without the error text, when the bookkeeping throws on read", async () => {
    fakeDb([], { selectFails: true });
    const { sendKeyAlert } = await import("@/server/key-alert");
    await expect(sendKeyAlert({ verdict: "unusable", reason: "missing" })).resolves.toBeUndefined();
    expect(logged()).toContain("unexpected_failure");
    expect(logged()).not.toContain("secret");
    expect(logged()).not.toContain("key_unavailable");
  });

  it("resolves and logs one bounded line when the insert throws", async () => {
    fakeDb([[], []], { insertFails: true });
    const { sendKeyAlert } = await import("@/server/key-alert");
    await expect(sendKeyAlert({ verdict: "unusable", reason: "missing" })).resolves.toBeUndefined();
    expect(logged()).toContain("unexpected_failure");
    expect(logged()).not.toContain("secret");
  });
});

describe("sendKeyRestoredNotice", () => {
  const faultAt = new Date("2026-11-10T10:00:00Z");

  it("sends nothing when no fault was ever held or alerted", async () => {
    const { inserted } = fakeDb([[]]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it.each([["later than", "2026-11-11T00:00:00Z"], ["exactly at", "2026-11-10T10:00:00Z"]])(
    "sends nothing when the working-again record is %s the last fault",
    async (_name, restored) => {
      const { inserted } = fakeDb([
        [{ action: "encryption_key_alert_held", changes: { reason: "missing" }, createdAt: faultAt }],
        [{ createdAt: new Date(restored) }],
      ]);
      const { sendKeyRestoredNotice } = await import("@/server/key-alert");
      await sendKeyRestoredNotice();
      expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
      expect(inserted).toEqual([]);
    },
  );

  it.each([["unset", undefined], ["invalid", "nope"]])("sends and records nothing when the address is %s", async (_name, value) => {
    if (value === undefined) delete process.env.OPERATOR_ALERT_ADDRESS; else process.env.OPERATOR_ALERT_ADDRESS = value;
    const { inserted } = fakeDb([
      [{ action: "encryption_key_alert_held", changes: { reason: "missing" }, createdAt: faultAt }],
      [],
    ]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("mails the operator once, saying what was wrong, then records it so a second start sends nothing", async () => {
    const { inserted, wheres } = fakeDb([
      [{ action: "encryption_key_alert_held", changes: { reason: "mismatch" }, createdAt: faultAt }],
      [{ createdAt: new Date("2026-11-01T00:00:00Z") }],
    ]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    expect(wheres[0].params).toEqual(["encryption_key_alert_sent", "encryption_key_alert_held"]);
    expect(wheres[1].params).toEqual(["encryption_key_restored"]);
    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    const [to, mail, mailer] = mocks.sendBoundedMail.mock.calls[0];
    expect(to).toBe("ops@harlow.example");
    expect(mailer).toBeUndefined();
    expect(mail.subject).toBe("Orbit's encryption key is working again");
    expect(mail.what).toBe("the key-restored notice");
    expect(mail.text).toContain("Orbit at https://orbit.harlow.example has started with its encryption key");
    expect(mail.text).toContain("not the key this database was written under");
    expect(mail.text).toContain("Nothing was lost. Everything stayed encrypted and intact while it was closed.");
    expect(mail.html).toContain("orbit.harlow.example");
    expect(mail.html).not.toContain("href=");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ action: "encryption_key_restored" });
    expect(inserted[0].changes).toStrictEqual({});
    expect(logged()).toContain("working-again notice sent");
  });

  it.each<[KeyFaultReason, string]>([
    ["missing", "was missing,"],
    ["unreadable", "was unreadable,"],
    ["malformed", "was malformed,"],
    ["both_forms", "was set twice,"],
    ["mismatch", "was not the key this database was written under,"],
    ["key_row_damaged", "was not able to open the key this database was written under,"],
  ])("names the %s fault in the mail", async (reason, words) => {
    fakeDb([[{ action: "encryption_key_alert_held", changes: { reason }, createdAt: faultAt }], []]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail.mock.calls[0][1].text).toContain(words);
  });

  it("for an alert mailed before #1629, says nothing of the fault and names it as the follow-up to the earlier alert", async () => {
    fakeDb([[{ action: "encryption_key_alert_sent", changes: { reason: "missing" }, createdAt: faultAt }], []]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    const mail = mocks.sendBoundedMail.mock.calls[0][1];
    expect(mail.text).toContain("This is the one message that follows the earlier alert.");
    expect(mail.text).not.toContain("could not mail you");
  });

  it("falls back to 'this server' when APP_URL is unreadable", async () => {
    process.env.APP_URL = "not a url";
    fakeDb([[{ action: "encryption_key_alert_held", changes: { reason: "missing" }, createdAt: faultAt }], []]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    const mail = mocks.sendBoundedMail.mock.calls[0][1];
    expect(mail.text).toContain("Orbit at this server has started");
    expect(mail.html).toContain("Orbit at this server");
    expect(mail.html).toContain("Orbit, run by a household, not a company.");
  });

  it("falls back to 'this server' when APP_URL is unset", async () => {
    delete process.env.APP_URL;
    fakeDb([[{ action: "encryption_key_alert_held", changes: { reason: "missing" }, createdAt: faultAt }], []]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail.mock.calls[0][1].text).toContain("Orbit at this server has started");
  });

  it("stamps the mail with the send time in UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T08:05:59Z"));
    try {
      fakeDb([[{ action: "encryption_key_alert_held", changes: { reason: "missing" }, createdAt: faultAt }], []]);
      const { sendKeyRestoredNotice } = await import("@/server/key-alert");
      await sendKeyRestoredNotice();
      expect(mocks.sendBoundedMail.mock.calls[0][1].text).toContain("Sent 2026-11-12 08:05 UTC.");
      expect(mocks.sendBoundedMail.mock.calls[0][3]).toEqual(new Date("2026-11-12T08:05:59Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a bounded warning and records nothing when the mail fails, so the next start tries again", async () => {
    mocks.sendBoundedMail.mockResolvedValue({ sentAt: null, sendError: "smtp_unavailable" });
    const { inserted } = fakeDb([[{ action: "encryption_key_alert_held", changes: { reason: "missing" }, createdAt: faultAt }], []]);
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    expect(inserted).toEqual([]);
    expect(vi.mocked(log.warn).mock.calls[0][0]).toMatchObject({ event: "delivery.smtp", reason: "smtp_unavailable", state: "degraded" });
  });
});
