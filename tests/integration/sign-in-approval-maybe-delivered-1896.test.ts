import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { signInApprovals } from "@/db/schema";
import { createLocalUserAndSendSetupLink } from "@/server/local-credentials/setup-mail";
import type { SmtpNotification } from "@/server/notification-worker";
import {
  decideSignInApproval,
  readSignInApproval,
  resendSignInApproval,
  startSignInApproval,
} from "@/server/sign-in-approvals";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";

/**
 * A MAYBE-DELIVERED RESEND KEEPS BOTH LINKS (#1896, ruling note 65074).
 *
 * Written from the ruling alone. A resend stages its link in
 * `sign_in_approvals.staged_token_hash` under the lock, before the mail goes,
 * and the row is found by `token_hash = digest OR staged_token_hash = digest`.
 * A confirmed send promotes staged to current; a failure the mailer can prove
 * never left (a numbered SMTP reply, a refused connection) clears staged and
 * puts the send time back; anything else -- a timeout above all -- keeps both
 * links until the next resend or a decision.
 *
 * The staged column is read and written here by raw SQL, so this file
 * compiles before the column exists; until the migration adds it, every case
 * that touches it fails at run time.
 */

const MAIL_DELAY_MS = 250;

let fixture: IntegrationFixture;
let delivered: Array<{ to: string; text: string }>;

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** nodemailer's shape for a socket timeout: silence, not a refusal. */
const timedOut = () => Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });

beforeEach(async () => {
  fixture = await createIntegrationFixture("sign-in-approval-maybe-delivered-1896");
  delivered = [];
});
afterEach(async () => { await fixture.cleanup(); });
afterAll(async () => { await cleanupIntegrationEnvironment(); });

async function account(): Promise<string> {
  const created = await createLocalUserAndSendSetupLink(
    fixture.users.admin.id,
    { email: `staged-${crypto.randomUUID()}@example.invalid`, displayName: "Staged Person" },
    { mailer: { async sendEmail() {} } },
  );
  return created.user.id;
}

/** A pending approval whose current link is known, last mailed ten minutes ago. */
async function pendingWithLink(userId: string): Promise<{ id: string; claim: string; oldToken: string; lastSentAt: Date }> {
  const claim = crypto.randomUUID();
  const oldToken = crypto.randomUUID();
  const lastSentAt = new Date(Date.now() - 600_000);
  const [row] = await getDb().insert(signInApprovals).values({
    userId,
    tokenHash: sha(oldToken),
    claimHash: sha(claim),
    expiresAt: new Date(Date.now() + 3_600_000),
    sendCount: 1,
    lastSentAt,
  }).returning({ id: signInApprovals.id });
  return { id: row.id, claim, oldToken, lastSentAt };
}

