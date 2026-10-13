/**
 * The alert mail for a locked instance (#1405, design section 5), against a
 * real PostgreSQL for the one thing it keeps there: an `audit_log` row that
 * says "already sent", which is what makes the alert once per fault and at most
 * once a day across restarts. Only the mail wire is stood in for
 * (`sendBoundedMail`), so what is asserted is who is written to, what is said,
 * what is recorded and when it is tried again.
 *
 * The names `sendKeyAlert(state)` and `sendKeyRestoredNotice()` (module
 * `@/server/key-alert`) are the tests' choice: the design names the behaviour
 * and not the functions.
 *
 * Owner answers on #1405: no fallback to the public contact address (log
 * only when OPERATOR_ALERT_ADDRESS is unset), one "working again" mail after
 * the first clean start that follows an alert, and a repeat at most once in
 * 24 hours.
 */
import { randomUUID } from "node:crypto";
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
const RESTORED = "encryption_key_restored";
const HELD = "0123456789abcdef01234567";
const STORED = "fedcba9876543210fedcba98";
const OTHER_STORED = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OPERATOR = "operator@example.invalid";
const KEK = "ab".repeat(32);

const mismatch = { verdict: "unusable", reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED } as const;
const missing = { verdict: "unusable", reason: "missing" } as const;

