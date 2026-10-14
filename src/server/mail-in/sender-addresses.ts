/**
 * The addresses a member may send from, and how one becomes believable
 * (ADR-0017 decision 3, slice 4, orbit#745).
 *
 * A sender address is a CLAIM, not a credential. Seeding one from the account
 * or the SSO `email` claim proves nothing: until a one-use link sent to that
 * address has been opened while signed in as that member, the row attributes
 * nothing at all. That
 * is what stops one member claiming another's address in order to receive
 * their forwarded documents.
 *
 * Two smaller rules follow from the same thought. An address is unique across
 * the instance, because one address attributes to exactly one member and a
 * shared claim would make attribution a guess. And the verification token is
 * never stored — only its digest — for the same reason a session token is not:
 * a copied database must not hand somebody else the link.
 *
 * Since #969 the address itself is encrypted metadata under the instance key
 * (ADR-0024): `address_enc` holds it, `address_index` is the blind index that
 * attribution and the uniqueness rule both look up. There is no plaintext
 * column: the address is read from `address_enc` alone.
 *
 * This lives outside `core/` because it needs `getDb`/schema access and the
 * SMTP transport, which `core/` is not allowed (see this directory's README).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { externalIdentities, mailInSenderAddresses, users } from "@/db/schema";
import { AppError, RateLimitedError } from "@/lib/app-error";
import { log } from "@/lib/logger";
import {
  openInstanceMetadataReader,
  requireInstanceMetadataWriter,
  type MetadataCipher,
  type MetadataExecutor,
  type MetadataFieldState,
} from "@/server/metadata/fields";
import { metadataCryptoAvailable } from "@/server/metadata/keys";
import {
  createSmtpTransport,
  getNotificationWorkerConfig,
  type NotificationWorkerConfig,
} from "@/server/notification-worker";
import { normalizeSenderAddress } from "./core/sender-authentication";

export type SenderAddressSource = "account" | "sso" | "manual";

export interface SenderAddressView {
  id: string;
  /**
   * Null when the address cannot be read at all (#969): a locked instance, or
   * a value that will not authenticate. Never an empty string — an address
   * Orbit cannot read is absent, and `metadataStatus` says why.
   */
  address: string | null;
  source: SenderAddressSource;
  verified: boolean;
  /** Set while a link is outstanding, so the screen can say "check your mail". */
  verificationPending: boolean;
  /** When the latest link lapses, or lapsed (ISO); null once checked or when none was ever sent. */
  expiresAt: string | null;
  /** Present only when something is unreadable, as elsewhere (ADR-0024 decision 5). */
  metadataStatus?: { address?: MetadataFieldState };
}

/** How long a verification link is good for. One use, and not for long. */
export const SENDER_VERIFICATION_TTL_MS = 24 * 3_600_000;

/** The check email goes out at most once in this long per member (#1403 D2). */
export const SENDER_CHECK_MIN_GAP_MS = 60_000;
/** ...and at most `SENDER_CHECK_DAILY_LIMIT` times in a rolling window this long. */
export const SENDER_CHECK_WINDOW_MS = 24 * 3_600_000;
export const SENDER_CHECK_DAILY_LIMIT = 5;

/**
 * The whole send, mailer included, gives up after this long (review of #1403
 * D2), so a mailer that never answers cannot hold the request open
 * indefinitely. Tests shorten it with
 * `setSenderSendDeadlineForTests`; nothing else changes it.
 */
export const SENDER_SEND_DEADLINE_MS = 15_000;
let sendDeadlineMs = SENDER_SEND_DEADLINE_MS;
/** Test seam: `null` restores the real deadline. */
export function setSenderSendDeadlineForTests(milliseconds: number | null): void {
  sendDeadlineMs = milliseconds ?? SENDER_SEND_DEADLINE_MS;
}

/*
 * Every refusal of the check is worded here, once (ADR-0034 decision 4,
 * #1410): the browser shows `error.message` as it arrives and rewrites
 * nothing. One voice: "not sent — <why>. <what to do>".
 */
