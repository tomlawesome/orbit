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
 * Two smaller rules follow from the same thought. A VERIFIED address is unique
 * across the instance, because one address attributes to exactly one member
 * and a shared claim would make attribution a guess; an unverified row holds
 * nothing, so several members may list one address unchecked and the first to
 * verify it keeps it (#1650, ADR-0017 amendment). And the verification token is
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
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { externalIdentities, imapIngestionMessages, mailInRelays, mailInSenderAddresses, mailInSenderCheckSends, users } from "@/db/schema";
import { AppError, RateLimitedError } from "@/lib/app-error";
import { log } from "@/lib/logger";
import { validUuid } from "@/lib/uuid";
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
  type NotificationWorkerConfig,
} from "@/server/notification-worker";
import { hostOf, householdLine, renderMail } from "@/server/invitations/mail";
import { formatApprovalMoment } from "@/server/sign-in-approvals/mail";
import { normalizeSenderAddress } from "./core/sender-authentication";
import { outgoingMailConfig } from "./sending-settings";

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
  /**
   * #1681, design note 52496: false while the last forward from this address
   * was unsigned (`last_forward_unsigned_at` set), so not kept; null otherwise.
   * One column cannot tell "signed" from "nothing seen yet", and the screen
   * draws the two alike, so this never says true.
   */
  lastForwardSigned: boolean | null;
  /**
   * #1650 (owner decision 51): whole days, rounded up, before an unchecked
   * extra address is removed; null for the seeded sign-in row and any checked
   * row, which are never removed by time.
   */
  daysLeft: number | null;
  /** Present only when something is unreadable, as elsewhere (ADR-0024 decision 5). */
  metadataStatus?: { address?: MetadataFieldState };
}

/** A member holds at most this many sending addresses, the sign-in address included (#1650). */
export const MAX_SENDER_ADDRESSES_PER_USER = 5;
/** An extra address still unchecked this long after it was added is removed (#1650, owner decision 51). */
export const SENDER_UNVERIFIED_TTL_MS = 14 * 86_400_000;
const DAY_MS = 86_400_000;
/**
 * The longest an unchecked extra row lives (#1810 item 5): no check link can
 * be sent once its 14 days have passed, so the last link it was ever sent
 * lapses at most one link's life after them. The absolute deadline beside the
 * link's sliding one.
 */
const SENDER_UNVERIFIED_MAX_LIFE_MS = SENDER_UNVERIFIED_TTL_MS + 24 * 3_600_000;

/*
 * The words of the further-address refusals (#1650, ADR-0017 amendment). None
 * names another member's holding: an address another member has verified is
 * added like any other (#1810 item 2), so there is no refusal to word.
 */
