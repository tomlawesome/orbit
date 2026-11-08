/**
 * The alert for a locked instance (#1405, design section 5), as #1629 left
 * it, against a real PostgreSQL for the one thing it keeps there: an
 * `audit_log` row that says a fault was held, which is what makes the
 * working-again notice follow it once. Since #1629 the sending password is
 * encrypted under the very key that is unusable, so the alert itself is
 * never mailed (ADR-0017 amendment "One alert cannot mail"); the operator
 * hears on the first clean start instead. Only the mail wire is stood in for
 * (`sendBoundedMail`), so what is asserted is who is written to, what is said,
 * what is recorded and when it is tried again.
 *
 * The names `sendKeyAlert(state)` and `sendKeyRestoredNotice()` (module
 * `@/server/key-alert`) are the tests' choice: the design names the behaviour
 * and not the functions.
 *
 * Owner answers on #1405: no fallback to the public contact address (log
 * only when OPERATOR_ALERT_ADDRESS is unset), and one "working again" mail
 * after the first clean start that follows an alert. The 24-hour repeat and
 * the hourly retry went with #1629: neither could ever reach the wire.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { log } from "@/lib/logger";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

const mocks = vi.hoisted(() => ({ sendBoundedMail: vi.fn() }));

vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: mocks.sendBoundedMail,
}));

/* Loaded when a case runs, so a missing module fails that case with that
   reason instead of keeping the whole file from loading. */
type KeyAlertModule = typeof import("@/server/key-alert");
const sendKeyAlert = async (...args: Parameters<KeyAlertModule["sendKeyAlert"]>) =>
  (await import("@/server/key-alert")).sendKeyAlert(...args);
const sendKeyRestoredNotice = async () => (await import("@/server/key-alert")).sendKeyRestoredNotice();

const ALERT = "encryption_key_alert_sent";
const HELD_ROW = "encryption_key_alert_held";
const RESTORED = "encryption_key_restored";
const HELD = "0123456789abcdef01234567";
const STORED = "fedcba9876543210fedcba98";
const OTHER_STORED = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OPERATOR = "operator@example.invalid";
const KEK = "ab".repeat(32);

const mismatch = { verdict: "unusable", reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED } as const;
const missing = { verdict: "unusable", reason: "missing" } as const;

const sentOk = { sentAt: new Date(), sendError: null };

/* The fault row carries a short hash of the alert address (never the address),
   so a corrected address is a new fault (round 4, unit A). */
const addressHashOf = (address: string) => createHash("sha256").update(address).digest("hex").slice(0, 16);
const OPERATOR_HASH = addressHashOf(OPERATOR);

async function rows(action: string) {
  return getDb().select().from(auditLog).where(eq(auditLog.action, action));
}

async function priorRow(action: string, hoursAgo: number, changes: Record<string, unknown>) {
  await getDb().insert(auditLog).values({
    householdId: null,
    actorUserId: null,
    entityType: "instance_authority",
    entityId: randomUUID(),
    action,
    changes,
    createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
  });
}

const infoLines = () => vi.mocked(log.info).mock.calls.map(([entry]) => entry as unknown as Record<string, unknown>);
const warnLines = () => vi.mocked(log.warn).mock.calls.map(([entry]) => entry as unknown as Record<string, unknown>);

