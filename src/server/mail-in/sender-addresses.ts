/**
 * The addresses a member may send from, and how one becomes believable
 * (ADR-0017 decision 3, slice 4, orbit#745).
 *
 * A sender address is a CLAIM, not a credential. Seeding one from the account
 * or the SSO `email` claim, or letting a member type one in, proves nothing:
 * until Orbit has sent a one-use link to that address and somebody has opened
 * it while signed in as that member, the row attributes nothing at all. That
 * is what stops one member claiming another's address in order to receive
 * their forwarded documents.
 *
 * Two smaller rules follow from the same thought. An address is unique across
 * the instance, because one address attributes to exactly one member and a
 * shared claim would make attribution a guess. And the verification token is
 * never stored — only its digest — for the same reason a session token is not:
 * a copied database must not hand somebody else the link.
 *
 * This lives outside `core/` because it needs `getDb`/schema access and the
 * SMTP transport, which `core/` is not allowed (see this directory's README).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { externalIdentities, mailInSenderAddresses, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import {
  createSmtpTransport,
  getNotificationWorkerConfig,
  type NotificationWorkerConfig,
} from "@/server/notification-worker";
import { normalizeSenderAddress } from "./core/sender-authentication";

/** How long a verification link is good for. One use, and not for long. */
export const SENDER_VERIFICATION_TTL_MS = 24 * 3_600_000;

/** A member cannot claim an unbounded number of addresses. */
export const MAX_SENDER_ADDRESSES_PER_USER = 10;

export type SenderAddressSource = "account" | "sso" | "manual";

export interface SenderAddressView {
  id: string;
  address: string;
  source: SenderAddressSource;
  verified: boolean;
  /** Set while a link is outstanding, so the screen can say "check your mail". */
  verificationPending: boolean;
}

/** Explicit seams so tests never open a socket; the defaults are the real ones. */
export interface SenderAddressDependencies {
  sendMail?: (message: { from: string; to: string; subject: string; text: string }) => Promise<void>;
  smtpConfig?: () => NotificationWorkerConfig;
  appUrl?: () => string;
  now?: () => Date;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function viewOf(row: typeof mailInSenderAddresses.$inferSelect, now: Date): SenderAddressView {
  return {
    id: row.id,
    address: row.address,
    source: row.source,
    verified: row.verifiedAt !== null,
    verificationPending: row.verifiedAt === null
      && row.verificationExpiresAt !== null
      && row.verificationExpiresAt.getTime() > now.getTime(),
  };
}

/** The member's own addresses. Never anybody else's — there is no id to pass. */
export async function listSenderAddresses(
  userId: string,
  dependencies: SenderAddressDependencies = {},
): Promise<SenderAddressView[]> {
  const now = dependencies.now?.() ?? new Date();
  const rows = await getDb().select().from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId))
    .orderBy(mailInSenderAddresses.createdAt);
  return rows.map((row) => viewOf(row, now));
}

/** Whether this member has anything that can attribute mail to them yet. */
export async function hasVerifiedSenderAddress(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.userId, userId), isNotNull(mailInSenderAddresses.verifiedAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * Seeds the member's first, unverified address from what Orbit already knows:
 * the local account's email, or the `email` claim their identity provider
 * sent. It is deliberately unverified — Orbit knowing an address is not the
 * member proving they send from it — and the relay page offers an override
 * box, which is what `addSenderAddress` below is for.
 *
 * Idempotent, and silent when the address already belongs to somebody else:
 * seeding must never take an address away from the member who verified it.
 */
export async function seedSenderAddress(userId: string, dependencies: SenderAddressDependencies = {}): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  const [existing] = await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId)).limit(1);
  if (existing) return;

  const [account] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const [identity] = await getDb().select({ id: externalIdentities.id }).from(externalIdentities)
    .where(eq(externalIdentities.userId, userId)).limit(1);
  const address = normalizeSenderAddress(account?.email);
  if (!address) return;

  await getDb().insert(mailInSenderAddresses).values({
    userId,
    address,
    source: identity ? "sso" : "account",
    updatedAt: now,
  }).onConflictDoNothing();
}

/** Adds an address the member says they send from, still unverified. */
export async function addSenderAddress(
  userId: string,
  candidate: string,
  dependencies: SenderAddressDependencies = {},
): Promise<SenderAddressView> {
  const now = dependencies.now?.() ?? new Date();
  const address = normalizeSenderAddress(candidate);
  if (!address) throw new AppError("sender_address_invalid", "That is not an address Orbit can use", 400);

  const owned = await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId));
  if (owned.length >= MAX_SENDER_ADDRESSES_PER_USER) {
    throw new AppError("sender_address_limit", "That is as many sending addresses as one member may hold", 409);
  }

  const [inserted] = await getDb().insert(mailInSenderAddresses)
    .values({ userId, address, source: "manual", updatedAt: now })
    .onConflictDoNothing()
    .returning();
  if (inserted) return viewOf(inserted, now);

  /* Taken. It may be this member's own row, which is simply a repeat; if it
     is somebody else's, the refusal says only that the address is unavailable
     — naming the member who holds it would turn this endpoint into a way of
     asking who owns an address. */
  const [mine] = await getDb().select().from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.userId, userId), eq(mailInSenderAddresses.address, address))).limit(1);
  if (mine) return viewOf(mine, now);
  throw new AppError("sender_address_unavailable", "That address is not available", 409);
}

/** Removes one of the member's own addresses, by its id and their id. */
export async function removeSenderAddress(userId: string, id: string): Promise<void> {
  await getDb().delete(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId)));
}