export const SENDER_ADDRESS_WORDS = {
  invalid: "That is not an address Orbit can use",
  limit: "five is the most",
  seeded: "the sign-in address stays",
  unknown: "That address is not on this account",
  unchecked: "Please verify sending address",
} as const;

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
  // Also the words when another account holds this address: naming that cause
  // would tell a member which addresses are in use here.
  noAddress: "not sent — no address can be checked for this account. ask your administrator",
  noMail: "not sent — Orbit has no outbound mail set up yet. ask your administrator",
  locked: "not sent — Orbit cannot read your address right now. try again later",
  tooSoon: "not sent — too soon. try again in a few minutes",
  dailyLimit: "not sent — daily limit reached. try again tomorrow.",
  mailerTimeout: "not sent — the mail server did not answer in time. try again later",
  mailerRefused: "not sent — the mail server refused the message. try again later",
  unreadable: "not sent — Orbit cannot read the address it holds for you. ask your administrator",
  noAppUrl: "not sent — Orbit does not know its own web address. ask your administrator",
  lapsed: "not sent — that address was not checked within 14 days and is being removed. add it again",
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
  sendMail?: (message: MailMessage) => Promise<void>;
  smtpConfig?: () => NotificationWorkerConfig | Promise<NotificationWorkerConfig>;
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
 * The VERIFIED row already holding this address — this member's or anybody
 * else's, or, with `exceptUserId`, anybody else's only. An unverified row
 * holds nothing (#1650), so it is never a claim here.
 *
 * The blind index is what carries "one account per sending address" across the
 * encryption. With no index (nothing to index) there is no claim to find.
 */
async function existingClaim(
  addressIndex: string | null,
  executor: MetadataExecutor = getDb(),
  exceptUserId?: string,
): Promise<typeof mailInSenderAddresses.$inferSelect | undefined> {
  if (addressIndex === null) return undefined;
  const [row] = await executor.select().from(mailInSenderAddresses)
    .where(and(
      eq(mailInSenderAddresses.addressIndex, addressIndex),
      isNotNull(mailInSenderAddresses.verifiedAt),
      ...(exceptUserId ? [ne(mailInSenderAddresses.userId, exceptUserId)] : []),
    ))
    .limit(1);
  return row;
}

/**
 * Mail held under these sender rows (#1650) goes with them: the receipt stops
 * being anybody's and is given to the expiry sweep, which purges its staged
 * bytes. Its `held_sender_address_id` stays, so it can never become addable.
 */
async function detachHeldMail(executor: MetadataExecutor, senderAddressIds: readonly string[], now: Date): Promise<void> {
  /* The caller has already locked these rows FOR UPDATE (#1810 item 3): a
     filer holds the row FOR SHARE while it writes a receipt held under it, so
     every receipt it files is either committed and seen here, or filed after
     this transaction and sees the row gone or changed. */
  if (senderAddressIds.length === 0) return;
  await executor.update(imapIngestionMessages).set({
    userId: null,
    receiptStatus: "cancelled",
    expiresAt: new Date(now.getTime() - 1000),
    updatedAt: now,
  }).where(and(
    inArray(imapIngestionMessages.heldSenderAddressId, [...senderAddressIds]),
    isNotNull(imapIngestionMessages.userId),
  ));
}

/**
 * Proving an address releases the mail held under it (#1810 item 1, owner
 * answer 22a). It was an envelope-only hold, so it goes back to `processing`
 * with its next attempt due now, the update a resume applies
 * (`setRelayIngestPaused`), and the next worker cycle fetches and stages it.
 * A member who has paused collection keeps it held, unmarked, and the resume
 * releases it. The relay row is locked FOR SHARE so a pause or resume landing
 * now waits for this and then sees the mail unmarked.
 */
async function releaseHeldMail(executor: MetadataExecutor, userId: string, senderAddressId: string, now: Date): Promise<void> {
  const [relay] = await executor.select({ ingestPausedAt: mailInRelays.ingestPausedAt }).from(mailInRelays)
    .where(eq(mailInRelays.userId, userId)).limit(1).for("share");
  const owned = and(eq(imapIngestionMessages.heldSenderAddressId, senderAddressId), eq(imapIngestionMessages.userId, userId));
  if (!relay?.ingestPausedAt) {
    await executor.update(imapIngestionMessages).set({
      status: "processing",
      receiptStatus: "processing",
      failureCode: null,
      heldSenderAddressId: null,
      attachmentProcessingNextAttemptAt: now,
      attachmentProcessingLockedAt: null,
      attachmentProcessingLeaseToken: null,
      updatedAt: now,
    }).where(and(owned, eq(imapIngestionMessages.status, "held")));
  }
  await executor.update(imapIngestionMessages).set({ heldSenderAddressId: null, updatedAt: now }).where(owned);
}

/**
 * Locks sender rows FOR UPDATE before their held mail is detached and they are
 * removed or changed (#1810 item 3: lock the parent row, then write the child).
 * A filer filing mail held under one of them waits for this transaction, and
 * one already filing is waited for. Always in id order, as verify and the
 * sweep take theirs, so two writers locking overlapping rows cannot deadlock.
 */
async function lockSenderRows(executor: MetadataExecutor, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await executor.select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses)
    .where(inArray(mailInSenderAddresses.id, [...ids])).orderBy(asc(mailInSenderAddresses.id)).for("update");
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
export async function withSenderLock<T>(
  userId: string,
  work: (executor: MetadataExecutor) => Promise<T>,
  options: { wait?: boolean } = {},
): Promise<T> {
  return getDb().transaction(async (transaction) => {
    /* Adding and removing an address wait their turn instead (#1650): they
       send nothing, so a second press is not "too soon", only second. */
    if (options.wait) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:mail-relay-sender:${userId}`}, 0))`);
      return work(transaction);
    }
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
    lastForwardSigned: row.lastForwardUnsignedAt ? false : null,
    daysLeft: senderDaysLeft(row, now),
    metadataStatus: address.state ? { address: address.state } : undefined,
  };
}

/** When time removes an unchecked extra row: 14 days from when it was added,
 *  or the lapse of a check link sent inside them, whichever is later (A-S2),
 *  and never later than 15 days (#1810 item 5); null when time never removes it. */
export function senderRemovalAt(row: { source: SenderAddressSource; verifiedAt: Date | null; createdAt: Date; verificationExpiresAt: Date | null }): Date | null {
  if (row.source !== "manual" || row.verifiedAt !== null) return null;
  const scheduled = row.createdAt.getTime() + SENDER_UNVERIFIED_TTL_MS;
  const promised = row.verificationExpiresAt?.getTime() ?? 0;
  return new Date(Math.min(Math.max(scheduled, promised), row.createdAt.getTime() + SENDER_UNVERIFIED_MAX_LIFE_MS));
}

/** Whole days, rounded up, before an unchecked extra row is removed (its link honoured); null when time never removes it. */
export function senderDaysLeft(row: { source: SenderAddressSource; verifiedAt: Date | null; createdAt: Date; verificationExpiresAt: Date | null }, now: Date): number | null {
  const removalAt = senderRemovalAt(row);
  if (removalAt === null) return null;
  return Math.max(0, Math.ceil((removalAt.getTime() - now.getTime()) / DAY_MS));
}

/**
 * The member's own address rows: the seeded sign-in row first, then the extra
 * ones in the order they were added (#1650). Never anybody else's.
 */
