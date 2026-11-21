import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { signInApprovals, signInApprovalSends } from "@/db/schema";
import { createLocalUserAndSendSetupLink } from "@/server/local-credentials/setup-mail";
import type { SmtpNotification } from "@/server/notification-worker";
import { resendSignInApproval, startSignInApproval } from "@/server/sign-in-approvals";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";

/**
 * SIGN-IN APPROVAL SEND ACCOUNTING (#1915 A-F1, A-F2).
 *
 * Written from the specification alone.
 *
 * A-F1: the hourly slot is reserved before the mail is built. When the
 * attempt ends before any mail is handed to the mailer (no usable APP_URL),
 * the reservation is released and the hour's count is unchanged. When the
 * outcome is genuinely unknown (handed to SMTP, reply lost) the slot stays:
 * never undercount.
 *
 * A-F2: after a refused resend puts the earlier send time back, the returned
 * "next resend at" runs from that restored time, not from now.
 */

const FACTS = { userAgent: null, clientAddress: null };
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let fixture: IntegrationFixture;

beforeEach(async () => { fixture = await createIntegrationFixture("sign-in-approval-send-accounting-1915"); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.cleanup();
});
afterAll(async () => { await cleanupIntegrationEnvironment(); });

async function account(): Promise<string> {
  const created = await createLocalUserAndSendSetupLink(
    fixture.users.admin.id,
    { email: `acct-${crypto.randomUUID()}@example.invalid`, displayName: "Accounting Person" },
    { mailer: { async sendEmail() {} } },
  );
  return created.user.id;
}

/** A pending approval last mailed `secondsAgo` seconds ago. */
async function pending(userId: string, secondsAgo = 600) {
  const claim = crypto.randomUUID();
  const lastSentAt = new Date(Date.now() - secondsAgo * 1000);
  const [row] = await getDb().insert(signInApprovals).values({
    userId,
    tokenHash: sha(crypto.randomUUID()),
    claimHash: sha(claim),
    expiresAt: new Date(Date.now() + 3_600_000),
    sendCount: 1,
    lastSentAt,
  }).returning({ id: signInApprovals.id });
  return { id: row.id, claim, lastSentAt };
}

async function sendsInTheHour(userId: string): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(signInApprovalSends)
    .where(and(eq(signInApprovalSends.userId, userId), gt(signInApprovalSends.sentAt, new Date(Date.now() - 3_600_000))));
  return row.n;
}

const neverCalled = {
  calls: 0,
  async sendEmail() { neverCalled.calls += 1; },
};
const timingOut = {
  async sendEmail(_: SmtpNotification) { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); },
};
const refusing = {
  async sendEmail(_: SmtpNotification) {
    throw Object.assign(new Error("relay refused"), { code: "EENVELOPE", responseCode: 550 });
  },
};

describe("#1915 A-F1: a slot is given back when no mail was handed to the mailer", () => {
  it("open: with no usable APP_URL the hour's count is unchanged and the mailer is not called", async () => {
    const userId = await account();
    neverCalled.calls = 0;
    vi.stubEnv("APP_URL", "");

    const result = await startSignInApproval(userId, FACTS, { mailer: neverCalled });

    expect(result).toMatchObject({ limited: false, sendError: "unknown" });
    expect(neverCalled.calls).toBe(0);
    expect(await sendsInTheHour(userId)).toBe(0);
  }, 60_000);

  it("open: repeated attempts that never build a mail are never answered limited", async () => {
    const userId = await account();
    vi.stubEnv("APP_URL", "");
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const result = await startSignInApproval(userId, FACTS, { mailer: neverCalled });
      expect(result, `attempt ${attempt}`).toMatchObject({ limited: false, sendError: "unknown" });
    }
    expect(await sendsInTheHour(userId)).toBe(0);
  }, 60_000);

  it("resend: with no usable APP_URL the hour's count is unchanged", async () => {
    const userId = await account();
    const approval = await pending(userId);
    vi.stubEnv("APP_URL", "");

    const result = await resendSignInApproval(approval.claim, { mailer: neverCalled });

    expect(result).toMatchObject({ state: "sent", sendError: "unknown" });
    expect(await sendsInTheHour(userId)).toBe(0);
  }, 60_000);
});

describe("#1915 A-F1: a slot stays counted when the outcome is unknown (never undercount)", () => {
  it("open: a mail handed to SMTP whose reply is lost keeps its slot", async () => {
    const userId = await account();
    const result = await startSignInApproval(userId, FACTS, { mailer: timingOut });
    expect(result).toMatchObject({ limited: false });
    expect(result.sendError).not.toBeNull();
    expect(await sendsInTheHour(userId)).toBe(1);
  }, 60_000);

  it("resend: a mail handed to SMTP whose reply is lost keeps its slot", async () => {
    const userId = await account();
    const approval = await pending(userId);
    await resendSignInApproval(approval.claim, { mailer: timingOut });
    expect(await sendsInTheHour(userId)).toBe(1);
  }, 60_000);
});

describe("#1915 A-F2: the next resend time runs from a restored send time", () => {
  it("a refused resend returns the restored time plus one minute, not now plus one minute", async () => {
    const userId = await account();
    const approval = await pending(userId, 600);
    const before = Date.now();

    const result = await resendSignInApproval(approval.claim, { mailer: refusing });

    expect(result.state).toBe("sent");
    if (result.state !== "sent") return;
    expect(result.sendError).not.toBeNull();
    const [row] = await getDb().select({ lastSentAt: signInApprovals.lastSentAt }).from(signInApprovals)
      .where(eq(signInApprovals.id, approval.id));
    expect(row.lastSentAt?.getTime()).toBe(approval.lastSentAt.getTime());
    expect(result.canResendAt.getTime()).toBe(approval.lastSentAt.getTime() + 60_000);
    expect(result.canResendAt.getTime()).toBeLessThanOrEqual(before);
  }, 60_000);

  it("a resend that went keeps now plus one minute (stays true)", async () => {
    const userId = await account();
    const approval = await pending(userId, 600);
    const before = Date.now();
    const result = await resendSignInApproval(approval.claim, { mailer: { async sendEmail() {} } });
    expect(result).toMatchObject({ state: "sent", sendError: null });
    if (result.state !== "sent") return;
    expect(result.canResendAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  }, 60_000);
});