export const SENDER_CHECK_WORDS = {
  alreadyChecked: "already checked — nothing to send",
  noAddress: "not sent — this account has no registered email address to check",
  noMail: "not sent — Orbit has no outbound mail set up yet. ask your administrator",
  locked: "not sent — Orbit cannot read your address right now. try again later",
  tooSoon: "not sent — too soon. try again in a few minutes",
  dailyLimit: "not sent — daily limit reached. try again tomorrow.",
  mailerTimeout: "not sent — the mail server did not answer in time. try again later",
  mailerRefused: "not sent — the mail server refused the message. try again later",
  unreadable: "not sent — Orbit cannot read the address it holds for you. ask your administrator",
  noAppUrl: "not sent — Orbit does not know its own web address. ask your administrator",
} as const;

/**
 * Whole seconds to wait before another check email may be sent, or 0 when one
 * may go now. `sent` holds the counted sends (any order). The wait is until 60
 * seconds after the newest send, or until the oldest of the five leaves the
 * rolling 24 hours, whichever is later; rounded up to a whole second.
 */
export function senderCheckWaitSeconds(sent: readonly Date[], now: Date): number {
  const inWindow = sent.map((at) => at.getTime()).filter((at) => at > now.getTime() - SENDER_CHECK_WINDOW_MS).sort((a, b) => a - b);
  let readyAt = now.getTime();
  if (inWindow.length > 0) readyAt = Math.max(readyAt, inWindow[inWindow.length - 1] + SENDER_CHECK_MIN_GAP_MS);
  if (inWindow.length >= SENDER_CHECK_DAILY_LIMIT) {
    readyAt = Math.max(readyAt, inWindow[inWindow.length - SENDER_CHECK_DAILY_LIMIT] + SENDER_CHECK_WINDOW_MS);
  }
  return Math.ceil((readyAt - now.getTime()) / 1000);
}

/**
 * Which rule refuses a send now, with the wait from `senderCheckWaitSeconds`,
 * or null when one may go. "day" once the rolling window already holds the
 * daily limit, so the member is not told "a few minutes" when the wait runs
 * to the next day; "gap" otherwise.
 */
export function senderCheckRefusal(sent: readonly Date[], now: Date): { seconds: number; limit: "gap" | "day" } | null {
  const seconds = senderCheckWaitSeconds(sent, now);
  if (seconds <= 0) return null;
  const inWindow = sent.filter((at) => at.getTime() > now.getTime() - SENDER_CHECK_WINDOW_MS).length;
  return { seconds, limit: inWindow >= SENDER_CHECK_DAILY_LIMIT ? "day" : "gap" };
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

/** The stored address, decrypted under the INSTANCE key (#969). */
function readAddress(
  cipher: MetadataCipher,
  row: { id: string; addressEnc: string | null },
) {
  return cipher.text("mail_in_sender_addresses.address", row.id, { encrypted: row.addressEnc });
}

/**
 * Any row already claiming this address — this member's or anybody else's.
 *
 * The blind index is what carries "one account per sending address" across the
 * encryption. With no index (nothing to index) there is no claim to find.
 */
async function existingClaim(
  addressIndex: string | null,
  executor: MetadataExecutor = getDb(),
): Promise<typeof mailInSenderAddresses.$inferSelect | undefined> {
  if (addressIndex === null) return undefined;
  const [row] = await executor.select().from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.addressIndex, addressIndex))
    .limit(1);
  return row;
}

/**
 * Runs `work` in one transaction holding a per-member advisory lock, so a
 * member's seed, list and send-reservation cannot interleave (two presses, or
 * a press and a settings read). Advisory rather than a lock on the `users`
 * row, which would hold up sign-in.
 *
 * The lock is tried, never waited for: a busy lock means another check is
 * already in flight, which is "too soon", and nothing queues holding a pool
 * connection.
 */