export async function listSenderAddresses(
  userId: string,
  dependencies: SenderAddressDependencies = {},
  executor: MetadataExecutor = getDb(),
): Promise<SenderAddressView[]> {
  const now = dependencies.now?.() ?? new Date();
  const rows = await executor.select().from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId))
    /* The id breaks a `created_at` tie (#1813) so the order is the same on
       every read; ids are random, so the order added is `created_at`'s. */
    .orderBy(asc(mailInSenderAddresses.createdAt), asc(mailInSenderAddresses.id));
  const cipher = await openInstanceMetadataReader(executor);
  const views = rows.map((row) => viewOf(row, now, cipher));
  if (views.length === 0) return views;
  /* A SEEDED row that READS as an address other than the registered one, or
     that has lost its claim, is not the member's any more (it may be kept only
     for its send times, see seeding); a row that cannot be read at all stays,
     with its state. An extra row (#1650) is the member's own whatever their
     registered address, while it has its claim. */
  const registered = await registeredAddressOf(executor, cipher, userId);
  const kept = views.filter((view, index) => {
    if (rows[index].source === "manual") return rows[index].addressIndex !== null;
    return view.address === null
      || (rows[index].addressIndex !== null && normalizeSenderAddress(view.address) === registered);
  });
  /* Stable: the seeded row first, the rest keep their `created_at` order. */
  return [...kept.filter((view) => view.source !== "manual"), ...kept.filter((view) => view.source === "manual")];
}

/**
 * Whether this member has anything that can attribute mail to them yet: a
 * checked row for the address they are registered with NOW, or a checked
 * extra address (#1650). A seeded row for an address they have since moved
 * away from counts for nothing.
 */
export async function hasVerifiedSenderAddress(userId: string, executor: MetadataExecutor = getDb()): Promise<boolean> {
  const rows = await executor.select().from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.userId, userId), isNotNull(mailInSenderAddresses.verifiedAt)));
  if (rows.length === 0) return false;
  /* A checked extra address (#1650) attributes whatever the registered one is. */
  if (rows.some((row) => row.source === "manual" && row.addressIndex !== null)) return true;
  const reader = await openInstanceMetadataReader(executor);
  const registered = await registeredAddressOf(executor, reader, userId);
  return rows.some((row) => row.source !== "manual" && normalizeSenderAddress(readAddress(reader, row).value ?? undefined) === registered);
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
 * Only a seeded row that READS as a different address is dropped. An extra
 * row (#1650) is never dropped here, damaged or not (#1810 item 4: never
 * destroy on read): it is listed unreadable and the member may remove it.
 * A row that cannot be read while the key is locked proves nothing about which address it holds
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
  const memberRows = await executor.select().from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId));
  /* Only the seeded row follows the registered address; the member's extra
     rows (#1650) are theirs to add and remove, and seeding leaves them be. */
  const existingRows = memberRows.filter((row) => row.source !== "manual");

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
  /* A damaged extra row (#1650) is left alone (#1810 item 4): it is listed
     with its address unreadable, keeps its held mail and its attribution (the
     blind index still matches), and the member removes it if they want. */

  const cipher = await requireInstanceMetadataWriter(executor);
  const addressIndex = cipher.senderAddressIndex(address);
  /* Damaged but proven: the proof still holds for the registered address, so
     the replacement carries it rather than turning the member into a
     stranger until they check again. */
  const proven = damaged.find((row) => row.addressIndex === addressIndex && row.verifiedAt !== null);
  const staleIds = stale.map((row) => row.id);
  /* The member already lists the registered address as an extra row: that
     row is where it lives, and no second row is made for it. A damaged one
     too (#1810 item 4): its index proves which address it holds, so its
     display copy is written afresh from the registered address. */
  const ownExtra = memberRows.find((row) => row.source === "manual" && row.addressIndex === addressIndex);
  /* The send times are the member's, not the address's, and they survive any
     change of address: every replaced row's times are merged into wherever
     the member's row ends up. */
  const staleTimes = [...stale, ...damaged].flatMap((row) => row.checkSentAt);
  const removeStale = async () => {
    await lockSenderRows(executor, staleIds);
    await detachHeldMail(executor, staleIds, now);
    await executor.delete(mailInSenderAddresses).where(and(
      eq(mailInSenderAddresses.userId, userId),
      inArray(mailInSenderAddresses.id, staleIds),
    ));
  };

  /* Dropped first: a damaged row still holds its blind index, which is most
     likely the registered address's, and would otherwise block the reseed.
     The caller's transaction holds the delete and the insert below together,
     so there is no moment with no claim. */
  if (damaged.length > 0) {
    await lockSenderRows(executor, damaged.map((row) => row.id));
    await detachHeldMail(executor, damaged.map((row) => row.id), now);
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

  /* The registered address moved to one the member already lists as an extra
     (#1650 review 2): that row BECOMES the seeded one -- source account or
     sso, never removable, never swept -- so ADR-0017's "the sign-in address
     stays seeded" holds and there is never a second seeded row. Its proof
     stands: the member proved this very address. Every other seeded row,
     an unreadable one included, is retired as stale. */
  if (!matching && ownExtra) {
    if (unreadable) stale.push(unreadable);
    const repair = readAddress(reader, ownExtra).state === "metadata_integrity_failed"
      ? { addressEnc: cipher.encryptText("mail_in_sender_addresses.address", ownExtra.id, address) }
      : {};
    await executor.update(mailInSenderAddresses).set({
      source: identity ? "sso" : "account",
      ...repair,
      checkSentAt: mergeChecks([...ownExtra.checkSentAt, ...staleTimes, ...(unreadable?.checkSentAt ?? [])], now),
      updatedAt: now,
    }).where(eq(mailInSenderAddresses.id, ownExtra.id));
    if (stale.length > 0) {
      staleIds.push(...(unreadable ? [unreadable.id] : []));
      await removeStale();
    }
    return;
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

  /* An address somebody already holds VERIFIED is left exactly as it is:
     seeding must never take an address away from the member who verified it.
     An unverified row elsewhere holds nothing (#1650): both rows stand,
     unverified, until one of them is checked. */
  if (await existingClaim(addressIndex, executor)) {
    /* No row can be made, so the old rows are the only place the send times
       live. They stay, but stop being anything: unchecked, no link, no claim
       on their old address; with no claim they are never listed, never sent
       a link and never attribute. The next seed with room replaces them,
       including when the member's address returns to what they read as.
       Mail held under them goes: the address is not theirs to check now. */
    await lockSenderRows(executor, staleIds);
    await detachHeldMail(executor, staleIds, now);
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
 * The check mail an arrival held for an unchecked address sends (#1650, owner
 * decision 51; review 6). Nothing goes while the row's link is still good:
 * a link lasts 24 hours, so one sent inside them is still the one to open,
 * and sending another would spend the member's daily five and void it.
 * Otherwise a send exactly as `sendSenderVerification`, under the same limit.
 * Answers null when nothing was sent for that reason.
 */
export async function resendSenderCheckForHeldMail(
  userId: string,
  id: string,
  dependencies: SenderAddressDependencies = {},
): Promise<{ address: string; expiresAt: Date } | null> {
  const now = dependencies.now?.() ?? new Date();
  const reserved = await withSenderLock(userId, async (executor) => {
    const [row] = await executor.select({ verificationExpiresAt: mailInSenderAddresses.verificationExpiresAt })
      .from(mailInSenderAddresses)
      .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId))).limit(1);
    if (row?.verificationExpiresAt && row.verificationExpiresAt.getTime() > now.getTime()) return null;
    return reserveSend(executor, userId, id, dependencies);
  });
  return reserved ? deliver(reserved) : null;
}

