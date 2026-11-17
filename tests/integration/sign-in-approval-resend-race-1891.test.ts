import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { signInApprovals } from "@/db/schema";
import { createLocalUserAndSendSetupLink } from "@/server/local-credentials/setup-mail";
import type { SmtpNotification } from "@/server/notification-worker";
import {
  decideSignInApproval,
  resendSignInApproval,
  type ResendOutcome,
} from "@/server/sign-in-approvals";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";

/**
 * CONCURRENT RESENDS OF ONE SIGN-IN APPROVAL SEND ONE WORKING LINK (#1891,
 * ADR-0027 section 8: no resend inside a minute of the last send).
 *
 * Written from the issue alone. The too-soon check reads `lastSentAt` outside
 * any lock, and the new token is written after the send with the last write
 * winning. Resends arriving together therefore all pass the check, all send,
 * and every mail but the last carries a link that is already dead. The check
 * and the record of the send must be one locked step with #1882's reservation,
 * so a second request sees the first's send time and answers `too_soon`.
 *
 * THE RACE SEAM (as #1882): a before-insert trigger on the send table sleeps
 * inside the reservation transaction, and the mailer is slow. A correct fix
 * may hold its lock across the send or record the send time at reservation;
 * both give the same outward result, so neither is penalised.
 */

const MAIL_DELAY_MS = 250;
const GAP_SECONDS = 0.3;
const ROUNDS = 2;

let fixture: IntegrationFixture;
let delivered: Array<{ to: string; text: string }>;

const slowMailer = {
  async sendEmail(notification: SmtpNotification) {
    await new Promise((resolve) => setTimeout(resolve, MAIL_DELAY_MS));
    delivered.push({ to: notification.to, text: notification.text });
  },
};

beforeEach(async () => {
  fixture = await createIntegrationFixture("sign-in-approval-resend-race-1891");
  delivered = [];
});
afterEach(async () => { await fixture.cleanup(); });
afterAll(async () => { await cleanupIntegrationEnvironment(); });

async function account(): Promise<string> {
  const created = await createLocalUserAndSendSetupLink(
    fixture.users.admin.id,
    { email: `resend-${crypto.randomUUID()}@example.invalid`, displayName: "Resend Person" },
    { mailer: { async sendEmail() {} } },
  );
  return created.user.id;
}

/** A pending approval with a known claim, last mailed `secondsAgo` seconds ago. */
async function pending(userId: string, secondsAgo = 600): Promise<{ id: string; claim: string }> {
  const claim = crypto.randomUUID();
  const [row] = await getDb().insert(signInApprovals).values({
    userId,
    tokenHash: crypto.randomUUID(),
    claimHash: createHash("sha256").update(claim, "utf8").digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
    sendCount: 1,
    lastSentAt: new Date(Date.now() - secondsAgo * 1000),
  }).returning({ id: signInApprovals.id });
  return { id: row.id, claim };
}

const resend = (claim: string) => resendSignInApproval(claim, { mailer: slowMailer });