beforeEach(() => {
  mocks.sendBoundedMail.mockReset();
  mocks.sendBoundedMail.mockResolvedValue(sentOk);
  vi.stubEnv("OPERATOR_ALERT_ADDRESS", OPERATOR);
  vi.stubEnv("DOCUMENT_KEK", KEK);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await getDb().delete(auditLog).where(inArray(auditLog.action, [ALERT, HELD_ROW, RESTORED]));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("the alert while the key is unusable (#1405 section 5, as #1629 left it)", () => {
  /* #1629: the sending password is encrypted under the very key that is
     unusable, so the alert itself is never mailed (ADR-0017 amendment "One
     alert cannot mail"). What is kept is a held record, once per fault, so
     the first clean start tells the operator. */
  it.each([
    ["mismatch", mismatch],
    ["missing", missing],
    ["unreadable", { verdict: "unusable", reason: "unreadable" }],
  ] as const)("mails nothing for a %s key, records the fault as held, and records nothing as sent", async (_name, state) => {
    await sendKeyAlert(state as never);

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(await rows(ALERT)).toHaveLength(0);
    const held = await rows(HELD_ROW);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ entityType: "instance_authority", householdId: null, actorUserId: null });
    expect(held[0].changes).toMatchObject({ reason: (state as { reason: string }).reason });
  });

  it("keeps the key ids of a wrong key with the fault, and never the key, its path or the address", async () => {
    vi.stubEnv("DOCUMENT_KEK_FILE", "/run/secrets/orbit-kek-private-path");

    await sendKeyAlert(mismatch);

    const [held] = await rows(HELD_ROW);
    expect(held.changes).toMatchObject({ reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED, addressHash: OPERATOR_HASH });
    const recorded = JSON.stringify(held.changes);
    expect(recorded).not.toContain(KEK);
    expect(recorded).not.toContain("orbit-kek-private-path");
    expect(recorded).not.toContain(OPERATOR);
  });

  it("says in the log that it was not mailed and where the fault shows instead", async () => {
    await sendKeyAlert(mismatch);

    expect(infoLines()).toContainEqual(expect.objectContaining({
      event: "encryption.key",
      state: "blocked",
      reason: "key_unavailable",
      action: "check_configuration",
      impact: "none",
      detail: expect.stringMatching(/not mailed.*Administration.*health check/iu),
    }));
  });

  it("records the same fault once, however many starts see it", async () => {
    await sendKeyAlert(mismatch);
    await sendKeyAlert(mismatch);
    await sendKeyAlert(mismatch);

    expect(await rows(HELD_ROW)).toHaveLength(1);
  });

  it("records a different fault at once: the operator tried another wrong key", async () => {
    await priorRow(HELD_ROW, 1, { reason: "mismatch", heldKeyId: HELD, storedKeyId: OTHER_STORED, addressHash: OPERATOR_HASH });

    await sendKeyAlert(mismatch);

    expect(await rows(HELD_ROW)).toHaveLength(2);
  });

  it("records a fault again once it was recorded as restored in between", async () => {
    await priorRow(HELD_ROW, 2, { reason: "missing", addressHash: OPERATOR_HASH });
    await priorRow(RESTORED, 1, {});

    await sendKeyAlert(missing);

    expect(await rows(HELD_ROW)).toHaveLength(2);
  });

  it("arms no timer: waiting does not make the sending password readable", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");

    await sendKeyAlert(mismatch);

    expect((timers.mock.calls as Array<[unknown, number | undefined]>).filter(([, delay]) => (delay ?? 0) >= 3_600_000)).toEqual([]);
  });

  it("only logs, and records nothing, when there is no alert address (no fallback to the public contact address)", async () => {
    vi.stubEnv("OPERATOR_ALERT_ADDRESS", "");

    await sendKeyAlert(mismatch);

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(await rows(HELD_ROW)).toHaveLength(0);
    expect(infoLines()).toContainEqual(expect.objectContaining({
      event: "encryption.key",
      state: "degraded",
      reason: "not_configured",
      action: "repair_configuration",
      impact: "none",
    }));
  });

  it("says an alert address that is not an address is invalid, not missing", async () => {
    vi.stubEnv("OPERATOR_ALERT_ADDRESS", "not-an-address");

    await sendKeyAlert(mismatch);

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(await rows(HELD_ROW)).toHaveLength(0);
    expect(infoLines()).toContainEqual(expect.objectContaining({
      reason: "configuration_optional",
      setting: "alerts",
      detail: expect.stringMatching(/not a valid address/iu),
    }));
    expect(infoLines().map((line) => String(line.detail ?? ""))).not.toContainEqual(expect.stringMatching(/no OPERATOR_ALERT_ADDRESS/u));
    expect(JSON.stringify([...infoLines(), ...warnLines()])).not.toContain("not-an-address");
  });

  it("does nothing for a usable verdict", async () => {
    await sendKeyAlert({ verdict: "usable" } as never);

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(await rows(HELD_ROW)).toHaveLength(0);
  });
});