/**
 * The whole "check my address" request for one member: seed, read and
 * reserve the send in ONE short transaction under the member's lock, then
 * answer, and hand the message to the mailer afterwards with nothing held
 * (#1810 R2: the existence-dependent slow work runs after the answer, so a
 * press answers alike, at once, whether a mail goes or not). A press refused
 * before the reservation leaves nothing behind; once reserved, the attempt
 * counts whatever the mailer does, and a mailer failure is the
 * administrator's, in the warn log, not the member's.
 *
 * `id` names one of the member's own rows (#1650); absent, the seeded
 * sign-in row, as before. An id that is not one of the member's listed rows
 * is answered as unknown, whoever's it is.
 */
export async function requestSenderCheck(
  userId: string,
  dependencies: SenderAddressDependencies = {},
  id?: string,
): Promise<{ address: string; expiresAt: Date }> {
  if (id !== undefined && !validUuid(id)) throw new AppError("sender_address_unknown", SENDER_ADDRESS_WORDS.unknown, 404);
  return withSenderLock(userId, async (executor) => {
    await seedSenderAddress(userId, dependencies, executor);
    const listed = await listSenderAddresses(userId, dependencies, executor);
    const row = id === undefined ? listed.find((view) => view.source !== "manual") : listed.find((view) => view.id === id);
    if (!row) {
      if (id !== undefined) throw new AppError("sender_address_unknown", SENDER_ADDRESS_WORDS.unknown, 404);
      throw new AppError("sender_address_unavailable", SENDER_CHECK_WORDS.noAddress, 409);
    }
    if (row.verified) throw new AppError("sender_already_verified", SENDER_CHECK_WORDS.alreadyChecked, 409);
    return reserveSend(executor, userId, row.id, dependencies);
  }).then((reserved) => {
    deliverAfterAnswer(reserved);
    return { address: reserved.address, expiresAt: reserved.expiresAt };
  });
}

/**
 * The press's delivery, run in-process after it has answered (#1810 R2), under
 * the same deadline. Nothing is rolled back on a refusal: the row keeps this
 * press's link, and the member, who sees "check sent", can press again after a
 * minute. The failure goes to the warn log only.
 */
function deliverAfterAnswer({ send, message, suppressed }: ReservedSend): void {
  if (suppressed) return;
  void sendWithDeadline(send, message).catch((error: unknown) => {
    log.warn({
      event: "mail-relay.sender",
      state: "degraded",
      reason: error instanceof AppError && error.code === "sender_mailer_timeout" ? "smtp_unavailable" : "smtp_rejected",
      action: "inspect_admin_diagnostics",
      impact: "sender_check_required",
    });
  });
}

type MailMessage = { from: string; to: string; subject: string; text: string; html?: string };
interface ReservedSend {
  id: string;
  address: string;
  expiresAt: Date;
  send: (message: MailMessage) => Promise<void>;
  message: MailMessage;
  /** The digest this attempt wrote, and the link that stood before it. */
  digest: string;
  previous: { digest: string | null; expiresAt: Date | null };
  /** Another member holds the address verified (#1810 item 2): the send is
   *  answered and counted like any other, but no mail goes. */
  suppressed: boolean;
}

