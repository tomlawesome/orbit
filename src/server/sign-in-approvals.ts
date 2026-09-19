/*
 * THE EMAIL SECOND FACTOR (#1033, ADR-0027).
 *
 * A password proves what somebody knows. This module is the second thing:
 * every password sign-in mints a PENDING sign-in instead of a session, mails
 * an approval link to the account's own address, and the browser that typed
 * the password waits until somebody reading that mail decides. Nothing here
 * is per-user or per-browser -- the owner ruled every password sign-in, every
 * time, with no remembered-browser exemption (ADR-0027 §1-§2).
 *
 * FOUR PROPERTIES HOLD THIS TOGETHER, and each of them is a way somebody
 * could otherwise be let in.
 *
 *  - **Two secrets, not one.** The token travels by email and says whether
 *    this sign-in is allowed; the claim stays in the waiting tab's cookie and
 *    says which browser may collect the session. Anyone who reads the mail
 *    can approve; only the tab that typed the password gets in. That is what
 *    makes a forwarded link the choice ADR-0027 §4 describes rather than a
 *    handover of the account.
 *  - **Opening the link decides nothing.** Mail scanners follow links, so
 *    `readSignInApproval` is a pure read and only `decideSignInApproval`
 *    writes an outcome (build ruling, 2026-09-18).
 *  - **Everything spends once.** The approval is consumed by the collecting
 *    tab under a conditional update, so two tabs racing leave exactly one
 *    session; the outcome is written only while it is still null.
 *  - **The factor is off as a whole, or on for everybody.** The only switch
 *    is whether the instance has a mail relay configured (ADR-0027 §2), which
 *    is the same emptiness test every other outbound-mail surface uses -- not
 *    whether the relay answers right now.
 *
 * OIDC is not challenged at all and never reaches this module: the provider
 * is the identity and handles its own second factor (ADR-0027 §3). Setup and
 * recovery links are not challenged either (owner ruling, 2026-09-18): they
 * ARE the factor, which is why `POST /api/auth/local/setup` still signs the
 * reader in directly and why the administration screen's "send a new setup
 * link" is the way through an undeliverable mailbox.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { base64url } from "jose";
import { getDb } from "@/db";
import { auditLog, localCredentials, signInApprovals, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { describeDevice } from "@/lib/auth/device";
import { log } from "@/lib/logger";
import { sendBoundedMail, type InvitationMailer, type InvitationSendError } from "@/server/invitations/send";
import { getNotificationWorkerConfig } from "@/server/notification-worker";
import { openInstanceMetadataReader } from "@/server/metadata/fields";
import { renderApprovalMail } from "@/server/sign-in-approvals/mail";

/** Ten minutes (ADR-0027 §6): long enough to reach a phone, short enough that
 *  a link left in a mailbox overnight is worth nothing. */
export const SIGN_IN_APPROVAL_TTL_MS = 10 * 60 * 1000;

/** ADR-0027 §8: a resend is refused for the first minute after a send. */
export const APPROVAL_RESEND_INTERVAL_MS = 60 * 1000;

/** ADR-0027 §8: five sends per account per hour, then "check the mail we already sent". */
export const APPROVAL_SENDS_PER_HOUR = 5;
export const APPROVAL_SEND_WINDOW_MS = 60 * 60 * 1000;

/** Same strength, and the same reason, as a setup token (ADR-0027 §6). */
const APPROVAL_SECRET_BYTES = 32;

/** The mail provider seam, so a test can hand this module a fake one. */
export type ApprovalMailer = InvitationMailer;

/** The only words a send failure is allowed to answer in. */
export type ApprovalSendError = InvitationSendError;

function createSecret(): string {
  return base64url.encode(randomBytes(APPROVAL_SECRET_BYTES));
}

function secretDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Whether the instance can send at all, and therefore whether the factor is
 * on (ADR-0027 §2).
 *
 * "Configured", not "reachable" (build ruling, 2026-09-18): a relay that is
 * set up but refusing connections today leaves the door shut, which is the
 * outage ADR-0027's consequences accept by name. Reading it as "answers now"
 * would turn every SMTP hiccup into a silent removal of the second factor,
 * which is the one failure direction that must never happen.
 *
 * This is deliberately the same emptiness test `outboundMailState` and
 * `verifySmtpProviderConnection` use, so the sign-in door, the settings
 * screen and the worker cannot disagree about whether mail can leave.
 */
