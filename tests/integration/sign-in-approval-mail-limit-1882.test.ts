import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { signInApprovals, signInApprovalSends } from "@/db/schema";
import { createLocalUserAndSendSetupLink } from "@/server/local-credentials/setup-mail";
import type { SmtpNotification } from "@/server/notification-worker";
import {
  APPROVAL_SENDS_PER_HOUR,
  resendSignInApproval,
  startSignInApproval,
  type ResendOutcome,
} from "@/server/sign-in-approvals";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";

/**
 * THE HOURLY SIGN-IN APPROVAL MAIL LIMIT HOLDS UNDER CONCURRENCY (#1882,
 * ADR-0027 section 8: five mails per account per hour).
 *
 * Written from the issue alone. The count is read, the mail goes, and only
 * then is the send recorded, so requests arriving together all read the same
 * count and all send. The check and the reservation must be one atomic step
 * (a per-user lock, or a conditional insert) whatever the interleaving.
 *
 * MAKING THE RACE FIRE. The mailer is the hook: every mail takes `MAIL_DELAY_MS`
 * to leave, which holds the code between "count read" and "send recorded"
 * open while the other calls read their counts. On the unfixed code every
 * call therefore passes the check. A correct fix may hold its lock across the
 * send (calls then queue and run one after another) or reserve before the
 * send; both stay inside the limit, so neither is penalised here.
 */

const MAIL_DELAY_MS = 250;
const CALLS = 6; // fewer than the pool's ten connections, more than the one slot left
const ROUNDS = 3;
const FACTS = { userAgent: null, clientAddress: null };

let fixture: IntegrationFixture;
let delivered: string[];

const slowMailer = {
  async sendEmail(notification: SmtpNotification) {
    await new Promise((resolve) => setTimeout(resolve, MAIL_DELAY_MS));
    delivered.push(notification.to);
  },
};

beforeEach(async () => {
  fixture = await createIntegrationFixture("sign-in-approval-mail-limit-1882");
  delivered = [];
});
afterEach(async () => { await fixture.cleanup(); });
afterAll(async () => { await cleanupIntegrationEnvironment(); });

async function account(): Promise<string> {
  const created = await createLocalUserAndSendSetupLink(
    fixture.users.admin.id,
    { email: `limit-${crypto.randomUUID()}@example.invalid`, displayName: "Limit Person" },
    { mailer: { async sendEmail() {} } },
  );
  return created.user.id;
}

/** A pending approval with a known claim, as if mailed long enough ago to be resent. */
async function pending(userId: string): Promise<{ id: string; claim: string }> {
  const claim = crypto.randomUUID();
  const [row] = await getDb().insert(signInApprovals).values({
    userId,
    tokenHash: crypto.randomUUID(),
    claimHash: createHash("sha256").update(claim, "utf8").digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
    sendCount: 1,
    lastSentAt: new Date(Date.now() - 10 * 60_000),
  }).returning({ id: signInApprovals.id });
  return { id: row.id, claim };
}

/** `count` mails already sent in the last hour (ten minutes ago each). */
async function alreadySent(userId: string, count: number): Promise<void> {
  if (count === 0) return;
  const history = await pending(userId);
  await getDb().insert(signInApprovalSends).values(
    Array.from({ length: count }, () => ({ approvalId: history.id, userId, sentAt: new Date(Date.now() - 10 * 60_000) })),
  );
}

async function sendsInTheHour(userId: string): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(signInApprovalSends)
    .where(and(eq(signInApprovalSends.userId, userId), gt(signInApprovalSends.sentAt, new Date(Date.now() - 3_600_000))));
  return row.n;
}

const open = (userId: string) => startSignInApproval(userId, FACTS, { mailer: slowMailer });
const resend = (claim: string) => resendSignInApproval(claim, { mailer: slowMailer });
const isLimitedResend = (outcome: ResendOutcome) => outcome.state === "limited";

describe("the hourly approval mail limit, one request at a time (stays true)", () => {
  it("sends and records one mail when none have gone this hour", async () => {
    const userId = await account();
    const result = await open(userId);
    expect(result).toMatchObject({ limited: false, sendError: null });
    expect(delivered).toHaveLength(1);
    expect(await sendsInTheHour(userId)).toBe(1);
  }, 60_000);

  it("sends the fifth mail and refuses the sixth, open and resend alike", async () => {
    const userId = await account();
    await alreadySent(userId, APPROVAL_SENDS_PER_HOUR - 1);
    expect(await open(userId)).toMatchObject({ limited: false, sendError: null });
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);

    expect(await open(userId)).toMatchObject({ limited: true });
    const another = await pending(userId);
    expect(isLimitedResend(await resend(another.claim))).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);
  }, 60_000);
});