/** The slow part, run after the reservation has committed. */
async function deliver({ id, address, expiresAt, send, message, digest, previous, suppressed }: ReservedSend): Promise<{ address: string; expiresAt: Date }> {
  /* A link that never arrived can never verify: the row lapses with the
     14-day sweep like any unchecked row. */
  if (suppressed) return { address, expiresAt };
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

/** Every send of the member's in the rolling window: their send log and their rows' own times, once each. */
async function memberSendTimes(executor: MetadataExecutor, userId: string, now: Date): Promise<Date[]> {
  const since = new Date(now.getTime() - SENDER_CHECK_WINDOW_MS);
  const logged = await executor.select({ sentAt: mailInSenderCheckSends.sentAt }).from(mailInSenderCheckSends)
    .where(and(eq(mailInSenderCheckSends.userId, userId), gt(mailInSenderCheckSends.sentAt, since)));
  const onRows = (await executor.select({ checkSentAt: mailInSenderAddresses.checkSentAt })
    .from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId)))
    .flatMap((one) => one.checkSentAt);
  const seen = new Map<number, Date>();
  for (const at of [...logged.map((one) => one.sentAt), ...onRows]) seen.set(at.getTime(), at);
  return [...seen.values()];
}

/** One send into the member's log; what has left the window is pruned as it goes. */
async function recordMemberSend(executor: MetadataExecutor, userId: string, sentAt: Date): Promise<void> {
  await executor.delete(mailInSenderCheckSends).where(and(
    eq(mailInSenderCheckSends.userId, userId),
    lt(mailInSenderCheckSends.sentAt, new Date(sentAt.getTime() - SENDER_CHECK_WINDOW_MS)),
  ));
  await executor.insert(mailInSenderCheckSends).values({ userId, sentAt });
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
    throw new AppError("sender_address_unknown", SENDER_ADDRESS_WORDS.unknown, 404);
  }
  if (row.verifiedAt) throw new AppError("sender_already_verified", SENDER_CHECK_WORDS.alreadyChecked, 409);
  /* The absolute deadline beside the link's sliding one (#1810 item 5): no
     link goes once an extra row's 14 days have passed, so a daily press
     cannot keep it, and the last link it had lapses within a day of them. */
  if (row.source === "manual" && now.getTime() >= row.createdAt.getTime() + SENDER_UNVERIFIED_TTL_MS) {
    throw new AppError("sender_address_lapsed", SENDER_CHECK_WORDS.lapsed, 409);
  }
  /* Somebody else has proved this address (#1650). An extra row's check is
     answered, recorded and counted exactly as any other, but delivers no mail
     (#1810 item 2, uniform responses): no answer tells a member which
     addresses are in use, and no mail goes to an address another member
     holds. The seeded row keeps its silence in the words that name no cause. */
  const suppressed = Boolean(await existingClaim(row.addressIndex, executor, userId));
  if (suppressed && row.source !== "manual") {
    throw new AppError("sender_address_unavailable", SENDER_CHECK_WORDS.noAddress, 409);
  }

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
    smtp = await (dependencies.smtpConfig ?? outgoingMailConfig)();
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
  if (!locked) throw new AppError("sender_address_unknown", SENDER_ADDRESS_WORDS.unknown, 404);
  if (locked.verifiedAt) throw new AppError("sender_already_verified", SENDER_CHECK_WORDS.alreadyChecked, 409);

  /* The clock is the process's, not the database's `now()`, as everywhere
     else in this file. */
  const sentAt = dependencies.now?.() ?? new Date();
  /* The limit is the MEMBER'S (#1650): rate-limited by subject, not by
     resource. A second address is not a second allowance, and removing a row
     (or the 14-day sweep) does not give one back, because every send is also
     in the member's own send log. The rows' own times still count, for sends
     recorded before the log existed. */
  const memberSends = await memberSendTimes(executor, userId, sentAt);
  const refusal = senderCheckRefusal(memberSends, sentAt);
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
  await recordMemberSend(executor, userId, sentAt);

  return {
    id,
    address,
    expiresAt,
    send,
    digest,
    previous: { digest: locked.verificationTokenDigest, expiresAt: locked.verificationExpiresAt },
    suppressed,
    message: {
      from: smtp.smtpFrom,
      to: address,
      ...renderMail({
        subject: "Check your Orbit sending address",
        preheader: "Open the button while signed in, within 24 hours.",
        headline: "Is this address yours?",
        body: [
          `Orbit is checking that you send mail from ${address}.`,
          "Open the button while signed in to Orbit, within 24 hours. Until you do, mail you forward from this address cannot be added to Orbit.",
        ],
        button: { label: "yes, it’s mine", href: link },
        facts: [
          { label: "address", value: address },
          { label: "good until", value: formatApprovalMoment(expiresAt) },
        ],
        footer: [
          "Didn’t ask for this? Ignore it — nothing changes.",
          householdLine(hostOf(link)),
        ],
        text: [
          "Orbit is checking that you send mail from this address.",
          "",
          `Open this link while signed in to Orbit, within 24 hours: ${link}`,
          "",
          "Until you do, mail you forward to Orbit from this address cannot be added to Orbit.",
          "If you did not ask for this, ignore it — nothing changes.",
        ].join("\n"),
      }),
    },
  };
}