export function secondFactorConfigured(): boolean {
  try {
    return Boolean(getNotificationWorkerConfig().smtpUrl);
  } catch {
    /* A configuration this instance cannot even parse is the same fact as no
       configuration at all -- and the factor is off rather than locking
       everybody out on the strength of an unreadable setting. */
    return false;
  }
}

/** IPv4 dotted quad, or nothing. */
function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

/**
 * Whether an address is one a household hands out to itself: loopback, the
 * three RFC 1918 ranges, IPv4 link-local, and IPv6's loopback, unique-local
 * and link-local. Nothing else counts -- a carrier-grade NAT address
 * (100.64/10) is somebody else's network, not this one's.
 *
 * IPv4-mapped IPv6 (`::ffff:192.168.1.5`) is unwrapped first, because that is
 * what a dual-stack Node server reports for a plain IPv4 client and reading it
 * as "some IPv6 address" would tell a reader at home they were somewhere else.
 */
export function normalizeAddress(address: string): string {
  let candidate = address.trim();
  /* A zone index ("fe80::1%eth0") belongs to the interface, not the address. */
  const zone = candidate.indexOf("%");
  if (zone >= 0) candidate = candidate.slice(0, zone);
  /* IPv4-mapped IPv6 (`::ffff:192.168.1.5`) is what a dual-stack Node server
     reports for a plain IPv4 client. It is unwrapped for BOTH questions --
     whether it is a home address, and what to show -- because a reader shown
     `::ffff:203.0.113.9` is being shown machinery rather than an address. */
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(candidate);
  return mapped ? mapped[1] : candidate;
}

export function isPrivateAddress(address: string): boolean {
  const candidate = normalizeAddress(address).toLowerCase();
  if (candidate.length === 0) return false;

  const octets = ipv4Octets(candidate);
  if (octets) {
    const [first, second] = octets;
    if (first === 10 || first === 127) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true;
    return false;
  }

  if (candidate === "::1") return true;
  /* fc00::/7 (unique local) and fe80::/10 (link local). */
  if (/^f[cd][0-9a-f]{0,2}:/u.test(candidate)) return true;
  if (/^fe[89ab][0-9a-f]?:/u.test(candidate)) return true;
  return false;
}

/**
 * Where the request came from, as the phrase the mail and the approval page
 * both put after "From" (owner ruling, 2026-09-18).
 *
 * A private address is told as a place rather than as a number, because the
 * number means nothing to the reader and the fact does: somebody on their own
 * network typed the password. A public address is shown as it is -- naming the
 * country or the city is #1053 and deliberately not this build.
 */
export function describeClientAddress(address: string | null | undefined): string {
  const candidate = normalizeAddress(address ?? "");
  if (candidate.length === 0) return "an address Orbit could not read";
  return isPrivateAddress(candidate) ? "your home network" : candidate;
}

/**
 * "Chrome on Linux" -- `describeDevice`'s coarse pair, joined in words.
 *
 * The sessions list's own separator is a middle dot, which is right on a
 * screen and wrong in a plain-ASCII mail (`src/server/local-credentials/mail.ts`
 * says why). One reduction, two renderings, and the reduction stays in
 * `lib/auth/device.ts` where it is already tested against real user agents.
 */
export function deviceInWords(userAgent: string | null | undefined): string {
  const described = describeDevice(userAgent);
  return described.replace(" · ", " on ");
}

/** The facts a pending sign-in records about the request that started it. */
export interface SignInRequestFacts {
  userAgent: string | null;
  clientAddress: string | null;
}

export interface SignInApprovalOptions {
  /** Supplied by tests; unset means the instance's configured SMTP transport. */
  mailer?: ApprovalMailer | null;
  now?: Date;
}