describe("the hourly approval mail limit under concurrent requests (#1882)", () => {
  it("open path: with four sent, at most one of several simultaneous requests sends", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await account();
      await alreadySent(userId, APPROVAL_SENDS_PER_HOUR - 1);

      const results = await Promise.all(Array.from({ length: CALLS }, () => open(userId)));

      expect(delivered, `round ${round}`).toHaveLength(1);
      expect(await sendsInTheHour(userId), `round ${round}`).toBe(APPROVAL_SENDS_PER_HOUR);
      expect(results.filter((result) => !result.limited && result.sendError === null)).toHaveLength(1);
      expect(results.filter((result) => result.limited)).toHaveLength(CALLS - 1);
      delivered = [];
    }
  }, 120_000);

  it("resend path: with four sent, at most one of several simultaneous resends sends", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await account();
      await alreadySent(userId, APPROVAL_SENDS_PER_HOUR - 1);
      const approvals = await Promise.all(Array.from({ length: CALLS }, () => pending(userId)));

      const results = await Promise.all(approvals.map((approval) => resend(approval.claim)));

      expect(delivered, `round ${round}`).toHaveLength(1);
      expect(await sendsInTheHour(userId), `round ${round}`).toBe(APPROVAL_SENDS_PER_HOUR);
      expect(results.filter((result) => result.state === "sent" && result.sendError === null)).toHaveLength(1);
      expect(results.filter(isLimitedResend)).toHaveLength(CALLS - 1);
      delivered = [];
    }
  }, 120_000);

  it("open and resend together: with four sent, the two paths share one remaining mail", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await account();
      await alreadySent(userId, APPROVAL_SENDS_PER_HOUR - 1);
      const approvals = await Promise.all(Array.from({ length: CALLS / 2 }, () => pending(userId)));

      const calls: Array<Promise<{ sent: boolean; limited: boolean }>> = [
        ...Array.from({ length: CALLS / 2 }, () => open(userId).then((r) => ({
          sent: !r.limited && r.sendError === null, limited: r.limited,
        }))),
        ...approvals.map((approval) => resend(approval.claim).then((r) => ({
          sent: r.state === "sent" && r.sendError === null, limited: isLimitedResend(r),
        }))),
      ];
      const results = await Promise.all(calls);

      expect(delivered, `round ${round}`).toHaveLength(1);
      expect(await sendsInTheHour(userId), `round ${round}`).toBe(APPROVAL_SENDS_PER_HOUR);
      expect(results.filter((result) => result.sent)).toHaveLength(1);
      expect(results.filter((result) => result.limited)).toHaveLength(CALLS - 1);
      delivered = [];
    }
  }, 120_000);

  it("from none sent, simultaneous opens never put more than five in the post", async () => {
    const userId = await account();
    const results = await Promise.all(Array.from({ length: 8 }, () => open(userId)));
    expect(delivered.length).toBeLessThanOrEqual(APPROVAL_SENDS_PER_HOUR);
    expect(await sendsInTheHour(userId)).toBeLessThanOrEqual(APPROVAL_SENDS_PER_HOUR);
    expect(results.filter((result) => !result.limited && result.sendError === null)).toHaveLength(delivered.length);
  }, 120_000);
});

/**
 * THE LOCK ITSELF. A mail's own delay sits after the reservation commits, so
 * it leaves only a millisecond between the count and the insert: a build
 * without the per-user lock could still pass by luck. Here a trigger on the
 * send table sleeps inside the transaction, after the count has been read and
 * before the row lands, widening that gap to `GAP_SECONDS`. Without the lock
 * every call reads the same count in that gap; with it they queue.
 */
const GAP_SECONDS = 0.3;