/**
 * Hands the message to the mailer, but only for so long. A mailer that never
 * answers rejects with `sender_mailer_timeout`; one that throws rejects with
 * `sender_mailer_refused`. Either way the attempt was already recorded, so it
 * counts. For the check press (#1810 R2) the answer has already gone and
 * `deliverAfterAnswer` only logs the failure; the link stays. Only the
 * held-mail resend (`deliver`) still has a refused send's link withdrawn; a
 * timed-out one keeps its link outstanding (a mailer that took the message
 * just as the deadline fell may still deliver it).
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
  return async (message: MailMessage) => {
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

  /* The link for the SEEDED row must be for the address the member is
     registered with NOW: if it has moved since the link went out, the old link
     verifies nothing. An extra row (#1650) is for the address it holds. A row
     that cannot be read cannot be confirmed either. */
  const reader = await openInstanceMetadataReader();
  const linked = normalizeSenderAddress(readAddress(reader, match).value ?? undefined);
  if (!linked || match.addressIndex === null) throw refuse();
  if (match.source !== "manual") {
    const registered = await registeredAddressOf(getDb(), reader, userId);
    if (!registered || linked !== registered) throw refuse();
  }

  /* Verification is the exclusive act (#1650): the partial unique index lets
     one verified row per address stand, so a member who loses the race gets
     the same bounded refusal as any unusable link. The winner's verify drops
     every other member's unverified row for the address, with any mail held
     under them, and frees the mail held under its own row, in one step. */
  let verified: typeof mailInSenderAddresses.$inferSelect | undefined;
  try {
    verified = await getDb().transaction(async (transaction) => {
      /* Every row this verify changes or removes is locked first, in id order
         (#1810 review), so two members verifying the same address, or a
         verify and the sweep, cannot each hold one row and wait for the other;
         and before their mail is detached (#1810 item 3). */
      const locked = await transaction.select({ id: mailInSenderAddresses.id, userId: mailInSenderAddresses.userId }).from(mailInSenderAddresses).where(and(
        eq(mailInSenderAddresses.addressIndex, match.addressIndex!),
        isNull(mailInSenderAddresses.verifiedAt),
        or(eq(mailInSenderAddresses.id, match.id), ne(mailInSenderAddresses.userId, userId)),
      )).orderBy(asc(mailInSenderAddresses.id)).for("update");
      const [row] = await transaction.update(mailInSenderAddresses).set({
        verifiedAt: now,
        verificationTokenDigest: null,
        verificationExpiresAt: null,
        updatedAt: now,
      }).where(and(
        eq(mailInSenderAddresses.id, match.id),
        eq(mailInSenderAddresses.userId, userId),
        isNull(mailInSenderAddresses.verifiedAt),
      )).returning();
      if (!row) return undefined;
      const otherIds = locked.filter((other) => other.userId !== userId).map((other) => other.id);
      await detachHeldMail(transaction, otherIds, now);
      if (otherIds.length > 0) await transaction.delete(mailInSenderAddresses).where(inArray(mailInSenderAddresses.id, otherIds));
      await releaseHeldMail(transaction, userId, row.id, now);
      return row;
    });
  } catch (error) {
    if (lostVerifyRace(error)) throw refuse();
    throw error;
  }
  if (!verified) throw refuse();
  return viewOf(verified, now, reader);
}

/* A unique violation (another member verified first), a deadlock or a
   serialization failure (#1650 review 5): each means a concurrent verify won,
   and each is answered as the invalid link it now is, never a 500. */
const LOST_RACE_CODES = new Set(["23505", "40P01", "40001"]);

function lostVerifyRace(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (LOST_RACE_CODES.has(String((current as { code?: unknown }).code))) return true;
  }
  return false;
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
  | { state: "matched"; userId: string; senderAddressId: string }
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
    id: mailInSenderAddresses.id,
    userId: mailInSenderAddresses.userId,
    source: mailInSenderAddresses.source,
    disabledAt: users.disabledAt,
    emailEnc: users.emailEnc,
  })
    .from(mailInSenderAddresses)
    .innerJoin(users, eq(users.id, mailInSenderAddresses.userId))
    .where(and(
      eq(mailInSenderAddresses.addressIndex, addressIndex),
      isNotNull(mailInSenderAddresses.verifiedAt),
    ));
  /* A seeded row counts only while it is still the member's registered
     address: a member whose account address has since changed no longer
     attributes the old one, with no settings visit needed to say so. A
     checked extra row (#1650) is the member's own address whatever their
     registered one is. */
  let unreadable = false;
  for (const candidate of rows) {
    if (candidate.disabledAt) continue;
    if (candidate.source === "manual") return { state: "matched", userId: candidate.userId, senderAddressId: candidate.id };
    const registered = cipher.text("users.email", candidate.userId, { encrypted: candidate.emailEnc });
    if (registered.state) unreadable = true;
    if (normalizeSenderAddress(registered.value ?? undefined) === normalized) return { state: "matched", userId: candidate.userId, senderAddressId: candidate.id };
  }
  return unreadable ? { state: "unreadable" } : { state: "no_match" };
}