/** One absolute approval link, built exactly the way `setupLink` builds a setup one. */
export function approvalLink(token: string, environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.APP_URL;
  if (!configured) throw new AppError("unsafe_input", "The approval link cannot be built", 503);
  try {
    const url = new URL(configured);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("unsafe application origin");
    return new URL(`/approve/${encodeURIComponent(token)}`, url.origin).href;
  } catch {
    throw new AppError("unsafe_input", "The approval link cannot be built", 503);
  }
}

/** What the sign-in route hands back to the waiting browser. */
export interface PendingSignIn {
  /** The waiting tab's own secret. Goes in a cookie and nowhere else. */
  claim: string;
  expiresAt: Date;
  /** When this tab may ask for another mail. */
  canResendAt: Date;
  /**
   * True when the hourly limit stopped this send rather than a provider did:
   * an earlier link is still in the reader's mailbox, and ADR-0027 §8's own
   * words for that are "check the mail we already sent".
   */
  limited: boolean;
  /** Null when the mail was sent; otherwise the one bounded word for why not. */
  sendError: ApprovalSendError | null;
}

/** The recipient, and nothing else this module is allowed to know about them. */
interface Recipient {
  id: string;
  email: string | null;
  displayName: string;
}

async function readRecipient(userId: string): Promise<Recipient | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: users.id,
      /* Dual read (#969): the envelope once the backfill has reached the row,
         the plaintext column until it has. */
      email: users.email,
      emailEnc: users.emailEnc,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  const address = (await openInstanceMetadataReader(db))
    .text("users.email", row.id, { encrypted: row.emailEnc, plaintext: row.email });
  return { id: row.id, email: address.value, displayName: row.displayName };
}

/**
 * How many approval mails this account has had inside the last hour.
 *
 * Counted per PENDING SIGN-IN, by its own latest send: a row whose last mail
 * went out inside the window contributes every mail it has ever sent. That
 * rounds the limit the safe way -- a burst of five is never undercounted --
 * at the cost of holding the limit a little past the strict hour for a row
 * that was sent to repeatedly. The alternative is a row per send, which is a
 * second table to hold a number this one can already carry.
 */
async function sendsInWindow(userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - APPROVAL_SEND_WINDOW_MS);
  const [row] = await getDb()
    .select({ sends: sql<number>`coalesce(sum(${signInApprovals.sendCount}), 0)::int` })
    .from(signInApprovals)
    .where(and(eq(signInApprovals.userId, userId), gt(signInApprovals.lastSentAt, since)));
  return row?.sends ?? 0;
}

/** Puts one approval mail on the wire. Never throws for a provider failure. */
async function mailApproval(
  recipient: Recipient,
  token: string,
  facts: SignInRequestFacts,
  requestedAt: Date,
  expiresAt: Date,
  options: SignInApprovalOptions,
): Promise<ApprovalSendError | null> {
  if (!recipient.email) {
    /* No readable address means no way to ask (#969). The door stays shut and
       the administration screen's setup link is the way through, exactly as
       ADR-0027 §7 intends for an undeliverable mailbox. */
    return "unknown";
  }
  let mail;
  try {
    mail = renderApprovalMail({
      displayName: recipient.displayName,
      link: approvalLink(token),
      device: deviceInWords(facts.userAgent),
      where: describeClientAddress(facts.clientAddress),
      requestedAt,
      expiresAt,
    });
  } catch {
    /* An instance with no usable `APP_URL` cannot build a link to send. That
       is the same fact to the reader as a relay that will not take the mail --
       the door is shut and an administrator's setup link is the way in -- so
       it is reported, not thrown. Throwing here would turn a misconfigured
       instance's sign-in into a 502 and tell the reader their password was
       the problem. */
    return "unknown";
  }
  const outcome = await sendBoundedMail(
    recipient.email,
    mail,
    options.mailer,
    requestedAt,
  );
  if (outcome.sendError) {
    /* One bounded record, never the provider's own message: the operator
       needs to know approvals are not leaving, and nothing more. */
    log.warn({
      event: "auth.local",
      state: "degraded",
      /* The logger's own closed vocabulary carries the three SMTP words; the
         mailer's fourth, `unknown`, has no member there and is reported as
         the generic failure rather than by widening that list for one call. */
      reason: outcome.sendError === "unknown" ? "unexpected_failure" : outcome.sendError,
      action: "check_provider",
      impact: "sign_in_blocked",
    });
  }
  return outcome.sendError;
}

