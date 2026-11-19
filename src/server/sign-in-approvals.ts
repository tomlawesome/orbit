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
import { and, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { base64url } from "jose";
import { getDb } from "@/db";
import { auditLog, localCredentials, signInApprovalSends, signInApprovals, users } from "@/db/schema";
import { userAddressLockKey } from "@/lib/auth/authority-locks";
import { describeDevice } from "@/lib/auth/device";
import { AuthError, PasswordChangeRequiredError } from "@/lib/auth/errors";
import { log } from "@/lib/logger";
import { recordLocalCredentialFailure } from "@/server/local-credentials";
import { absoluteAppLink, sendBoundedMail, type InvitationMailer, type InvitationSendError } from "@/server/invitations/send";
import { sendingConfigured } from "@/server/mail-in/sending-settings";
import { openInstanceMetadataReader } from "@/server/metadata/fields";
import type { MetadataExecutor } from "@/server/metadata/keys";
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
 * A setting Orbit cannot READ is neither (S-data3-1): it is "cannot tell", and
 * the sign-in is refused for now with `sign_in_unavailable` (503) rather than
 * decided either way. Nobody is let in on a password alone and nobody is
 * locked out for good; the next attempt, once the database answers, is
 * decided normally. The only direction this gate must never fail in is open.
 *
 * This is deliberately the same emptiness test `outboundMailState` and
 * `verifySmtpProviderConnection` use, so the sign-in door, the settings
 * screen and the worker cannot disagree about whether mail can leave.
 */
export async function secondFactorConfigured(): Promise<boolean> {
  try {
    /* The sending row (#1629), not the retired `SMTP_*` lines. */
    return await sendingConfigured();
  } catch (error) {
    /* Unreadable is not unconfigured (ADR-0027 §2 turns the factor off only
       when no relay is set up). Fail securely: refuse this sign-in with a
       temporary error and leave one bounded record so the operator can see
       the door is shut -- never the driver's own message, in the log or the
       response; it travels only as `cause`, which is never serialised. */
    log.warn({
      event: "auth.local",
      state: "degraded",
      reason: "unexpected_failure",
      action: "check_database",
      impact: "sign_in_blocked",
    });
    throw new AuthError(
      "sign_in_unavailable",
      "Sign-in is not available right now; try again shortly",
      503,
      { cause: error },
    );
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

/** One absolute approval link -- `absoluteAppLink` (#1151 A1-Q4), the one
 *  builder `invitationLink` and `setupLink` also use. */
export function approvalLink(token: string, environment: NodeJS.ProcessEnv = process.env): string {
  return absoluteAppLink("approve", token, "The approval link cannot be built", environment);
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

async function readRecipient(
  userId: string,
  db: MetadataExecutor = getDb(),
): Promise<Recipient | null> {
  const [row] = await db
    .select({
      id: users.id,
      /* Read from the envelope only (#1403 Q3). */
      emailEnc: users.emailEnc,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  const address = (await openInstanceMetadataReader(db))
    .text("users.email", row.id, { encrypted: row.emailEnc });
  return { id: row.id, email: address.value, displayName: row.displayName };
}

/** The executor a transaction callback is handed. */
type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Takes the per-user address lock an administrator's address change takes
 * (#1869), for the rest of `transaction`. The same lock serialises the
 * hourly mail allowance below (#1882): one lock per account, not two.
 */
async function lockUser(transaction: Transaction, userId: string): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userAddressLockKey(userId)}, 0))`);
}

/**
 * How many approval mails this account has had inside the last hour: one
 * row per mail sent or reserved to send, so a mail more than an hour old
 * never counts, however recently its sign-in was resent (#1604 P-20).
 */
async function sendsInWindow(
  userId: string,
  now: Date,
  db: MetadataExecutor = getDb(),
): Promise<number> {
  const since = new Date(now.getTime() - APPROVAL_SEND_WINDOW_MS);
  const [row] = await db
    .select({ sends: sql<number>`count(*)::int` })
    .from(signInApprovalSends)
    .where(and(eq(signInApprovalSends.userId, userId), gt(signInApprovalSends.sentAt, since)));
  return row?.sends ?? 0;
}

/**
 * Reserves one of the hour's mails: atomic check-and-reserve under the
 * per-user advisory lock, which the caller's `transaction` must already hold
 * (#1882). Requests arriving together queue on the lock, so each one counts
 * the reservations committed before it and no sixth mail is ever reserved.
 * Null when the hour's allowance is spent; otherwise the reservation's id
 * once it is written, which the caller commits before the mail goes. It is
 * kept whether or not the mail goes: the limit counts attempts, not
 * successes (#1879 ruling, note 64435), because a "failed" send can still
 * have reached the provider and the inbox -- the same fact that keeps a
 * maybe-delivered resend's link alive (#1891, #1896). The one exception is
 * an attempt that never handed a mail to the mailer at all (#1915 A-F1):
 * nothing can have arrived, so `releaseSend` gives its slot back.
 */
async function reserveSend(
  transaction: Transaction,
  approvalId: string,
  userId: string,
  now: Date,
): Promise<string | null> {
  if (await sendsInWindow(userId, now, transaction) >= APPROVAL_SENDS_PER_HOUR) return null;
  const [reservation] = await transaction.insert(signInApprovalSends)
    .values({ approvalId, userId, sentAt: now })
    .returning({ id: signInApprovalSends.id });
  return reservation.id;
}

/**
 * Gives back a reservation whose attempt never handed a mail to the mailer
 * (#1915 A-F1): no address to send to, or no link that could be built. Only
 * then -- a mail the mailer was given, whatever it answered, keeps its row
 * (#1879), so the hour never undercounts. Under the per-user lock the
 * reservation was taken under, which the caller's `transaction` must hold.
 */
async function releaseSend(transaction: Transaction, reservationId: string): Promise<void> {
  await transaction.delete(signInApprovalSends).where(eq(signInApprovalSends.id, reservationId));
}

/**
 * Undoes a resend whose mail provably never left (#1891, #1896): its staged
 * link is cleared, and its send time put back so the minute runs from the
 * last mail that actually went. The hour's count row stays (#1879), unless
 * `releaseReservation` names it because no mail was ever handed to the
 * mailer (#1915 A-F1); then it is released in this same locked transaction.
 * The staged link only while it is still this resend's, and the time only
 * while the row still carries this resend's own stamp, so a later resend
 * that committed meanwhile is never undone. Under the same lock as the
 * stamp. A maybe-delivered send never comes here: its link and its minute
 * stand. True when the earlier send time was put back.
 */
async function restoreSendTime(
  userId: string,
  approvalId: string,
  stagedDigest: string,
  stampedAt: Date,
  previousLastSentAt: Date | null,
  releaseReservation: string | null,
): Promise<boolean> {
  return getDb().transaction(async (transaction) => {
    await lockUser(transaction, userId);
    if (releaseReservation) await releaseSend(transaction, releaseReservation);
    await transaction.update(signInApprovals)
      .set({ stagedTokenHash: null })
      .where(and(eq(signInApprovals.id, approvalId), eq(signInApprovals.stagedTokenHash, stagedDigest)));
    const restored = await transaction.update(signInApprovals)
      .set({ lastSentAt: previousLastSentAt })
      .where(and(eq(signInApprovals.id, approvalId), eq(signInApprovals.lastSentAt, stampedAt)))
      .returning({ id: signInApprovals.id });
    return restored.length > 0;
  });
}

/** How long a finished or lapsed approval is kept before it is swept. */
const APPROVAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Deletes approvals that expired more than the retention ago, with their send
 * rows. Done as one more step of opening a sign-in approval, the way session
 * and step-up proof rows are swept; a failure here never blocks a sign-in
 * (#1603 P-29).
 */
async function sweepExpiredApprovals(now: Date): Promise<void> {
  try {
    await getDb()
      .delete(signInApprovals)
      .where(lt(signInApprovals.expiresAt, new Date(now.getTime() - APPROVAL_RETENTION_MS)));
  } catch {
    /* Housekeeping: sign-in goes ahead and the next one tries again. One
       bounded line, no row or address in it. */
    log.warn({
      event: "auth.local",
      state: "degraded",
      reason: "unexpected_failure",
      action: "check_database",
      impact: "none",
    });
  }
}

/**
 * What one approval mail did: the bounded failure, and whether the mail may
 * have arrived anyway (#1896). Nothing was sent when no address or link
 * existed, so those are never maybe delivered, and `handedOver` is false:
 * no mail reached the mailer, so its hourly slot is given back (#1915 A-F1).
 */
interface ApprovalMailOutcome {
  sendError: ApprovalSendError | null;
  maybeDelivered: boolean;
  handedOver: boolean;
}

/** Puts one approval mail on the wire. Never throws for a provider failure. */
async function mailApproval(
  recipient: Recipient,
  token: string,
  facts: SignInRequestFacts,
  requestedAt: Date,
  expiresAt: Date,
  options: SignInApprovalOptions,
): Promise<ApprovalMailOutcome> {
  if (!recipient.email) {
    /* No readable address means no way to ask (#969). The door stays shut and
       the administration screen's setup link is the way through, exactly as
       ADR-0027 §7 intends for an undeliverable mailbox. */
    return { sendError: "unknown", maybeDelivered: false, handedOver: false };
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
    return { sendError: "unknown", maybeDelivered: false, handedOver: false };
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
  return { sendError: outcome.sendError, maybeDelivered: outcome.maybeDelivered, handedOver: true };
}

/**
 * Opens a pending sign-in for a password that has already been verified, and
 * mails its approval link (ADR-0027 §1, §4-§6).
 *
 * The row is written BEFORE the mail is attempted, and its send outcome
 * recorded afterwards (#1151 A1-R1) -- the opposite order from the one this
 * function used to use, which mailed a token no row yet existed for. A crash
 * between the two halves used to leave the reader a mailed link with
 * nothing in the database for it to resolve against: a dead link with no
 * way even to ask for a fresh one, since collecting and resending both work
 * by looking up an existing row. Writing the row first means that same
 * crash instead leaves an unsent, harmless row that simply expires -- the
 * waiting tab never got a response either, so it retries and gets a new one.
 * A pending sign-in that could not be posted is still written. Every mail
 * handed to the mailer counts toward the hourly limit: its count row is
 * reserved before the send (#1879 A-R2) and kept when the send fails (#1879
 * ruling, note 64435), so five failed sends in an hour answer `limited`. A
 * mail that never reached the mailer (no readable address, or a link that
 * could not be built) gives its slot back (#1915 A-F1). Only a mail that went
 * sets the approval's own count and send time.
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

  await sweepExpiredApprovals(now);

  const db = getDb();
  /* The address is read and the row written under the per-user address lock
     an administrator's address change takes (#1869). A change that commits
     before this reads the new address; one that commits after it finds this
     row and expires it, so the link mailed below can only work while it
     goes to the address the account still has. The hour's mail is reserved
     under the same lock (#1882) and the transaction commits before the mail
     goes: nothing is held open across the network send. */
  const { recipient, row, limited, reservation } = await db.transaction(async (transaction) => {
    await lockUser(transaction, userId);
    const recipient = await readRecipient(userId, transaction);
    const [row] = await transaction.insert(signInApprovals).values({
      userId,
      tokenHash: secretDigest(token),
      claimHash: secretDigest(claim),
      userAgent: facts.userAgent ? facts.userAgent.slice(0, 256) : null,
      clientAddress: facts.clientAddress,
      expiresAt,
      sendCount: 0,
      lastSentAt: null,
    }).returning({ id: signInApprovals.id });
    const reservation = recipient ? await reserveSend(transaction, row.id, userId, now) : null;
    const limited = recipient
      ? reservation === null
      : await sendsInWindow(userId, now, transaction) >= APPROVAL_SENDS_PER_HOUR;
    return { recipient, row, limited, reservation };
  });

  let sendError: ApprovalSendError | null = null;
  if (!limited) {
    if (recipient && reservation) {
      const mailed = await mailApproval(recipient, token, facts, now, expiresAt, options);
      sendError = mailed.sendError;
      if (!mailed.handedOver) {
        /* No mail reached the mailer, so nothing can arrive: the slot goes
           back, under the lock it was reserved under (#1915 A-F1). */
        await db.transaction(async (transaction) => {
          await lockUser(transaction, userId);
          await releaseSend(transaction, reservation);
        });
      }
    } else {
      sendError = "unknown";
    }
  }

  if (!limited && sendError === null) {
    await db.update(signInApprovals)
      .set({ sendCount: 1, lastSentAt: now })
      .where(eq(signInApprovals.id, row.id));
  }

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
 * The row a link belongs to: by its current digest or by the staged one a
 * resend left while its mail's fate is unknown (#1896, ADR-0027 §8 amendment
 * of 2026-11-18). A digest is 256 random bits, so it names one row, and
 * the outcome, expiry and `consumed_at` are the row's: deciding through
 * either link spends both.
 */
function byLink(digest: string) {
  return or(eq(signInApprovals.tokenHash, digest), eq(signInApprovals.stagedTokenHash, digest));
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
    .where(byLink(secretDigest(token)))
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
 * password costs), and marks the password as needing a change (#1881): a
 * refusal means somebody else knew it, so the next sign-in with it lands on
 * the set-new-password step rather than in Orbit (NIST SP 800-63B section 5.1.1 (memorized secret verifiers)).
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
        createdAt: signInApprovals.createdAt,
      })
      .from(signInApprovals)
      .where(byLink(tokenHash))
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
      /* One refusal, counted -- and scheduled -- exactly as an ordinary wrong
         password is (ADR-0027 §8, #1151 A1-F1): `recordLocalCredentialFailure`
         is the one place the backoff schedule is applied, so a correct
         password that is then denied locks the credential the same way a
         wrong one does, rather than only incrementing a count nothing reads. */
      await recordLocalCredentialFailure(transaction, row.userId);
      /* The mark (#1881), in the same transaction as the refusal it records.
         The newest refusal's moment, so several in a row read as the one
         story the card tells, and any hold issued before this one is void. */
      /* Only the password this approval was asked for (#1881 fix review): an
         approval made before the credential's last change was for the OLD
         password, and refusing it says nothing about the new one, so it
         marks nothing. `password_changed_at` is the credential's own clock
         for exactly this (a rehash on sign-in does not move it). */
      await transaction
        .update(localCredentials)
        .set({ passwordChangeRequiredAt: decidedAt, updatedAt: decidedAt })
        .where(and(
          eq(localCredentials.userId, row.userId),
          lte(localCredentials.passwordChangedAt, row.createdAt),
        ));
    }

    return { recorded: true };
  });
}

/** What a caller's own session mint hands back, once spending the approval has succeeded. */
export interface MintedApprovalSession {
  token: string;
  expiresAt: Date;
}

/** Where a waiting tab stands. `unknown` covers every dead end at once. */
export type PendingSignInState =
  | { state: "waiting" }
  | { state: "approved"; userId: string; session?: MintedApprovalSession }
  /* Approved, but the account's password is marked (#1881): the approval is
     spent and the caller issues the change-password hold, never a session. */
  | { state: "password_change_required"; refusal: PasswordChangeRequiredError }
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
 *
 * `mintSession`, when given, is called with the spend already committed
 * (#1151 SR1-R7). Session creation lives in `@/lib/auth/session` and opens
 * its own transaction there, so it cannot share one with the update above;
 * without this, a crash or a transient failure between the two used to
 * strand a correctly approved sign-in forever -- the claim is single-use,
 * the mailed link is already consumed, and nothing was left to retry. A
 * callback that throws has its spend undone, conditioned on the row still
 * carrying the exact mark this call just wrote (never somebody else's), so
 * the next poll finds the approval open again rather than gone.
 */
export async function collectSignInApproval(
  claim: string,
  mintSession?: (userId: string) => Promise<MintedApprovalSession>,
): Promise<PendingSignInState> {
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

  const spentAt = new Date();
  const [claimed] = await db
    .update(signInApprovals)
    .set({ consumedAt: spentAt })
    .where(and(eq(signInApprovals.id, row.id), isNull(signInApprovals.consumedAt)))
    .returning({ id: signInApprovals.id });
  if (!claimed) return { state: "unknown" };
  if (!mintSession) return { state: "approved", userId: row.userId };

  try {
    const session = await mintSession(row.userId);
    return { state: "approved", userId: row.userId, session };
  } catch (error) {
    // A marked password (#1881) is an answer too: the approval stays spent --
    // it has done its job, the email factor is passed -- and what the tab
    // collects is the change-password hold, which runs its own ten minutes
    // from being issued, so a late press still leaves time to type.
    if (error instanceof PasswordChangeRequiredError) {
      return { state: "password_change_required", refusal: error };
    }
    // A disabled account is an answer, not a hiccup: the approval stays
    // spent, or re-enabling the account within the TTL would let the old
    // emailed link sign in with no new approval asked for.
    //
    // It is answered as "unknown", not "denied" (#1151 F12, S2): nobody
    // pressed "this wasn't me", so the human-refusal wording is false here,
    // and the pending endpoint has always documented this exact race as the
    // generic, no-retry-button "unknown" -- this is the only place that
    // promise was not kept. It still leaves the trail a real refusal
    // leaves: an audit row and a credential failure, so a sign-in that
    // slipped through right as the account was disabled still costs what a
    // wrong password costs, and the attempt is visible in the log rather
    // than invisible.
    if (error instanceof AuthError && error.code === "account_disabled") {
      await db.transaction(async (transaction) => {
        await transaction.insert(auditLog).values({
          householdId: null,
          actorUserId: row.userId,
          entityType: "user",
          entityId: row.userId,
          action: "sign_in_refused",
          changes: {},
        });
        await recordLocalCredentialFailure(transaction, row.userId);
      });
      return { state: "unknown" };
    }
    await db.update(signInApprovals)
      .set({ consumedAt: null })
      .where(and(eq(signInApprovals.id, row.id), eq(signInApprovals.consumedAt, spentAt)));
    throw error;
  }
}

/** What a resend did, in the words the waiting card has for each. */
export type ResendOutcome =
  | { state: "sent"; canResendAt: Date; sendError: ApprovalSendError | null }
  | { state: "too_soon"; canResendAt: Date }
  | { state: "limited" }
  | { state: "unknown" };

/**
 * Sends the waiting tab's link again, inside ADR-0027 §8's limits: one link
 * per mail that may have arrived, at most two (amendment of 2026-11-18,
 * #1896), so a confirmed resend REPLACES the token and an unconfirmed one
 * keeps the old link beside the new; not inside a minute of the last send;
 * and never past five sends for the account in an hour, where the answer is
 * to read the mail already sent rather than to ask for another.
 */
export async function resendSignInApproval(
  claim: string,
  options: SignInApprovalOptions = {},
): Promise<ResendOutcome> {
  if (claim.length === 0) return { state: "unknown" };
  const now = options.now ?? new Date();
  const db = getDb();

  const approvalFields = {
    id: signInApprovals.id,
    userId: signInApprovals.userId,
    tokenHash: signInApprovals.tokenHash,
    userAgent: signInApprovals.userAgent,
    clientAddress: signInApprovals.clientAddress,
    createdAt: signInApprovals.createdAt,
    expiresAt: signInApprovals.expiresAt,
    outcome: signInApprovals.outcome,
    consumedAt: signInApprovals.consumedAt,
    lastSentAt: signInApprovals.lastSentAt,
  };
  const claimHash = secretDigest(claim);
  const pendingIn = (row: { outcome: unknown; consumedAt: Date | null; expiresAt: Date } | undefined) =>
    !!row && !row.outcome && !row.consumedAt && row.expiresAt.getTime() > now.getTime();

  /* Read once unlocked only to learn whose lock to take. */
  const [found] = await db
    .select({
      userId: signInApprovals.userId,
      outcome: signInApprovals.outcome,
      consumedAt: signInApprovals.consumedAt,
      expiresAt: signInApprovals.expiresAt,
    })
    .from(signInApprovals)
    .where(eq(signInApprovals.claimHash, claimHash))
    .limit(1);
  if (!found || !pendingIn(found)) return { state: "unknown" };

  const token = createSecret();
  const tokenHash = secretDigest(token);

  /* Check-then-act as one locked step (#1891): the row is read again under
     the per-user lock (#1869, #1882), and the minute check, the hourly
     reservation and this send's time commit together before the mail goes.
     A resend queued behind this one reads the send time written here and
     answers too_soon, so one mail goes. The lock is not held across the
     network send.
     The new link is staged, not switched (#1879 ruling, note 64435; #1896):
     its digest is written to `staged_token_hash` here, under the lock, and
     the row keeps the old digest beside it while the mail is in flight, so
     both links read open and approve, and a process that stops before or
     during the send leaves a working link rather than a dead one. An earlier
     staged digest is replaced, so no more than two links ever resolve. */
  const reserved = await db.transaction(async (transaction) => {
    await lockUser(transaction, found.userId);
    const [row] = await transaction
      .select(approvalFields)
      .from(signInApprovals)
      .where(eq(signInApprovals.claimHash, claimHash))
      .limit(1);
    if (!row || !pendingIn(row)) return "unknown" as const;
    if (row.lastSentAt && now.getTime() - row.lastSentAt.getTime() < APPROVAL_RESEND_INTERVAL_MS) {
      return { state: "too_soon", canResendAt: new Date(row.lastSentAt.getTime() + APPROVAL_RESEND_INTERVAL_MS) } as const;
    }
    if (await sendsInWindow(row.userId, now, transaction) >= APPROVAL_SENDS_PER_HOUR) return "limited" as const;
    const recipient = await readRecipient(row.userId, transaction);
    if (!recipient) return "unknown" as const;
    const reservation = await reserveSend(transaction, row.id, row.userId, now);
    if (reservation === null) return "limited" as const;
    await transaction
      .update(signInApprovals)
      .set({ lastSentAt: now, stagedTokenHash: tokenHash })
      .where(eq(signInApprovals.id, row.id));
    return { state: "reserved", row, recipient, reservation } as const;
  });
  if (reserved === "limited") return { state: "limited" };
  if (reserved === "unknown") return { state: "unknown" };
  if (reserved.state === "too_soon") return reserved;
  const { row, recipient, reservation } = reserved;

  let mailed: ApprovalMailOutcome;
  try {
    mailed = await mailApproval(recipient, token, row, row.createdAt, row.expiresAt, options);
  } catch (error) {
    /* A throw may come after the mail went, so it is maybe delivered
       (#1896): both links, the send time and the count row all stay. One
       bounded line, then the error goes on. */
    log.warn({
      event: "auth.local",
      state: "degraded",
      reason: "unexpected_failure",
      action: "check_provider",
      impact: "sign_in_blocked",
    });
    throw error;
  }
  const { sendError, maybeDelivered, handedOver } = mailed;
  /* The minute runs from this send unless its time is put back below. */
  let sentAt = now;
  if (sendError === null) {
    /* The mail is in the post: promote its link to current and drop the old
       one. Only while the row still carries the digest read under the lock
       and this resend's staged one, so a row cancelled or rewritten
       meanwhile (#1898), or restaged by a later resend, is left as it is. */
    await db
      .update(signInApprovals)
      .set({ tokenHash, stagedTokenHash: null, sendCount: sql`${signInApprovals.sendCount} + 1` })
      .where(and(
        eq(signInApprovals.id, row.id),
        eq(signInApprovals.tokenHash, row.tokenHash),
        eq(signInApprovals.stagedTokenHash, tokenHash),
      ));
  } else if (!maybeDelivered) {
    /* The provider refused it or was never reached: the new link never
       arrived and the old one was never replaced, so the staged link is
       cleared and the send time goes back. The count row stays (#1879)
       unless no mail was ever handed to the mailer (#1915 A-F1). Once the
       earlier time is back, the next resend runs from it (#1915 A-F2); a
       row with no earlier send may be resent at once. */
    const restored = await restoreSendTime(
      row.userId, row.id, tokenHash, now, row.lastSentAt, handedOver ? null : reservation,
    );
    if (restored) sentAt = row.lastSentAt ?? new Date(now.getTime() - APPROVAL_RESEND_INTERVAL_MS);
  }
  /* Otherwise maybe delivered (#1896): a mail may be arriving with the new
     link, so both links stay until the next resend or a decision, and the
     minute runs from this send. */

  return {
    state: "sent",
    canResendAt: new Date(sentAt.getTime() + APPROVAL_RESEND_INTERVAL_MS),
    sendError,
  };
}

/**
 * The other half of a refusal (#1881, ADR-0027 amendment of 2026-11-17):
 * when a refused sign-in marked this account's password, or null.
 *
 * A pure read since #1881. The mark is security state, not a notice: it is
 * not spent by being shown and has no time limit, and only a saved password
 * clears it (`writePasswordHash`). The moment is the newest refusal's.
 */
export async function readDeniedSignInNotice(userId: string): Promise<{ deniedAt: Date } | null> {
  const [row] = await getDb()
    .select({ requiredAt: localCredentials.passwordChangeRequiredAt })
    .from(localCredentials)
    .where(eq(localCredentials.userId, userId))
    .limit(1);
  return row?.requiredAt ? { deniedAt: row.requiredAt } : null;
}