const sentOk = { sentAt: new Date(), sendError: null };

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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await getDb().delete(auditLog).where(inArray(auditLog.action, [ALERT, RESTORED]));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("the alert (#1405 section 5)", () => {
  it("writes once to the operator's own address, and records that it did", async () => {
    await sendKeyAlert(mismatch);

    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    const [to, mail] = mocks.sendBoundedMail.mock.calls[0] as [string, { subject: string; text: string }];
    expect(to).toBe(OPERATOR);
    expect(mail.subject).toBe("Orbit is locked: its encryption key needs attention");

    const recorded = await rows(ALERT);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ entityType: "instance_authority", householdId: null, actorUserId: null });
    expect(recorded[0].changes).toMatchObject({ reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });
  });

  it("says what is wrong, what is not, what to do, and that it will repeat; for a wrong key it gives both ids", async () => {
    await sendKeyAlert(mismatch);

    const mail = (mocks.sendBoundedMail.mock.calls[0] as [string, { subject: string; text: string }])[1];
    expect(mail.text).toContain("cannot open anyone's records or sign anyone in");
    expect(mail.text).toContain("Nothing is lost");
    expect(mail.text).toContain("administrators included");
    expect(mail.text).toContain("restarted");
    expect(mail.text).toContain("Restoring the document key-encryption key");
    expect(mail.text).toContain("24 hours");
    expect(mail.text).toContain("not the key this database was written under");
    expect(mail.text).toContain(HELD);
    expect(mail.text).toContain(STORED);
    expect(mail.text).toContain(new URL(process.env.APP_URL ?? "http://127.0.0.1:3000").origin);
  });

  it.each([
    ["missing", "missing"],
    ["unreadable", "unreadable"],
    ["malformed", "malformed"],
    ["both_forms", "set twice"],
  ] as const)("calls a %s key %s, and names no key id (there is none to name)", async (reason, phrase) => {
    await sendKeyAlert({ verdict: "unusable", reason } as never);

    const mail = (mocks.sendBoundedMail.mock.calls[0] as [string, { subject: string; text: string }])[1];
    expect(mail.text).toContain(phrase);
    expect(mail.text).not.toContain("the database was written under");
  });

  it("never carries the key, a path to it, or a private address", async () => {
    vi.stubEnv("DOCUMENT_KEK_FILE", "/run/secrets/orbit-kek-private-path");

    await sendKeyAlert(mismatch);
    await sendKeyAlert({ verdict: "unusable", reason: "unreadable" } as never);

    for (const [, mail] of mocks.sendBoundedMail.mock.calls as Array<[string, { subject: string; text: string }]>) {
      expect(mail.text).not.toContain(KEK);
      expect(mail.text).not.toContain("orbit-kek-private-path");
      expect(mail.text).not.toMatch(/\b(?:10|192\.168)\.\d+\.\d+(?:\.\d+)?\b/u);
    }
    expect(JSON.stringify(await rows(ALERT))).not.toContain(KEK);
  });

  describe("not twice in a day", () => {
    it("does not repeat a fault already alerted 23 hours ago, and says so in the log", async () => {
      await priorRow(ALERT, 23, { reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });

      await sendKeyAlert(mismatch);

      expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
      expect(await rows(ALERT)).toHaveLength(1);
      expect(infoLines()).toContainEqual(expect.objectContaining({
        event: "encryption.key",
        state: "blocked",
        reason: "key_unavailable",
        action: "check_configuration",
        impact: "none",
      }));
    });

    it("repeats it once 25 hours have passed", async () => {
      await priorRow(ALERT, 25, { reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });

      await sendKeyAlert(mismatch);

      expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
      expect(await rows(ALERT)).toHaveLength(2);
    });

    it("alerts at once for a different fault: the operator tried another wrong key", async () => {
      await priorRow(ALERT, 1, { reason: "mismatch", heldKeyId: HELD, storedKeyId: OTHER_STORED });

      await sendKeyAlert(mismatch);

      expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    });

    it("alerts at once when the reason changes from one kind to another", async () => {
      await priorRow(ALERT, 1, { reason: "missing" });

      await sendKeyAlert(mismatch);

      expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    });

    it("holds a key that is missing to the same day as any other", async () => {
      await priorRow(ALERT, 2, { reason: "missing" });

      await sendKeyAlert(missing);

      expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    });
  });

  describe("when it cannot be sent", () => {
    it("only logs, and sends nothing, when there is no alert address (no fallback to the public contact address)", async () => {
      vi.stubEnv("OPERATOR_ALERT_ADDRESS", "");

      await sendKeyAlert(mismatch);

      expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
      expect(await rows(ALERT)).toHaveLength(0);
      expect(infoLines()).toContainEqual(expect.objectContaining({
        event: "encryption.key",
        state: "degraded",
        reason: "not_configured",
        action: "repair_configuration",
        impact: "none",
      }));
    });

    it("only logs, with no timer, when outbound mail is not configured", async () => {
      mocks.sendBoundedMail.mockResolvedValue({ sentAt: null, sendError: "smtp_unconfigured" });
      const timers = vi.spyOn(globalThis, "setTimeout");

      await sendKeyAlert(mismatch);

      expect(await rows(ALERT)).toHaveLength(0);
      expect(infoLines()).toContainEqual(expect.objectContaining({
        event: "encryption.key",
        state: "degraded",
        reason: "smtp_unconfigured",
        action: "repair_configuration",
        impact: "none",
      }));
      expect(timers.mock.calls.filter(([, delay]) => delay === 3_600_000)).toEqual([]);
    });

    it.each(["smtp_unavailable", "smtp_rejected", "unknown"] as const)("records nothing after %s, says it will retry, and tries again in an hour", async (sendError) => {
      mocks.sendBoundedMail.mockResolvedValueOnce({ sentAt: null, sendError });
      const timers = vi.spyOn(globalThis, "setTimeout");

      await sendKeyAlert(mismatch);

      expect(await rows(ALERT)).toHaveLength(0);
      expect(warnLines()).toContainEqual(expect.objectContaining({
        event: "delivery.smtp",
        state: "retrying",
        reason: sendError,
        action: "check_configuration",
        impact: "none",
      }));
      const retry = timers.mock.calls.find(([, delay]) => delay === 3_600_000);
      expect(retry, "no one-hour retry was scheduled").toBeDefined();

      // The hour passes and the mail now goes through.
      await (retry![0] as () => unknown)();
      await vi.waitFor(() => expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect(await rows(ALERT)).toHaveLength(1));
    });

    it("does not hold the process open for its retry", async () => {
      mocks.sendBoundedMail.mockResolvedValueOnce({ sentAt: null, sendError: "smtp_unavailable" });
      const timers = vi.spyOn(globalThis, "setTimeout");

      await sendKeyAlert(mismatch);

      const index = timers.mock.calls.findIndex(([, delay]) => delay === 3_600_000);
      expect(index).toBeGreaterThanOrEqual(0);
      const handle = timers.mock.results[index].value as { hasRef?: () => boolean };
      expect(handle.hasRef?.()).toBe(false);
    });

    it("says it was sent, once, when it was", async () => {
      await sendKeyAlert(mismatch);

      expect(infoLines()).toContainEqual(expect.objectContaining({
        event: "delivery.smtp",
        state: "completed",
        action: "none",
      }));
    });
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