/**
 * The rolling window for `sender_unsigned`: one notification per member
 * (#1681, note 52496; #1722) and one filed row per sending address (#1727,
 * owner decision 110a).
 */
export const SENDER_UNSIGNED_NOTICE_WINDOW_MS = 24 * 3_600_000;

/**
 * Claims the one `sender_unsigned` row a sending address may file per window
 * (#1727 A-R2): one conditional UPDATE stamps `last_forward_unsigned_at` when
 * it is null or at least `windowMs` old, and the database arbitrates racing
 * cycles. True means this caller won and the mark is already set.
 */
export async function claimUnsignedRowWindow(senderAddressId: string, now: Date = new Date(), windowMs: number = SENDER_UNSIGNED_NOTICE_WINDOW_MS): Promise<boolean> {
  const cutoff = new Date(now.getTime() - windowMs);
  const rows = await getDb().update(mailInSenderAddresses)
    .set({ lastForwardUnsignedAt: now })
    .where(and(
      eq(mailInSenderAddresses.id, senderAddressId),
      or(isNull(mailInSenderAddresses.lastForwardUnsignedAt), lte(mailInSenderAddresses.lastForwardUnsignedAt, cutoff)),
    ))
    .returning({ id: mailInSenderAddresses.id });
  return rows.length > 0;
}

/**
 * Records whether the latest forward from a verified sending address was
 * signed (#1681, design note 52496): `unsigned` stamps
 * `last_forward_unsigned_at` when a `sender_unsigned` row is filed for it;
 * `signed` clears it when a forward from it attributes. The relay page's
 * `sender check` row reads it as `lastForwardSigned`. Keyed by the row the
 * attribution matched, so a member's other or replaced rows are untouched.
 */
export async function recordForwardSigning(senderAddressId: string, outcome: "signed" | "unsigned", now: Date = new Date()): Promise<void> {
  if (outcome === "unsigned") {
    await getDb().update(mailInSenderAddresses)
      .set({ lastForwardUnsignedAt: now })
      .where(eq(mailInSenderAddresses.id, senderAddressId));
    return;
  }
  await getDb().update(mailInSenderAddresses)
    .set({ lastForwardUnsignedAt: null })
    .where(and(eq(mailInSenderAddresses.id, senderAddressId), isNotNull(mailInSenderAddresses.lastForwardUnsignedAt)));
}

/**
 * Adds a further sending address to the member's own list (#1650, ADR-0017
 * amendment): an unchecked row, source `manual`, and no check mail — the
 * member presses `send check` for that. Under the member's lock, waited for,
 * so two presses at once make one row.
 *
 * Refusals: 400 `sender_address_invalid` for anything that is not one plain
 * address; 409 `sender_address_limit` at five rows, the sign-in row counted
 * even before it is seeded. An address another member holds VERIFIED is added
 * like any other (#1810 item 2: uniform responses), and its check is counted
 * but never delivered, so no answer tells a member which addresses are in
 * use. An address
 * already on the member's own list, the sign-in address included, is
 * answered with the list and nothing changes (`added: false`).
 */
export async function addSenderAddress(
  userId: string,
  rawAddress: unknown,
  dependencies: SenderAddressDependencies = {},
): Promise<{ added: boolean; senders: SenderAddressView[] }> {
  const address = typeof rawAddress === "string" ? normalizeSenderAddress(rawAddress) : undefined;
  if (!address) throw new AppError("sender_address_invalid", SENDER_ADDRESS_WORDS.invalid, 400);
  return withSenderLock(userId, async (executor) => {
    const now = dependencies.now?.() ?? new Date();
    /* The sign-in row is seeded first, so it is the one counted and the one an
       add of the sign-in address finds. */
    await seedSenderAddress(userId, dependencies, executor);
    const cipher = await requireInstanceMetadataWriter(executor);
    const addressIndex = cipher.senderAddressIndex(address);
    if (addressIndex === null) throw new AppError("sender_address_invalid", SENDER_ADDRESS_WORDS.invalid, 400);
    const rows = await executor.select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId));
    if (rows.some((row) => row.addressIndex === addressIndex)) {
      return { added: false, senders: await listSenderAddresses(userId, dependencies, executor) };
    }
    const claimed = rows.filter((row) => row.addressIndex !== null);
    const seeded = claimed.some((row) => row.source !== "manual");
    if (claimed.length + (seeded ? 0 : 1) >= MAX_SENDER_ADDRESSES_PER_USER) {
      throw new AppError("sender_address_limit", SENDER_ADDRESS_WORDS.limit, 409);
    }
    /* The row id exists before the address is encrypted (ADR-0024 decision 3). */
    const id = randomUUID();
    await executor.insert(mailInSenderAddresses).values({
      id,
      userId,
      addressEnc: cipher.encryptText("mail_in_sender_addresses.address", id, address),
      addressIndex,
      source: "manual",
      createdAt: now,
      updatedAt: now,
    });
    return { added: true, senders: await listSenderAddresses(userId, dependencies, executor) };
  }, { wait: true });
}