/**
 * Opens a pending sign-in for a password that has already been verified, and
 * mails its approval link (ADR-0027 §1, §4-§6).
 *
 * The row is written whether or not the mail gets out: a pending sign-in that
 * could not be posted is still a sign-in nobody may complete, and writing it
 * anyway keeps the waiting tab's resend button pointed at something. It is
 * also what makes the hourly limit honest -- a suppressed send still leaves
 * the reader an earlier live link, and this tab waiting on its own.
 */
export async function startSignInApproval(
  userId: string,
  facts: SignInRequestFacts,
  options: SignInApprovalOptions = {},
): Promise<PendingSignIn> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + SIGN_IN_APPROVAL_TTL_MS);
  const token = createSecret();
  const claim = createSecret();

  const recipient = await readRecipient(userId);
  const limited = await sendsInWindow(userId, now) >= APPROVAL_SENDS_PER_HOUR;
  /* An account that vanished between the password check and this read is a
     send that did not happen, never a send that silently counted: `sent`
     decides whether the hour's allowance is spent, so it has to mean "a mail
     went out". */
  const sendError = limited
    ? null
    : recipient
      ? await mailApproval(recipient, token, facts, now, expiresAt, options)
      : "unknown";
  const sent = !limited && sendError === null;

  await getDb().insert(signInApprovals).values({
    userId,
    tokenHash: secretDigest(token),
    claimHash: secretDigest(claim),
    userAgent: facts.userAgent ? facts.userAgent.slice(0, 256) : null,
    clientAddress: facts.clientAddress,
    expiresAt,
    sendCount: sent ? 1 : 0,
    lastSentAt: sent ? now : null,
  });

  return {
    claim,
    expiresAt,
    canResendAt: new Date(now.getTime() + APPROVAL_RESEND_INTERVAL_MS),
    limited,
    sendError,
  };
}

/** What is being approved, as the approval page shows it (ADR-0027 §4). */
export interface ApprovalRequestView {
  /** The instance's own host, so a reader can see which Orbit this is. */
  instance: string;
  /** "Chrome on Linux", never the raw user agent. */
  device: string;
  /** "your home network", or the address itself. */
  where: string;
  requestedAt: Date;
  expiresAt: Date;
  /** `open` is the only state with buttons on it. */
  state: "open" | "approved" | "denied" | "lapsed";
}

/**
 * Reads a pending sign-in for display. A PURE READ, deliberately: mail
 * scanners follow links, so opening one must change nothing at all (build
 * ruling, 2026-09-18).
 *
 * `null` for an unknown token, which is the same answer the setup card gives
 * a token it does not recognise -- whoever is holding a guess learns nothing
 * from it.
 */