/** The approval token in a mail, read from its link. */
function tokenIn(mail: { text: string }): string {
  const match = /\/approve\/([^\s"'<>)]+)/.exec(mail.text);
  if (!match) throw new Error("no approval link in the mail");
  return decodeURIComponent(match[1]);
}

/** Both digests and the send bookkeeping, by raw SQL so this compiles before the column exists. */
async function digestsOf(id: string) {
  const [row] = await getDb().execute(sql`
    select token_hash, staged_token_hash, send_count, last_sent_at
    from sign_in_approvals where id = ${id}`) as unknown as Array<{
      token_hash: string;
      staged_token_hash: string | null;
      send_count: number;
      last_sent_at: Date | string | null;
    }>;
  return row;
}

const stateOf = async (token: string) => (await readSignInApproval(token))?.state ?? null;

async function sendRows(id: string): Promise<number> {
  const rows = await getDb().execute(sql`select 1 from sign_in_approval_sends where approval_id = ${id}`) as unknown as unknown[];
  return rows.length;
}

describe("the staged column (#1896 ruling point 1)", () => {
  it("is a nullable text column on sign_in_approvals", async () => {
    const columns = await getDb().execute(sql`
      select data_type, is_nullable from information_schema.columns
      where table_name = 'sign_in_approvals' and column_name = 'staged_token_hash'`) as unknown as Array<{
        data_type: string;
        is_nullable: string;
      }>;
    expect(columns).toEqual([{ data_type: "text", is_nullable: "YES" }]);
  }, 60_000);

  it("is unique: two rows cannot stage the same digest", async () => {
    const userId = await account();
    const a = await pendingWithLink(userId);
    const b = await pendingWithLink(userId);
    const digest = sha(crypto.randomUUID());

    await getDb().execute(sql`update sign_in_approvals set staged_token_hash = ${digest} where id = ${a.id}`);
    await expect(getDb().execute(sql`update sign_in_approvals set staged_token_hash = ${digest} where id = ${b.id}`))
      .rejects.toThrow();
  }, 60_000);
});

describe("a timed-out resend keeps both links (#1896)", () => {
  it("both links read open, the new one is the staged digest, and the send time and count row stay", async () => {
    const userId = await account();
    const approval = await pendingWithLink(userId);
    let mailed = "";
    const timingOut = {
      async sendEmail(notification: SmtpNotification) {
        mailed = tokenIn(notification);
        throw timedOut();
      },
    };

    const result = await resendSignInApproval(approval.claim, { mailer: timingOut });

    expect(result).toMatchObject({ state: "sent" });
    expect((result as { sendError: unknown }).sendError).not.toBeNull();
    const after = await digestsOf(approval.id);
    expect(after.token_hash).toBe(sha(approval.oldToken));
    expect(after.staged_token_hash).toBe(sha(mailed));
    expect(new Date(after.last_sent_at as string).getTime()).toBeGreaterThan(approval.lastSentAt.getTime());
    expect(await sendRows(approval.id)).toBe(1);
    expect(await stateOf(approval.oldToken)).toBe("open");
    expect(await stateOf(mailed)).toBe("open");
    expect(await resendSignInApproval(approval.claim, { mailer: timingOut })).toMatchObject({ state: "too_soon" });
  }, 60_000);

  it("approving through the new link spends the row, so the old link approves nothing", async () => {
    const userId = await account();
    const approval = await pendingWithLink(userId);
    let mailed = "";
    await resendSignInApproval(approval.claim, {
      mailer: { async sendEmail(notification: SmtpNotification) { mailed = tokenIn(notification); throw timedOut(); } },
    });

    expect(await decideSignInApproval(mailed, "approved")).toEqual({ recorded: true });
    expect(await stateOf(approval.oldToken)).toBe("approved");
    expect(await decideSignInApproval(approval.oldToken, "denied")).toEqual({ recorded: false });
  }, 60_000);

  it("a confirmed resend afterwards promotes its link and kills both earlier ones", async () => {
    const userId = await account();
    const approval = await pendingWithLink(userId);
    let second = "";
    await resendSignInApproval(approval.claim, {
      mailer: { async sendEmail(notification: SmtpNotification) { second = tokenIn(notification); throw timedOut(); } },
    });
    await getDb().update(signInApprovals)
      .set({ lastSentAt: new Date(Date.now() - 61_000) })
      .where(eq(signInApprovals.id, approval.id));

    const result = await resendSignInApproval(approval.claim, {
      mailer: { async sendEmail(notification: SmtpNotification) { delivered.push({ to: notification.to, text: notification.text }); } },
    });

    expect(result).toMatchObject({ state: "sent", sendError: null });
    const third = tokenIn(delivered[0]);
    const after = await digestsOf(approval.id);
    expect(after.token_hash).toBe(sha(third));
    expect(after.staged_token_hash).toBeNull();
    expect(after.send_count).toBe(2);
    expect([await stateOf(approval.oldToken), await stateOf(second), await stateOf(third)]).toEqual([null, null, "open"]);
  }, 60_000);
});

describe("a refused resend clears its staged link (#1896)", () => {
  it("EENVELOPE: the old link works, the new one does not, nothing is staged, the send time is back", async () => {
    const userId = await account();
    const approval = await pendingWithLink(userId);
    let mailed = "";
    let duringStaged: string | null | undefined;
    const refusing = {
      async sendEmail(notification: SmtpNotification) {
        mailed = tokenIn(notification);
        duringStaged = (await digestsOf(approval.id)).staged_token_hash;
        throw Object.assign(new Error("relay refused"), { code: "EENVELOPE", responseCode: 550 });
      },
    };

    await resendSignInApproval(approval.claim, { mailer: refusing });

    /* Staged under the lock before the mail went (ruling point 3). */
    expect(duringStaged).toBe(sha(mailed));
    const after = await digestsOf(approval.id);
    expect(after.staged_token_hash).toBeNull();
    expect(new Date(after.last_sent_at as string).getTime()).toBe(approval.lastSentAt.getTime());
    expect(await stateOf(mailed)).toBeNull();
    expect(await decideSignInApproval(approval.oldToken, "approved")).toEqual({ recorded: true });
  }, 60_000);
});

describe("a refused resend after a maybe-delivered one puts the earlier staged link back (#1943 A-R3)", () => {
  it("resend 1 times out, resend 2 is refused with a numbered reply: T0 current, T1 staged, the send time resend 1's", async () => {
    const userId = await account();
    const approval = await pendingWithLink(userId);
    const firstAt = new Date(Date.now() - 120_000);
    let first = "";
    let second = "";

    const one = await resendSignInApproval(approval.claim, {
      now: firstAt,
      mailer: { async sendEmail(notification: SmtpNotification) { first = tokenIn(notification); throw timedOut(); } },
    });
    expect(one).toMatchObject({ state: "sent" });
    expect((await digestsOf(approval.id)).staged_token_hash).toBe(sha(first));

    const two = await resendSignInApproval(approval.claim, {
      now: new Date(firstAt.getTime() + 61_000),
      mailer: {
        async sendEmail(notification: SmtpNotification) {
          second = tokenIn(notification);
          throw Object.assign(new Error("relay refused"), { code: "EENVELOPE", responseCode: 550 });
        },
      },
    });
    expect(two).toMatchObject({ state: "sent" });
    expect(second).not.toBe("");
    expect(second).not.toBe(first);

    const after = await digestsOf(approval.id);
    expect(after.token_hash).toBe(sha(approval.oldToken));
    expect(after.staged_token_hash).toBe(sha(first));
    expect(new Date(after.last_sent_at as string).getTime()).toBe(firstAt.getTime());
    expect(await stateOf(first)).toBe("open");
    expect(await stateOf(second)).toBeNull();
  }, 60_000);
});

describe("concurrent resends still send one mail (#1891, #1896)", () => {
  it("two at once with a timing-out mailer: one mail, one too_soon, exactly one staged digest", async () => {
    const userId = await account();
    const approval = await pendingWithLink(userId);
    const attempted: string[] = [];
    const slowTimingOut = {
      async sendEmail(notification: SmtpNotification) {
        attempted.push(tokenIn(notification));
        await new Promise((resolve) => setTimeout(resolve, MAIL_DELAY_MS));
        throw timedOut();
      },
    };

    const results = await Promise.all([
      resendSignInApproval(approval.claim, { mailer: slowTimingOut }),
      resendSignInApproval(approval.claim, { mailer: slowTimingOut }),
    ]);

    expect(results.filter((r) => r.state === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.state === "too_soon")).toHaveLength(1);
    expect(attempted).toHaveLength(1);
    const after = await digestsOf(approval.id);
    expect(after.token_hash).toBe(sha(approval.oldToken));
    expect(after.staged_token_hash).toBe(sha(attempted[0]));
    expect([await stateOf(approval.oldToken), await stateOf(attempted[0])]).toEqual(["open", "open"]);
  }, 60_000);
});

describe("the sweep removes an expired row and both its digests (#1896 ruling point 7)", () => {
  it("an approval long expired with a staged digest is deleted when a sign-in opens", async () => {
    const userId = await account();
    const approval = await pendingWithLink(userId);
    const staged = crypto.randomUUID();
    await getDb().execute(sql`
      update sign_in_approvals
      set staged_token_hash = ${sha(staged)}, expires_at = now() - interval '91 days'
      where id = ${approval.id}`);
    expect(await stateOf(staged)).toBe("lapsed");

    await startSignInApproval(userId, { userAgent: null, clientAddress: null }, { mailer: { async sendEmail() {} } });

    const left = await getDb().execute(sql`select 1 from sign_in_approvals where id = ${approval.id}`) as unknown as unknown[];
    expect(left).toHaveLength(0);
    expect(await stateOf(staged)).toBeNull();
    expect(await stateOf(approval.oldToken)).toBeNull();
  }, 60_000);
});