export async function withSenderLock<T>(userId: string, work: (executor: MetadataExecutor) => Promise<T>): Promise<T> {
  return getDb().transaction(async (transaction) => {
    const rows = await transaction.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`orbit:mail-relay-sender:${userId}`}, 0)) as acquired`);
    if ((rows as unknown as { acquired?: unknown }[])[0]?.acquired !== true) {
      throw new RateLimitedError("sender_check_too_soon", SENDER_CHECK_WORDS.tooSoon, 5);
    }
    return work(transaction);
  });
}

/**
 * The address the member is registered with right now: the account's email,
 * which is the provider's `email` claim once sign-in has rewritten it. Null
 * when there is none or it cannot be read.
 */
async function registeredAddressOf(executor: MetadataExecutor, reader: MetadataCipher, userId: string): Promise<string | null> {
  const [account] = await executor.select({ emailEnc: users.emailEnc })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!account) return null;
  const value = reader.text("users.email", userId, { encrypted: account.emailEnc }).value;
  return normalizeSenderAddress(value ?? undefined) ?? null;
}

function viewOf(
  row: typeof mailInSenderAddresses.$inferSelect,
  now: Date,
  cipher: MetadataCipher,
): SenderAddressView {
  const address = readAddress(cipher, row);
  const linkLive = row.verifiedAt === null
    && row.verificationExpiresAt !== null
    && row.verificationExpiresAt.getTime() > now.getTime();
  return {
    id: row.id,
    address: address.value,
    source: row.source,
    verified: row.verifiedAt !== null,
    verificationPending: linkLive,
    /* A lapsed link still reports when it lapsed, so the screen can say "the
       last link lapsed"; only a checked row, or one never sent a link, has none. */
    expiresAt: row.verifiedAt === null && row.verificationExpiresAt ? row.verificationExpiresAt.toISOString() : null,
    metadataStatus: address.state ? { address: address.state } : undefined,
  };
}

/** The member's own address rows (at most one). Never anybody else's — there is no id to pass. */
export async function listSenderAddresses(
  userId: string,
  dependencies: SenderAddressDependencies = {},
  executor: MetadataExecutor = getDb(),
): Promise<SenderAddressView[]> {
  const now = dependencies.now?.() ?? new Date();
  const rows = await executor.select().from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId))
    .orderBy(mailInSenderAddresses.createdAt);
  const cipher = await openInstanceMetadataReader(executor);
  const views = rows.map((row) => viewOf(row, now, cipher));
  if (views.length === 0) return views;
  /* A row that READS as an address other than the registered one, or that
     has lost its claim, is not the member's any more (it may be kept only for
     its send times, see seeding); a row that cannot be read at all stays,
     with its state. */
  const registered = await registeredAddressOf(executor, cipher, userId);
  return views.filter((view, index) => view.address === null
    || (rows[index].addressIndex !== null && normalizeSenderAddress(view.address) === registered));
}

/**
 * Whether this member has anything that can attribute mail to them yet: a
 * checked row for the address they are registered with NOW. A row for an
 * address they have since moved away from counts for nothing.
 */
export async function hasVerifiedSenderAddress(userId: string, executor: MetadataExecutor = getDb()): Promise<boolean> {
  const rows = await executor.select().from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.userId, userId), isNotNull(mailInSenderAddresses.verifiedAt)));
  if (rows.length === 0) return false;
  const reader = await openInstanceMetadataReader(executor);
  const registered = await registeredAddressOf(executor, reader, userId);
  return rows.some((row) => normalizeSenderAddress(readAddress(reader, row).value ?? undefined) === registered);
}

/**
 * Seeds the member's one, unverified address from what Orbit already knows:
 * the local account's email, or the `email` claim their identity provider
 * sent. It is deliberately unverified — Orbit knowing an address is not the
 * member proving they send from it.
 *
 * The row FOLLOWS the registered address (decision 7c). If the member's row
 * carries a different address from the one now registered, it is replaced by
 * an unverified row for the current one, so verification starts over and the
 * old address stops attributing. Otherwise it is idempotent.
 *
 * Silent when the address already belongs to somebody else: seeding must
 * never take an address away from the member who verified it. In that case
 * the stale row is made inert rather than dropped, because it is the only
 * place the member's send times are kept.
 *
 * Only a row that READS as a different address is dropped. A row that cannot
 * be read while the key is locked proves nothing about which address it holds
 * (it may well be the verified, registered one), so it is left alone. With
 * the key working, a row that fails authentication is damaged and can never
 * be read again: it is dropped and the registered address seeded afresh, so
 * the member is not stranded. The fresh row keeps the damaged row's
 * verification when that row was verified and its blind index is the
 * registered address's: the index is what attribution and "one account per
 * address" already trust, and the ciphertext is only the display copy.
 * Otherwise the fresh row is unverified and the check must be earned again.
 */
export async function seedSenderAddress(
  userId: string,
  dependencies: SenderAddressDependencies = {},
  executor?: MetadataExecutor,
): Promise<void> {
  if (!executor) {
    await withSenderLock(userId, (locked) => seedSenderAddress(userId, dependencies, locked));
    return;
  }
  const now = dependencies.now?.() ?? new Date();
  const existingRows = await executor.select().from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId));

  /* Seeding writes an encrypted claim now (#969), so it needs the instance
     key. A locked instance simply does not seed: this runs on the member's own
     read of the relay page, and refusing that whole page for a convenience is
     the wrong trade — the next read seeds it once the key is back. */
  if (!metadataCryptoAvailable()) return;

  const [account] = await executor.select({ emailEnc: users.emailEnc })
    .from(users).where(eq(users.id, userId)).limit(1);
  const [identity] = await executor.select({ id: externalIdentities.id }).from(externalIdentities)
    .where(eq(externalIdentities.userId, userId)).limit(1);
  const reader = await openInstanceMetadataReader(executor);
  /* Without the key nothing below can be told apart from "unreadable", and an
     unreadable row is never deleted. */
  if (reader.locked) return;
  const accountEmail = account
    ? reader.text("users.email", userId, { encrypted: account.emailEnc }).value
    : null;
  const address = normalizeSenderAddress(accountEmail ?? undefined);
  if (!address) return;

  let matching: typeof mailInSenderAddresses.$inferSelect | undefined;
  let unreadable: typeof mailInSenderAddresses.$inferSelect | undefined;
  const stale: Array<typeof mailInSenderAddresses.$inferSelect> = [];
  const damaged: Array<typeof mailInSenderAddresses.$inferSelect> = [];
  for (const row of existingRows) {
    const { value, state } = readAddress(reader, row);
    if (state === "metadata_integrity_failed") damaged.push(row);
    else if (value === null) unreadable ??= row;
    /* A row stripped of its claim is retired, whatever it reads as: if the
       member's address comes back to it, it is replaced by a fresh row with
       the claim, never revived without one. */
    else if (row.addressIndex === null) stale.push(row);
    else if (normalizeSenderAddress(value) === address) matching ??= row;
    else stale.push(row);
  }

  const cipher = await requireInstanceMetadataWriter(executor);
  const addressIndex = cipher.senderAddressIndex(address);
  /* Damaged but proven: the proof still holds for the registered address, so
     the replacement carries it rather than turning the member into a
     stranger until they check again. */
  const proven = damaged.find((row) => row.addressIndex === addressIndex && row.verifiedAt !== null);
  const staleIds = stale.map((row) => row.id);
  /* The send times are the member's, not the address's, and they survive any
     change of address: every replaced row's times are merged into wherever
     the member's row ends up. */
  const staleTimes = [...stale, ...damaged].flatMap((row) => row.checkSentAt);
  const removeStale = () => executor.delete(mailInSenderAddresses).where(and(
    eq(mailInSenderAddresses.userId, userId),
    inArray(mailInSenderAddresses.id, staleIds),
  ));

  /* Dropped first: a damaged row still holds its blind index, which is most
     likely the registered address's, and would otherwise block the reseed.
     The caller's transaction holds the delete and the insert below together,
     so there is no moment with no claim. */
  if (damaged.length > 0) {
    await executor.delete(mailInSenderAddresses).where(and(
      eq(mailInSenderAddresses.userId, userId),
      inArray(mailInSenderAddresses.id, damaged.map((row) => row.id)),
    ));
    log.warn({
      event: "mail-relay.sender",
      state: "degraded",
      reason: "metadata_integrity_failed",
      action: "inspect_admin_diagnostics",
      impact: (proven || (matching ?? unreadable)?.verifiedAt) ? "none" : "sender_check_required",
    });
  }

  const home = matching ?? unreadable;
  if (home) {
    if (staleTimes.length > 0 || stale.length > 0) {
      await executor.update(mailInSenderAddresses)
        .set({ checkSentAt: mergeChecks([...home.checkSentAt, ...staleTimes], now), updatedAt: now })
        .where(eq(mailInSenderAddresses.id, home.id));
      if (stale.length > 0) await removeStale();
    }
    return;
  }

  /* An address somebody already claims is left exactly as it is: seeding must
     never take an address away from the member who verified it. */
  if (await existingClaim(addressIndex, executor)) {
    /* No row can be made, so the old rows are the only place the send times
       live. They stay, but stop being anything: unchecked, no link, no claim
       on their old address; with no claim they are never listed, never sent
       a link and never attribute. The next seed with room replaces them,
       including when the member's address returns to what they read as. */
    for (const row of stale) {
      if (row.verifiedAt === null && row.verificationTokenDigest === null && row.addressIndex === null) continue;
      await executor.update(mailInSenderAddresses).set({
        verifiedAt: null,
        verificationTokenDigest: null,
        verificationExpiresAt: null,
        addressIndex: null,
        updatedAt: now,
      }).where(eq(mailInSenderAddresses.id, row.id));
    }
    return;
  }
  if (stale.length > 0) await removeStale();

  /* The row id exists before the address is encrypted: the content AAD binds
     the ciphertext to its row, so a value cannot be replayed into another
     claim (ADR-0024 decision 3). */
  const id = randomUUID();
  await executor.insert(mailInSenderAddresses).values({
    id,
    userId,
    addressEnc: cipher.encryptText("mail_in_sender_addresses.address", id, address),
    addressIndex,
    source: identity ? "sso" : "account",
    verifiedAt: proven?.verifiedAt ?? null,
    checkSentAt: mergeChecks(staleTimes, now),
    updatedAt: now,
  }).onConflictDoNothing();
}

/** The counted sends still inside the rolling window, oldest first, at most the daily limit. */
function mergeChecks(times: readonly Date[], now: Date): Date[] {
  return times
    .filter((at) => at.getTime() > now.getTime() - SENDER_CHECK_WINDOW_MS)
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(-SENDER_CHECK_DAILY_LIMIT);
}

function verificationUrl(appUrl: string, token: string): string {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new AppError("app_url_not_configured", SENDER_CHECK_WORDS.noAppUrl, 503);
  }
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
 * new one is asked for. Returns where it went and when the link lapses.
 */
export async function sendSenderVerification(
  userId: string,
  id: string,
  dependencies: SenderAddressDependencies = {},
): Promise<{ address: string; expiresAt: Date }> {
  return deliver(await withSenderLock(userId, (executor) => reserveSend(executor, userId, id, dependencies)));
}

/**
 * The whole "check my address" request for one member: seed, read and
 * reserve the send in ONE short transaction under the member's lock, then
 * hand the message to the mailer with nothing held. A press refused before
 * the reservation leaves nothing behind; once reserved, the attempt counts
 * whatever the mailer does.
 */
export async function requestSenderCheck(
  userId: string,
  dependencies: SenderAddressDependencies = {},
): Promise<{ address: string; expiresAt: Date }> {
  return withSenderLock(userId, async (executor) => {
    await seedSenderAddress(userId, dependencies, executor);
    const [row] = await listSenderAddresses(userId, dependencies, executor);
    if (!row) {
      throw new AppError("sender_address_unavailable", SENDER_CHECK_WORDS.noAddress, 409);
    }
    if (row.verified) throw new AppError("sender_already_verified", SENDER_CHECK_WORDS.alreadyChecked, 409);
    return reserveSend(executor, userId, row.id, dependencies);
  }).then(deliver);
}

type MailMessage = { from: string; to: string; subject: string; text: string };
interface ReservedSend {
  id: string;
  address: string;
  expiresAt: Date;
  send: (message: MailMessage) => Promise<void>;
  message: MailMessage;
  /** The digest this attempt wrote, and the link that stood before it. */
  digest: string;
  previous: { digest: string | null; expiresAt: Date | null };
}

/** The slow part, run after the reservation has committed. */
async function deliver({ id, address, expiresAt, send, message, digest, previous }: ReservedSend): Promise<{ address: string; expiresAt: Date }> {
  try {
    await sendWithDeadline(send, message);
  } catch (error) {
    /* A refused send delivered nothing, so put back whatever link stood
       before (none, or an earlier delivered one) instead of leaving a link
       nobody was sent. Only while the row still holds this attempt's digest,
       so a newer press's link is never touched; the attempt still counts. */
    if (error instanceof AppError && error.code === "sender_mailer_refused") {
      await getDb().update(mailInSenderAddresses).set({
        verificationTokenDigest: previous.digest,
        verificationExpiresAt: previous.expiresAt,
      }).where(and(
        eq(mailInSenderAddresses.id, id),
        eq(mailInSenderAddresses.verificationTokenDigest, digest),
      ));
    }
    throw error;
  }
  return { address, expiresAt };
}

async function reserveSend(
  executor: MetadataExecutor,
  userId: string,
  id: string,
  dependencies: SenderAddressDependencies,
): Promise<ReservedSend> {
  const now = dependencies.now?.() ?? new Date();
  const [row] = await executor.select().from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId))).limit(1);
  /* A row kept only for its send times has no claim and is not listed, so it
     is answered as if it were not there. */
  if (!row || row.addressIndex === null) {
    throw new AppError("sender_address_unknown", "That address is not on this account", 404);
  }
  if (row.verifiedAt) throw new AppError("sender_already_verified", SENDER_CHECK_WORDS.alreadyChecked, 409);

  /* The link goes to the address itself, so an address Orbit cannot read is an
     address Orbit cannot check (#969). Refused rather than sent anywhere: a
     missing value must never become an empty or invented recipient. */
  const read = readAddress(await openInstanceMetadataReader(executor), row);
  const address = read.value;
  if (!address) {
    /* With the key available the value itself is damaged: a different refusal
       from "the key is away", because waiting will not fix it. */
    if (read.state === "metadata_locked") throw new AppError("metadata_locked", SENDER_CHECK_WORDS.locked, 503);
    throw new AppError("sender_address_unreadable", SENDER_CHECK_WORDS.unreadable, 409);
  }

  let smtp: NotificationWorkerConfig;
  try {
    smtp = (dependencies.smtpConfig ?? getNotificationWorkerConfig)();
  } catch {
    throw new AppError("smtp_not_configured", SENDER_CHECK_WORDS.noMail, 503);
  }
  if (!smtp.smtpUrl || !smtp.smtpFrom) {
    throw new AppError("smtp_not_configured", SENDER_CHECK_WORDS.noMail, 503);
  }

  const token = randomBytes(32).toString("base64url");
  const link = verificationUrl((dependencies.appUrl ?? (() => process.env.APP_URL ?? ""))(), token);
  const expiresAt = new Date(now.getTime() + SENDER_VERIFICATION_TTL_MS);
  const send = dependencies.sendMail ?? defaultSender(smtp);

  /* Check, then record the attempt and its token, in the caller's transaction
     under the member's lock (two-step "lock, then check-and-record", as the
     sign-in lockout does for its attempt count). The mailer runs only after
     this commits, so the limit counts attempts: a mailer that fails or never
     answers still used one. */
  const [locked] = await executor.select({
    verifiedAt: mailInSenderAddresses.verifiedAt,
    checkSentAt: mailInSenderAddresses.checkSentAt,
    verificationTokenDigest: mailInSenderAddresses.verificationTokenDigest,
    verificationExpiresAt: mailInSenderAddresses.verificationExpiresAt,
  }).from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId)))
    .for("update");
  if (!locked) throw new AppError("sender_address_unknown", "That address is not on this account", 404);
  if (locked.verifiedAt) throw new AppError("sender_already_verified", SENDER_CHECK_WORDS.alreadyChecked, 409);

  /* The clock is the process's, not the database's `now()`, as everywhere
     else in this file. */
  const sentAt = dependencies.now?.() ?? new Date();
  const refusal = senderCheckRefusal(locked.checkSentAt, sentAt);
  if (refusal?.limit === "day") {
    throw new RateLimitedError("sender_check_daily_limit", SENDER_CHECK_WORDS.dailyLimit, refusal.seconds);
  }
  if (refusal) {
    throw new RateLimitedError("sender_check_too_soon", SENDER_CHECK_WORDS.tooSoon, refusal.seconds);
  }

  const kept = locked.checkSentAt
    .filter((at) => at.getTime() > sentAt.getTime() - SENDER_CHECK_WINDOW_MS)
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(-(SENDER_CHECK_DAILY_LIMIT - 1));
  const digest = digestToken(token);
  const [updated] = await executor.update(mailInSenderAddresses).set({
    verificationTokenDigest: digest,
    verificationExpiresAt: expiresAt,
    checkSentAt: [...kept, sentAt],
    updatedAt: now,
  }).where(and(
    eq(mailInSenderAddresses.id, id),
    eq(mailInSenderAddresses.userId, userId),
    isNull(mailInSenderAddresses.verifiedAt),
  )).returning({ id: mailInSenderAddresses.id });
  if (!updated) throw new AppError("sender_already_verified", SENDER_CHECK_WORDS.alreadyChecked, 409);

  return {
    id,
    address,
    expiresAt,
    send,
    digest,
    previous: { digest: locked.verificationTokenDigest, expiresAt: locked.verificationExpiresAt },
    message: {
      from: smtp.smtpFrom,
      to: address,
      subject: "Check your Orbit sending address",
      text: [
        "Orbit is checking that you send mail from this address.",
        "",
        `Open this link while signed in to Orbit, within 24 hours: ${link}`,
        "",
        "Until you do, mail you forward to Orbit from this address is not matched to you.",
        "If you did not ask for this, ignore it — nothing changes.",
      ].join("\n"),
    },
  };
}

/**
 * Hands the message to the mailer, but only for so long. A mailer that never
 * answers ends in 503 `sender_mailer_timeout`; one that throws ends in 503
 * `sender_mailer_refused` rather than an unexplained 500. Either way the
 * attempt was already recorded, so it counts. A timed-out send keeps its link
 * outstanding (a mailer that took the message just as the deadline fell may
 * still deliver it); a refused one has its link withdrawn by `deliver`.
 */
async function sendWithDeadline(send: (message: MailMessage) => Promise<void>, message: MailMessage): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError("sender_mailer_timeout", SENDER_CHECK_WORDS.mailerTimeout, 503)),
      sendDeadlineMs,
    );
  });
  try {
    await Promise.race([send(message), timeout]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("sender_mailer_refused", SENDER_CHECK_WORDS.mailerRefused, 503);
  } finally {
    clearTimeout(timer);
  }
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

  /* The link must be for the address the member is registered with NOW: if it
     has moved since the link went out, the old link verifies nothing. A row
     that cannot be read cannot be confirmed either. */
  const reader = await openInstanceMetadataReader();
  const registered = await registeredAddressOf(getDb(), reader, userId);
  const linked = normalizeSenderAddress(readAddress(reader, match).value ?? undefined);
  if (!registered || linked !== registered) throw refuse();

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
  return viewOf(verified, now, reader);
}

/**
 * The member a verified address belongs to, or nobody.
 *
 * This is the whole of attribution's database side, and it is deliberately
 * narrow: one exact normalised address, verified only, and never a prefix, a
 * domain or a pattern. A disabled account attributes nothing.
 *
 * The match is on the BLIND INDEX (#969), which is what carries an exact
 * address lookup across the encryption. A locked instance cannot produce an
 * index at all; rather than throw, it attributes to nobody (fail closed).
 * Mail-in reads `verifiedSenderMatch` instead, which tells "nobody" apart from
 * "cannot tell".
 */
export async function userForVerifiedSender(address: string): Promise<string | undefined> {
  const match = await verifiedSenderMatch(address);
  return match.state === "matched" ? match.userId : undefined;
}

/**
 * Who a sending address belongs to: a member, nobody, or "Orbit cannot tell"
 * — a locked key, or a candidate whose registered address will not decrypt.
 * Mail-in must not treat the last as nobody: that answers and deletes a
 * member's mail for a fault of Orbit's own.
 */
export type VerifiedSenderMatch =
  | { state: "matched"; userId: string }
  | { state: "no_match" }
  | { state: "unreadable" };

export async function verifiedSenderMatch(address: string): Promise<VerifiedSenderMatch> {
  const normalized = normalizeSenderAddress(address);
  if (!normalized) return { state: "no_match" };
  const cipher = await openInstanceMetadataReader();
  if (cipher.locked) return { state: "unreadable" };
  const addressIndex = cipher.senderAddressIndex(normalized);
  if (addressIndex === null) return { state: "no_match" };
  const rows = await getDb().select({
    userId: mailInSenderAddresses.userId,
    disabledAt: users.disabledAt,
    emailEnc: users.emailEnc,
  })
    .from(mailInSenderAddresses)
    .innerJoin(users, eq(users.id, mailInSenderAddresses.userId))
    .where(and(
      eq(mailInSenderAddresses.addressIndex, addressIndex),
      isNotNull(mailInSenderAddresses.verifiedAt),
    ));
  /* The row counts only while it is still the member's registered address: a
     member whose account address has since changed no longer attributes the
     old one, with no settings visit needed to say so. */
  let unreadable = false;
  for (const candidate of rows) {
    if (candidate.disabledAt) continue;
    const registered = cipher.text("users.email", candidate.userId, { encrypted: candidate.emailEnc });
    if (registered.state) unreadable = true;
    if (normalizeSenderAddress(registered.value ?? undefined) === normalized) return { state: "matched", userId: candidate.userId };
  }
  return unreadable ? { state: "unreadable" } : { state: "no_match" };
}