function verificationUrl(appUrl: string, token: string): string {
  const url = new URL(appUrl);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
    throw new AppError("unsafe_input", "The application address is unavailable", 503);
  }
  const link = new URL("/api/settings/mail-relay/verify", url.origin);
  link.searchParams.set("token", token);
  return link.href;
}

/**
 * Issues a fresh one-use link and sends it to the address itself.
 *
 * The link goes to the ADDRESS, not to the member's account mail: the whole
 * point is proving that whoever holds this mailbox is this member. Re-issuing
 * replaces any outstanding token, so an old link stops working the moment a
 * new one is asked for.
 */
export async function sendSenderVerification(
  userId: string,
  id: string,
  dependencies: SenderAddressDependencies = {},
): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  const [row] = await getDb().select().from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId))).limit(1);
  if (!row) throw new AppError("sender_address_unknown", "That address is not on this account", 404);
  if (row.verifiedAt) return;

  let smtp: NotificationWorkerConfig;
  try {
    smtp = (dependencies.smtpConfig ?? getNotificationWorkerConfig)();
  } catch {
    throw new AppError("smtp_not_configured", "Orbit cannot send mail, so it cannot check this address", 503);
  }
  if (!smtp.smtpUrl || !smtp.smtpFrom) {
    throw new AppError("smtp_not_configured", "Orbit cannot send mail, so it cannot check this address", 503);
  }

  const token = randomBytes(32).toString("base64url");
  const link = verificationUrl((dependencies.appUrl ?? (() => process.env.APP_URL ?? ""))(), token);
  await getDb().update(mailInSenderAddresses).set({
    verificationTokenDigest: digestToken(token),
    verificationExpiresAt: new Date(now.getTime() + SENDER_VERIFICATION_TTL_MS),
    updatedAt: now,
  }).where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId)));

  const send = dependencies.sendMail ?? defaultSender(smtp);
  await send({
    from: smtp.smtpFrom,
    to: row.address,
    subject: "Check your Orbit sending address",
    text: [
      "Orbit is checking that you send mail from this address.",
      "",
      `Open this link while signed in to Orbit, within 24 hours: ${link}`,
      "",
      "Until you do, mail you forward to Orbit from this address is not matched to you.",
      "If you did not ask for this, ignore it — nothing changes.",
    ].join("\n"),
  });
}

function defaultSender(smtp: NotificationWorkerConfig) {
  return async (message: { from: string; to: string; subject: string; text: string }) => {
    const transporter = createSmtpTransport(smtp);
    try {
      await transporter.sendMail(message);
    } finally {
      transporter.close();
    }
  };
}

/**
 * Consumes a one-use link.
 *
 * Three things have to hold at once, and any of them failing gives the same
 * bounded refusal: the token digest matches a row, that row belongs to the
 * signed-in member, and the link has not expired. Requiring the session is
 * what makes an intercepted link worthless — reading the member's mail is not
 * enough, you must also be them.
 *
 * The comparison is constant-time, and the token is cleared on success so the
 * link cannot be replayed.
 */
export async function verifySenderAddress(
  userId: string,
  token: string,
  dependencies: SenderAddressDependencies = {},
): Promise<SenderAddressView> {
  const now = dependencies.now?.() ?? new Date();
  const refuse = () => new AppError("sender_verification_invalid", "That link is not usable", 400);
  if (!token || token.length > 512) throw refuse();
  const digest = digestToken(token);

  const candidates = await getDb().select().from(mailInSenderAddresses)
    .where(and(
      eq(mailInSenderAddresses.userId, userId),
      isNull(mailInSenderAddresses.verifiedAt),
      isNotNull(mailInSenderAddresses.verificationTokenDigest),
    ));
  const digestBytes = Buffer.from(digest, "utf8");
  const match = candidates.find((row) => {
    const stored = Buffer.from(row.verificationTokenDigest ?? "", "utf8");
    return stored.length === digestBytes.length && timingSafeEqual(stored, digestBytes);
  });
  if (!match || !match.verificationExpiresAt || match.verificationExpiresAt.getTime() <= now.getTime()) throw refuse();

  const [verified] = await getDb().update(mailInSenderAddresses).set({
    verifiedAt: now,
    verificationTokenDigest: null,
    verificationExpiresAt: null,
    updatedAt: now,
  }).where(and(
    eq(mailInSenderAddresses.id, match.id),
    eq(mailInSenderAddresses.userId, userId),
    isNull(mailInSenderAddresses.verifiedAt),
  )).returning();
  if (!verified) throw refuse();
  return viewOf(verified, now);
}

/**
 * The member a verified address belongs to, or nobody.
 *
 * This is the whole of attribution's database side, and it is deliberately
 * narrow: one exact normalised address, verified only, and never a prefix, a
 * domain or a pattern. A disabled account attributes nothing.
 */
export async function userForVerifiedSender(address: string): Promise<string | undefined> {
  const normalized = normalizeSenderAddress(address);
  if (!normalized) return undefined;
  const [row] = await getDb().select({ userId: mailInSenderAddresses.userId, disabledAt: users.disabledAt })
    .from(mailInSenderAddresses)
    .innerJoin(users, eq(users.id, mailInSenderAddresses.userId))
    .where(and(eq(mailInSenderAddresses.address, normalized), isNotNull(mailInSenderAddresses.verifiedAt)))
    .limit(1);
  return row && !row.disabledAt ? row.userId : undefined;
}