export async function readSignInApproval(
  token: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ApprovalRequestView | null> {
  if (token.length === 0) return null;
  const [row] = await getDb()
    .select({
      userAgent: signInApprovals.userAgent,
      clientAddress: signInApprovals.clientAddress,
      createdAt: signInApprovals.createdAt,
      expiresAt: signInApprovals.expiresAt,
      outcome: signInApprovals.outcome,
    })
    .from(signInApprovals)
    .where(eq(signInApprovals.tokenHash, secretDigest(token)))
    .limit(1);
  if (!row) return null;

  const lapsed = row.expiresAt.getTime() <= Date.now();
  const state = row.outcome === "approved"
    ? "approved"
    : row.outcome === "denied"
      ? "denied"
      : lapsed ? "lapsed" : "open";

  let instance = "";
  try {
    instance = new URL(environment.APP_URL ?? "").host;
  } catch {
    instance = "";
  }

  return {
    instance,
    device: deviceInWords(row.userAgent),
    where: describeClientAddress(row.clientAddress),
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
    state,
  };
}

export type ApprovalDecision = "approved" | "denied";

/**
 * Records the one press that decides a pending sign-in (ADR-0027 §4).
 *
 * `SELECT ... FOR UPDATE` and an outcome written only while it is still null,
 * so two presses leave one answer -- and so a reader who pressed Approve
 * cannot have it turned into a refusal by whoever else holds the link.
 *
 * A refusal is worth more than a closed door: it revokes the pending sign-in,
 * counts as a failed attempt in the per-credential backoff (ADR-0027 §8, so a
 * guessing run that reaches somebody's mailbox still costs what a wrong
 * password costs), and leaves the account holder a notice for their next
 * successful sign-in.
 */
export async function decideSignInApproval(
  token: string,
  decision: ApprovalDecision,
): Promise<{ recorded: boolean }> {
  if (token.length === 0) return { recorded: false };
  const tokenHash = secretDigest(token);

  return getDb().transaction(async (transaction) => {
    const [row] = await transaction
      .select({
        id: signInApprovals.id,
        userId: signInApprovals.userId,
        expiresAt: signInApprovals.expiresAt,
        outcome: signInApprovals.outcome,
        consumedAt: signInApprovals.consumedAt,
      })
      .from(signInApprovals)
      .where(eq(signInApprovals.tokenHash, tokenHash))
      .for("update")
      .limit(1);

    if (!row || row.outcome || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
      return { recorded: false };
    }

    const decidedAt = new Date();
    await transaction
      .update(signInApprovals)
      .set({
        outcome: decision,
        decidedAt,
        /* A refusal spends the link outright, in the same statement that
           records it, so the browser that typed the password cannot come back
           to a sign-in somebody has already turned away. */
        ...(decision === "denied" ? { consumedAt: decidedAt } : {}),
      })
      .where(eq(signInApprovals.id, row.id));

    if (decision === "denied") {
      await transaction.insert(auditLog).values({
        householdId: null,
        actorUserId: row.userId,
        entityType: "user",
        entityId: row.userId,
        action: "sign_in_refused",
        changes: {},
      });
      await countRefusalAsFailure(transaction, row.userId);
    }

    return { recorded: true };
  });
}

type Executor = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * One refusal, counted in the same column an ordinary wrong password is
 * counted in (ADR-0027 §8). The schedule itself stays where it already lives;
 * this only adds to the count, so the two cannot drift into two backoffs.
 */
async function countRefusalAsFailure(executor: Executor, userId: string): Promise<void> {
  await executor
    .update(localCredentials)
    .set({
      failedAttemptCount: sql`${localCredentials.failedAttemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(localCredentials.userId, userId));
}

/** Where a waiting tab stands. `unknown` covers every dead end at once. */
export type PendingSignInState =
  | { state: "waiting" }
  | { state: "approved"; userId: string }
  | { state: "denied" }
  | { state: "unknown" };

/**
 * Answers the waiting tab, and hands it the session when it has one
 * (ADR-0027 §4).
 *
 * Keyed on the CLAIM and never on the token: the tab that typed the password
 * is the only one that may collect, so polling with a link somebody read over
 * a shoulder gets nothing. The approved answer is spent under a conditional
 * update, so two tabs sharing a cookie still leave exactly one session.
 */
export async function collectSignInApproval(claim: string): Promise<PendingSignInState> {
  if (claim.length === 0) return { state: "unknown" };
  const db = getDb();
  const [row] = await db
    .select({
      id: signInApprovals.id,
      userId: signInApprovals.userId,
      expiresAt: signInApprovals.expiresAt,
      outcome: signInApprovals.outcome,
      consumedAt: signInApprovals.consumedAt,
    })
    .from(signInApprovals)
    .where(eq(signInApprovals.claimHash, secretDigest(claim)))
    .limit(1);

  if (!row) return { state: "unknown" };
  if (row.outcome === "denied") return { state: "denied" };
  if (row.consumedAt) return { state: "unknown" };
  if (row.expiresAt.getTime() <= Date.now()) return { state: "unknown" };
  if (row.outcome !== "approved") return { state: "waiting" };

  const [claimed] = await db
    .update(signInApprovals)
    .set({ consumedAt: new Date() })
    .where(and(eq(signInApprovals.id, row.id), isNull(signInApprovals.consumedAt)))
    .returning({ id: signInApprovals.id });
  return claimed ? { state: "approved", userId: row.userId } : { state: "unknown" };
}

/** What a resend did, in the words the waiting card has for each. */
export type ResendOutcome =
  | { state: "sent"; canResendAt: Date; sendError: ApprovalSendError | null }
  | { state: "too_soon"; canResendAt: Date }
  | { state: "limited" }
  | { state: "unknown" };

/**
 * Sends the waiting tab's link again, inside ADR-0027 §8's limits: one live
 * link per pending sign-in, so this REPLACES the token rather than adding a
 * second one; not inside a minute of the last send; and never past five sends
 * for the account in an hour, where the answer is to read the mail already
 * sent rather than to ask for another.
 */
export async function resendSignInApproval(
  claim: string,
  options: SignInApprovalOptions = {},
): Promise<ResendOutcome> {
  if (claim.length === 0) return { state: "unknown" };
  const now = options.now ?? new Date();
  const db = getDb();

  const [row] = await db
    .select({
      id: signInApprovals.id,
      userId: signInApprovals.userId,
      userAgent: signInApprovals.userAgent,
      clientAddress: signInApprovals.clientAddress,
      createdAt: signInApprovals.createdAt,
      expiresAt: signInApprovals.expiresAt,
      outcome: signInApprovals.outcome,
      consumedAt: signInApprovals.consumedAt,
      lastSentAt: signInApprovals.lastSentAt,
    })
    .from(signInApprovals)
    .where(eq(signInApprovals.claimHash, secretDigest(claim)))
    .limit(1);

  if (!row || row.outcome || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
    return { state: "unknown" };
  }

  if (row.lastSentAt && now.getTime() - row.lastSentAt.getTime() < APPROVAL_RESEND_INTERVAL_MS) {
    return { state: "too_soon", canResendAt: new Date(row.lastSentAt.getTime() + APPROVAL_RESEND_INTERVAL_MS) };
  }
  if (await sendsInWindow(row.userId, now) >= APPROVAL_SENDS_PER_HOUR) return { state: "limited" };

  const recipient = await readRecipient(row.userId);
  if (!recipient) return { state: "unknown" };

  const token = createSecret();
  const sendError = await mailApproval(recipient, token, row, row.createdAt, row.expiresAt, options);
  if (sendError === null) {
    /* The new link only becomes the live one once it is actually in the post:
       replacing the digest first would kill the reader's working link to
       replace it with one that never arrived. */
    await db
      .update(signInApprovals)
      .set({
        tokenHash: secretDigest(token),
        sendCount: sql`${signInApprovals.sendCount} + 1`,
        lastSentAt: now,
      })
      .where(eq(signInApprovals.id, row.id));
  }

  return {
    state: "sent",
    canResendAt: new Date(now.getTime() + APPROVAL_RESEND_INTERVAL_MS),
    sendError,
  };
}

/**
 * The other half of a refusal (ADR-0027, consequences): somebody said "this
 * wasn't me", and the account holder is owed one line about it the next time
 * they get in.
 *
 * Taken rather than read -- every unshown refusal is stamped in the same
 * statement that answers -- so the notice appears once and does not follow
 * the reader around. The newest refusal is the one reported: several in a row
 * are one story, and the most recent is the one that tells it.
 */
export async function takeDeniedSignInNotice(userId: string): Promise<{ deniedAt: Date } | null> {
  const db = getDb();
  const shown = await db
    .update(signInApprovals)
    .set({ noticeShownAt: new Date() })
    .where(and(
      eq(signInApprovals.userId, userId),
      eq(signInApprovals.outcome, "denied"),
      isNull(signInApprovals.noticeShownAt),
    ))
    .returning({ decidedAt: signInApprovals.decidedAt, createdAt: signInApprovals.createdAt });
  if (shown.length === 0) return null;
  const newest = shown
    .map((row) => row.decidedAt ?? row.createdAt)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  return { deniedAt: newest };
}