/**
 * Removes one of the member's extra addresses (#1650). The seeded sign-in row
 * is never removable (409 `sender_address_seeded`; the screen offers no
 * `remove` on it, so this is the backstop). A checked extra row may go even
 * when it leaves the member with nothing checked. Mail held under the row
 * goes with it.
 */
export async function removeSenderAddress(
  userId: string,
  id: string,
  dependencies: SenderAddressDependencies = {},
): Promise<SenderAddressView[]> {
  if (!validUuid(id)) throw new AppError("sender_address_unknown", SENDER_ADDRESS_WORDS.unknown, 404);
  return withSenderLock(userId, async (executor) => {
    const now = dependencies.now?.() ?? new Date();
    /* FOR UPDATE before the detach (#1810 item 3): a filer holding the row
       FOR SHARE is waited for, so the receipt it files is detached too. */
    const [row] = await executor.select().from(mailInSenderAddresses)
      .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId))).limit(1).for("update");
    if (!row || row.addressIndex === null) throw new AppError("sender_address_unknown", SENDER_ADDRESS_WORDS.unknown, 404);
    if (row.source !== "manual") throw new AppError("sender_address_seeded", SENDER_ADDRESS_WORDS.seeded, 409);
    await detachHeldMail(executor, [row.id], now);
    await executor.delete(mailInSenderAddresses).where(and(eq(mailInSenderAddresses.id, row.id), eq(mailInSenderAddresses.userId, userId)));
    return listSenderAddresses(userId, dependencies, executor);
  }, { wait: true });
}

/**
 * Removes every extra address still unchecked `SENDER_UNVERIFIED_TTL_MS`
 * after it was added and no check link is still good: a link sent inside the
 * 14 days keeps the row until it lapses (A-S2), never longer (#1650, owner
 * decision 51), and no row outlives 15 days whatever link it holds (#1810
 * item 5), quietly, with the mail held under it. Seeded rows and checked rows are never removed by time. Run from
 * the mail-in retention sweep; returns how many rows went.
 */
export async function sweepUncheckedSenderAddresses(now: Date = new Date()): Promise<number> {
  return getDb().transaction(async (transaction) => {
    const expired = await transaction.select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses).where(and(
      eq(mailInSenderAddresses.source, "manual"),
      isNull(mailInSenderAddresses.verifiedAt),
      lt(mailInSenderAddresses.createdAt, new Date(now.getTime() - SENDER_UNVERIFIED_TTL_MS)),
      or(
        isNull(mailInSenderAddresses.verificationExpiresAt),
        lte(mailInSenderAddresses.verificationExpiresAt, now),
        lt(mailInSenderAddresses.createdAt, new Date(now.getTime() - SENDER_UNVERIFIED_MAX_LIFE_MS)),
      ),
    )).orderBy(asc(mailInSenderAddresses.id)).for("update").limit(500);
    const ids = expired.map((row) => row.id);
    if (ids.length === 0) return 0;
    await detachHeldMail(transaction, ids, now);
    await transaction.delete(mailInSenderAddresses).where(and(
      inArray(mailInSenderAddresses.id, ids),
      isNull(mailInSenderAddresses.verifiedAt),
    ));
    return ids.length;
  });
}

/**
 * Who LISTS a sending address without having checked it (#1650, owner
 * decision 51), for mail that matched no verified holder. `listed` only when
 * exactly one active member lists it: their mail is held for them, not
 * addable. With two or more, it is held for nobody (note 55316), since
 * holding it for either could show one member's mail to the other. A seeded
 * row counts only while it is still the member's registered address, as for
 * matching; an extra row counts as it stands.
 */
export type ListedSenderMatch =
  | { state: "listed"; userId: string; senderAddressId: string }
  | { state: "none" };

export async function listedUncheckedSender(address: string): Promise<ListedSenderMatch> {
  const normalized = normalizeSenderAddress(address);
  if (!normalized) return { state: "none" };
  const cipher = await openInstanceMetadataReader();
  if (cipher.locked) return { state: "none" };
  const addressIndex = cipher.senderAddressIndex(normalized);
  if (addressIndex === null) return { state: "none" };
  const rows = await getDb().select({
    id: mailInSenderAddresses.id,
    userId: mailInSenderAddresses.userId,
    source: mailInSenderAddresses.source,
    disabledAt: users.disabledAt,
    emailEnc: users.emailEnc,
  })
    .from(mailInSenderAddresses)
    .innerJoin(users, eq(users.id, mailInSenderAddresses.userId))
    .where(and(
      eq(mailInSenderAddresses.addressIndex, addressIndex),
      isNull(mailInSenderAddresses.verifiedAt),
    ));
  const listing = new Map<string, string>();
  for (const candidate of rows) {
    if (candidate.disabledAt) continue;
    if (candidate.source !== "manual") {
      const registered = cipher.text("users.email", candidate.userId, { encrypted: candidate.emailEnc });
      if (normalizeSenderAddress(registered.value ?? undefined) !== normalized) continue;
    }
    listing.set(candidate.userId, candidate.id);
  }
  if (listing.size !== 1) return { state: "none" };
  const [[userId, senderAddressId]] = [...listing];
  return { state: "listed", userId, senderAddressId };
}