describe("the all-clear (#1405, owner answer 10a)", () => {
  it("sends one 'working again' mail to the operator after the first clean start that follows an alert, and records it", async () => {
    await priorRow(ALERT, 3, { reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });

    await sendKeyRestoredNotice();

    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    const [to, mail] = mocks.sendBoundedMail.mock.calls[0] as [string, { subject: string; text: string }];
    expect(to).toBe(OPERATOR);
    expect(mail.subject).toMatch(/encryption key/iu);
    expect(`${mail.subject}\n${mail.text}`).toMatch(/\b(back|working again)\b/iu);
    expect(mail.text).not.toContain(KEK);
    expect(await rows(RESTORED)).toHaveLength(1);
  });

  it("sends it only once: a second clean start finds the all-clear already recorded", async () => {
    await priorRow(ALERT, 3, { reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });

    await sendKeyRestoredNotice();
    await sendKeyRestoredNotice();

    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    expect(await rows(RESTORED)).toHaveLength(1);
  });

  it("after a fault that was held, not mailed, sends one notice that says what was wrong and why it could not mail", async () => {
    await priorRow(HELD_ROW, 3, { reason: "missing", addressHash: OPERATOR_HASH });

    await sendKeyRestoredNotice();
    await sendKeyRestoredNotice();

    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    const [to, mail] = mocks.sendBoundedMail.mock.calls[0] as [string, { subject: string; text: string }];
    expect(to).toBe(OPERATOR);
    expect(mail.subject).toBe("Orbit's encryption key is working again");
    expect(mail.text).toContain("missing");
    expect(mail.text).toMatch(/could not mail you/iu);
    expect(mail.text).toContain("Nothing was lost");
    expect(mail.text).toContain(new URL(process.env.APP_URL ?? "http://127.0.0.1:3000").origin);
    expect(mail.text).not.toContain(KEK);
    expect(await rows(RESTORED)).toHaveLength(1);
  });

  it.each([
    ["missing", "missing"],
    ["unreadable", "unreadable"],
    ["malformed", "malformed"],
    ["both_forms", "set twice"],
    ["mismatch", "not the key this database was written under"],
  ] as const)("calls a held %s key %s in the notice", async (reason, phrase) => {
    await priorRow(HELD_ROW, 3, { reason, addressHash: OPERATOR_HASH });

    await sendKeyRestoredNotice();

    const mail = (mocks.sendBoundedMail.mock.calls[0] as [string, { subject: string; text: string }])[1];
    expect(mail.text).toContain(phrase);
  });

  it("never carries the key, a path to it, or a private address in the notice", async () => {
    vi.stubEnv("DOCUMENT_KEK_FILE", "/run/secrets/orbit-kek-private-path");
    await priorRow(HELD_ROW, 3, { reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED, addressHash: OPERATOR_HASH });

    await sendKeyRestoredNotice();

    const mail = (mocks.sendBoundedMail.mock.calls[0] as [string, { subject: string; text: string }])[1];
    expect(mail.text).not.toContain(KEK);
    expect(mail.text).not.toContain("orbit-kek-private-path");
    expect(mail.text).not.toMatch(/\b(?:10|192\.168)\.\d+\.\d+(?:\.\d+)?\b/u);
  });

  it("leaves the notice for the next start, and records nothing, when it cannot be sent", async () => {
    await priorRow(HELD_ROW, 3, { reason: "missing", addressHash: OPERATOR_HASH });
    mocks.sendBoundedMail.mockResolvedValueOnce({ sentAt: null, sendError: "smtp_unavailable" });

    await sendKeyRestoredNotice();
    expect(await rows(RESTORED)).toHaveLength(0);
    expect(warnLines()).toContainEqual(expect.objectContaining({ event: "delivery.smtp", reason: "smtp_unavailable" }));

    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(2);
    expect(await rows(RESTORED)).toHaveLength(1);
  });

  it("sends nothing when there was never an alert", async () => {
    await sendKeyRestoredNotice();

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(await rows(RESTORED)).toHaveLength(0);
  });

  it("sends it again for a later alert, and not before", async () => {
    await priorRow(ALERT, 48, { reason: "missing" });
    await priorRow(RESTORED, 40, {});
    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();

    await priorRow(ALERT, 1, { reason: "missing" });
    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
  });

  it("says nothing to anyone when there is no alert address", async () => {
    await priorRow(ALERT, 3, { reason: "missing" });
    vi.stubEnv("OPERATOR_ALERT_ADDRESS", "");

    await sendKeyRestoredNotice();

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
  });

  it("does not look at, or record anything about, a different action", async () => {
    await getDb().insert(auditLog).values({
      householdId: null, actorUserId: null, entityType: "instance_authority", entityId: randomUUID(),
      action: "mail_in_credential_locked", changes: {}, createdAt: new Date(Date.now() - 3_600_000),
    });

    await sendKeyRestoredNotice();

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    await getDb().delete(auditLog).where(and(eq(auditLog.action, "mail_in_credential_locked")));
  });
});

describe("key alert survives database errors (#1316 r5 U1)", () => {
  const SECRET_TEXT = "db-failure-text-that-must-not-be-logged";

  it("a fault record that throws is one warning without the error text, and never a mail or a throw", async () => {
    vi.spyOn(getDb(), "insert").mockImplementationOnce(() => {
      throw new Error(SECRET_TEXT);
    });

    await expect(sendKeyAlert(mismatch)).resolves.toBeUndefined();

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    const keyWarnings = warnLines().filter((line) => line.event === "encryption.key");
    expect(keyWarnings, "expected exactly one encryption.key warning").toHaveLength(1);
    expect(JSON.stringify([...warnLines(), ...infoLines()])).not.toContain(SECRET_TEXT);
  });

  it("a read that throws is one warning without the error text", async () => {
    vi.spyOn(getDb(), "select").mockImplementationOnce(() => {
      throw new Error(SECRET_TEXT);
    });

    await expect(sendKeyAlert(mismatch)).resolves.toBeUndefined();

    expect(warnLines().filter((line) => line.event === "encryption.key")).toHaveLength(1);
    expect(JSON.stringify([...warnLines(), ...infoLines()])).not.toContain(SECRET_TEXT);
  });
});