describe("the lock closes a wide gap between the count and the reservation (#1882)", () => {
  beforeEach(async () => {
    await getDb().execute(sql.raw(`
      create or replace function sign_in_sends_gap_1882() returns trigger language plpgsql as
      $$ begin perform pg_sleep(${GAP_SECONDS}); return new; end $$`));
    await getDb().execute(sql.raw(`
      create trigger sign_in_sends_gap_1882 before insert on sign_in_approval_sends
      for each row execute function sign_in_sends_gap_1882()`));
  });
  afterEach(async () => {
    await getDb().execute(sql.raw("drop trigger if exists sign_in_sends_gap_1882 on sign_in_approval_sends"));
    await getDb().execute(sql.raw("drop function if exists sign_in_sends_gap_1882()"));
  });

  it("open, resend and mixed calls with four sent reserve exactly one more", async () => {
    const userId = await account();
    await alreadySent(userId, APPROVAL_SENDS_PER_HOUR - 1);
    const approvals = await Promise.all(Array.from({ length: 3 }, () => pending(userId)));

    await Promise.all([
      ...Array.from({ length: 3 }, () => open(userId)),
      ...approvals.map((approval) => resend(approval.claim)),
    ]);

    expect(delivered).toHaveLength(1);
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);
  }, 120_000);

  it("from none sent, eight simultaneous opens reserve no more than five", async () => {
    const userId = await account();
    await Promise.all(Array.from({ length: 8 }, () => open(userId)));
    expect(delivered).toHaveLength(APPROVAL_SENDS_PER_HOUR);
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);
  }, 120_000);
});

/**
 * A mailer that fails the first `failures` mails it is asked for, and
 * delivers the rest; `asked` is every attempt that reached it.
 */
function flakyMailer(failures: number) {
  const mailer = {
    asked: 0,
    async sendEmail(notification: SmtpNotification) {
      const mine = mailer.asked++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (mine < failures) throw new Error("relay refused");
      delivered.push(notification.to);
    },
  };
  return mailer;
}

/*
 * Ruling on #1879 (note 64435), point 1: the limit counts attempts, not
 * successes. A send reported failed may still have been delivered (#1896),
 * so handing its slot back could under-count, the unsafe side of ADR-0027
 * section 8. A failed send keeps its row.
 */
describe("a failed send spends its slot (#1879, #1882)", () => {
  it("open: with four sent, a failed open leaves five rows and the next request answers limited", async () => {
    const userId = await account();
    await alreadySent(userId, APPROVAL_SENDS_PER_HOUR - 1);

    const failed = await startSignInApproval(userId, FACTS, { mailer: flakyMailer(1) });
    expect(failed.sendError).not.toBeNull();
    expect(failed.limited).toBe(false);
    expect(delivered).toHaveLength(0);
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);

    expect(await open(userId)).toMatchObject({ limited: true });
    expect(delivered).toHaveLength(0);
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);
  }, 60_000);

  it("resend: with four sent, a failed resend leaves five rows and the next resend answers limited", async () => {
    const userId = await account();
    await alreadySent(userId, APPROVAL_SENDS_PER_HOUR - 1);
    const first = await pending(userId);
    const second = await pending(userId);

    const failed = await resendSignInApproval(first.claim, { mailer: flakyMailer(1) });
    expect(failed).toMatchObject({ state: "sent" });
    expect((failed as { sendError: unknown }).sendError).not.toBeNull();
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);

    expect(isLimitedResend(await resend(second.claim))).toBe(true);
    expect(delivered).toHaveLength(0);
    expect(await sendsInTheHour(userId)).toBe(APPROVAL_SENDS_PER_HOUR);
  }, 60_000);

  it("a failure among concurrent sends: rows equal the attempts that reached the mailer, never more than five", async () => {
    const userId = await account();
    const mailer = flakyMailer(2);

    const results = await Promise.all(Array.from({ length: 8 }, () =>
      startSignInApproval(userId, FACTS, { mailer })));

    const failures = results.filter((result) => result.sendError !== null);
    expect(failures).toHaveLength(2);
    expect(mailer.asked).toBe(delivered.length + failures.length);
    expect(mailer.asked).toBeLessThanOrEqual(APPROVAL_SENDS_PER_HOUR);
    /* Every attempt keeps its row, delivered or failed, and nothing else
       has one. */
    const rows = await sendsInTheHour(userId);
    expect(rows).toBe(delivered.length + failures.length);
    expect(rows).toBeLessThanOrEqual(APPROVAL_SENDS_PER_HOUR);
  }, 120_000);
});