/** The approval token in a delivered mail, read from its link. */
function tokenIn(mail: { text: string }): string {
  const match = /\/approve\/([^\s"'<>)]+)/.exec(mail.text);
  if (!match) throw new Error("no approval link in the mail");
  return decodeURIComponent(match[1]);
}

async function outcomeOf(id: string): Promise<string | null> {
  const [row] = await getDb().select({ outcome: signInApprovals.outcome }).from(signInApprovals)
    .where(eq(signInApprovals.id, id));
  return row.outcome;
}

function expectOneSent(results: ResendOutcome[], round: number): void {
  expect(results.filter((r) => r.state === "sent"), `round ${round} sent`).toHaveLength(1);
  expect(results.filter((r) => r.state === "too_soon"), `round ${round} too_soon`).toHaveLength(results.length - 1);
  expect(delivered, `round ${round} mails`).toHaveLength(1);
}

describe("a resend after the gap still sends (stays true)", () => {
  it("sends, and the mailed link works, once 60 seconds have passed", async () => {
    const userId = await account();
    const approval = await pending(userId, 61);

    const result = await resend(approval.claim);

    expect(result).toMatchObject({ state: "sent", sendError: null });
    expect(delivered).toHaveLength(1);
    expect(await decideSignInApproval(tokenIn(delivered[0]), "approved")).toEqual({ recorded: true });
    expect(await outcomeOf(approval.id)).toBe("approved");
  }, 60_000);

  it("answers too_soon and sends nothing inside the minute", async () => {
    const userId = await account();
    const approval = await pending(userId, 30);

    expect(await resend(approval.claim)).toMatchObject({ state: "too_soon" });
    expect(delivered).toHaveLength(0);
  }, 60_000);
});

describe("concurrent resends of one approval send one working link (#1891)", () => {
  it("two at once: one mail, one too_soon, and the mailed link approves", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await account();
      const approval = await pending(userId);

      const results = await Promise.all([resend(approval.claim), resend(approval.claim)]);

      expectOneSent(results, round);
      expect(await decideSignInApproval(tokenIn(delivered[0]), "approved"), `round ${round} link`)
        .toEqual({ recorded: true });
      expect(await outcomeOf(approval.id)).toBe("approved");
      delivered = [];
    }
  }, 120_000);

  it("five at once: one mail, four too_soon, and the mailed link approves", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = await account();
      const approval = await pending(userId);

      const results = await Promise.all(Array.from({ length: 5 }, () => resend(approval.claim)));

      expectOneSent(results, round);
      expect(await decideSignInApproval(tokenIn(delivered[0]), "approved"), `round ${round} link`)
        .toEqual({ recorded: true });
      delivered = [];
    }
  }, 120_000);

  it("the too_soon answer carries a resend time after the winner's send", async () => {
    const userId = await account();
    const approval = await pending(userId);
    const before = Date.now();

    const results = await Promise.all(Array.from({ length: 3 }, () => resend(approval.claim)));

    const soon = results.filter((r): r is Extract<ResendOutcome, { state: "too_soon" }> => r.state === "too_soon");
    expect(soon).toHaveLength(2);
    for (const answer of soon) expect(answer.canResendAt.getTime()).toBeGreaterThan(before);
  }, 60_000);
});

describe("the same, with a wide gap in the reservation transaction (#1891)", () => {
  beforeEach(async () => {
    await getDb().execute(sql.raw(`
      create or replace function sign_in_sends_gap_1891() returns trigger language plpgsql as
      $$ begin perform pg_sleep(${GAP_SECONDS}); return new; end $$`));
    await getDb().execute(sql.raw(`
      create trigger sign_in_sends_gap_1891 before insert on sign_in_approval_sends
      for each row execute function sign_in_sends_gap_1891()`));
  });
  afterEach(async () => {
    await getDb().execute(sql.raw("drop trigger if exists sign_in_sends_gap_1891 on sign_in_approval_sends"));
    await getDb().execute(sql.raw("drop function if exists sign_in_sends_gap_1891()"));
  });

  it("two at once: one mail, one too_soon, and the mailed link approves", async () => {
    const userId = await account();
    const approval = await pending(userId);

    const results = await Promise.all([resend(approval.claim), resend(approval.claim)]);

    expectOneSent(results, 0);
    expect(await decideSignInApproval(tokenIn(delivered[0]), "approved")).toEqual({ recorded: true });
  }, 60_000);

  it("four at once: one mail, three too_soon, and the mailed link approves", async () => {
    const userId = await account();
    const approval = await pending(userId);

    const results = await Promise.all(Array.from({ length: 4 }, () => resend(approval.claim)));

    expectOneSent(results, 0);
    expect(await decideSignInApproval(tokenIn(delivered[0]), "approved")).toEqual({ recorded: true });
  }, 60_000);

  it("a resend after the winner finishes and the gap has passed still sends", async () => {
    const userId = await account();
    const approval = await pending(userId);
    await Promise.all([resend(approval.claim), resend(approval.claim)]);
    expect(delivered).toHaveLength(1);

    await getDb().update(signInApprovals)
      .set({ lastSentAt: new Date(Date.now() - 61_000) })
      .where(eq(signInApprovals.id, approval.id));
    expect(await resend(approval.claim)).toMatchObject({ state: "sent", sendError: null });
    expect(delivered).toHaveLength(2);
    expect(await decideSignInApproval(tokenIn(delivered[1]), "approved")).toEqual({ recorded: true });
  }, 60_000);
});
