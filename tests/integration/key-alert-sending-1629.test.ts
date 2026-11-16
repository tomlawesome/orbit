/**
 * #1629 and the key alert (`src/server/key-alert.ts`, #1405): the sending
 * password is encrypted under the document KEK, so while the KEK is missing
 * the key alert cannot be mailed. It shows on Administration and in the
 * launcher's health check instead, and the mail goes out when the key is
 * back (design note 54742, ADR-0017 amendment "One alert cannot mail").
 *
 * Unlike tests/integration/key-alert.test.ts this does not stand in for
 * `sendBoundedMail`: the real one runs against a real sending row, and only
 * nodemailer's `createTransport` is replaced, so "not mailed" means no
 * message reached the wire, by any route (the row or a stale `SMTP_*`).
 *
 * Reading chosen: "the mail goes out when the key is back" is the first
 * clean start's mail to the operator address (`sendKeyRestoredNotice()`),
 * which must now go even though the locked alert itself was never sent, and
 * only once.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { log } from "@/lib/logger";
import { cleanupIntegrationEnvironment, createIntegrationFixture, lockTheInstance, type IntegrationFixture } from "./support/fixtures";
import { anotherAccount, clearMailState, fakeTransporter, sending, targetOf } from "./support/mail-sending-1629";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nodemailer")>();
  const replaced = { ...actual, createTransport: mocks.createTransport };
  return { ...replaced, default: { ...actual.default, createTransport: mocks.createTransport } };
});

const { sendKeyAlert, sendKeyRestoredNotice } = await import("@/server/key-alert");

const OPERATOR = "operator@orbit-test.example";
const ALERT = "encryption_key_alert_sent";

let fixture: IntegrationFixture;
let sent: Array<{ target: ReturnType<typeof targetOf>; message: Record<string, unknown> }>;

beforeEach(async () => {
  fixture = await createIntegrationFixture("key-alert-1629");
  sent = [];
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
  vi.stubEnv("OPERATOR_ALERT_ADDRESS", OPERATOR);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  /* Sending is set from the screen while the key is present... */
  const { setSendingSettings } = await sending();
  await setSendingSettings(fixture.users.admin.id, null, anotherAccount);
  /* ...and the install still carries complete SMTP_* lines, which must not
     become a back door for the alert. */
  vi.stubEnv("SMTP_HOST", "smtp.stale-env.example");
  vi.stubEnv("SMTP_USER", "stale-user@stale-env.example");
  vi.stubEnv("SMTP_PASSWORD", "fake-stale-env-pass");
  vi.stubEnv("SMTP_FROM", "Stale <stale@stale-env.example>");
  sent = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await clearMailState();
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("the key-missing alert (#1629)", () => {
  it("is not mailed while the key is missing, by the row or by SMTP_*, and is not recorded as sent", async () => {
    const restore = lockTheInstance();
    try {
      await sendKeyAlert({ verdict: "unusable", reason: "missing" });
    } finally {
      restore();
    }

    expect(sent).toEqual([]);
    expect(await getDb().select().from(auditLog).where(eq(auditLog.action, ALERT))).toHaveLength(0);
  });

  it("goes out to the operator once the key is back, and only once", async () => {
    const restore = lockTheInstance();
    try {
      await sendKeyAlert({ verdict: "unusable", reason: "missing" });
    } finally {
      restore();
    }
    expect(sent).toEqual([]);

    await sendKeyRestoredNotice();

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({ to: OPERATOR, from: "Orbit <orbit@orbit-test.example>" });
    expect(sent[0].target).toMatchObject({ host: "smtp.relay.example", user: "relay-user" });

    /* A second clean start says nothing more. */
    await sendKeyRestoredNotice();
    expect(sent).toHaveLength(1);
  });

  it("other mail still goes: the working-again notice after an alert that was mailed is sent through the row", async () => {
    await getDb().insert(auditLog).values({
      householdId: null,
      actorUserId: null,
      entityType: "instance_authority",
      entityId: randomUUID(),
      action: ALERT,
      changes: { reason: "mismatch" },
      createdAt: new Date(Date.now() - 3_600_000),
    });

    await sendKeyRestoredNotice();

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({ to: OPERATOR, subject: "Orbit's encryption key is working again" });
    expect(sent[0].target).toMatchObject({ host: "smtp.relay.example", user: "relay-user" });
  });
});
