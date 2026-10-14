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
 * member's seed, list and send queue behind each other (two presses, or a
 * press and a settings read, cannot interleave). Advisory rather than a lock
 * on the `users` row: that would hold up sign-in for as long as the mailer
 * takes to answer.
 */
export async function withSenderLock<T>(userId: string, work: (executor: MetadataExecutor) => Promise<T>): Promise<T> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:mail-relay-sender:${userId}`}, 0))`);
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
  return rows.map((row) => viewOf(row, now, cipher));
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
 * never take an address away from the member who verified it. In that case a
 * stale row is still dropped, because it no longer matches the account.
 *
 * Only a row that READS as a different address is dropped. A row that cannot
 * be decrypted proves nothing about which address it holds (a locked or
 * damaged value may well be the verified, registered one), so it is left
 * alone, and while one remains no replacement is seeded beside it.
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

  let matches = false;
  let unreadable = false;
  const stale: Array<typeof mailInSenderAddresses.$inferSelect> = [];
  for (const row of existingRows) {
    const value = readAddress(reader, row).value;
    if (value === null) unreadable = true;
    else if (normalizeSenderAddress(value) === address) matches = true;
    else stale.push(row);
  }

  const cipher = await requireInstanceMetadataWriter(executor);
  /* The rate limit is the member's, not the address's: a replaced row keeps it. */
  let carriedChecks: Date[] = [];
  if (stale.length > 0) {
    carriedChecks = stale[0].checkSentAt;
    await executor.delete(mailInSenderAddresses).where(and(
      eq(mailInSenderAddresses.userId, userId),
      inArray(mailInSenderAddresses.id, stale.map((row) => row.id)),
    ));
  }
  if (matches || unreadable) return;

  const addressIndex = cipher.senderAddressIndex(address);
  /* An address somebody already claims is left exactly as it is: seeding must
     never take an address away from the member who verified it. */
  if (await existingClaim(addressIndex, executor)) return;

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
    checkSentAt: carriedChecks,
    updatedAt: now,
  }).onConflictDoNothing();
}

function verificationUrl(appUrl: string, token: string): string {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new AppError("app_url_not_configured", "Orbit does not know its own address, so it cannot build the check link", 503);
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
  return withSenderLock(userId, (executor) => sendWithin(executor, userId, id, dependencies));
}

/**
 * The whole "check my address" request for one member: seed, read, send, in
 * ONE transaction under the member's lock. A press that fails anywhere —
 * including the mailer — leaves nothing behind.
 */
export async function requestSenderCheck(
  userId: string,
  dependencies: SenderAddressDependencies = {},
): Promise<{ address: string; expiresAt: Date }> {
  return withSenderLock(userId, async (executor) => {
    await seedSenderAddress(userId, dependencies, executor);
    const [row] = await listSenderAddresses(userId, dependencies, executor);
    if (!row) {
      throw new AppError("sender_address_unavailable", "Orbit has no address to check for this account", 409);
    }
    if (row.verified) throw new AppError("sender_already_verified", "That address is already checked", 409);
    return sendWithin(executor, userId, row.id, dependencies);
  });
}

async function sendWithin(
  executor: MetadataExecutor,
  userId: string,
  id: string,
  dependencies: SenderAddressDependencies,
): Promise<{ address: string; expiresAt: Date }> {
  const now = dependencies.now?.() ?? new Date();
  const [row] = await executor.select().from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId))).limit(1);
  if (!row) throw new AppError("sender_address_unknown", "That address is not on this account", 404);
  if (row.verifiedAt) throw new AppError("sender_already_verified", "That address is already checked", 409);

  /* The link goes to the address itself, so an address Orbit cannot read is an
     address Orbit cannot check (#969). Refused rather than sent anywhere: a
     missing value must never become an empty or invented recipient. */
  const address = readAddress(await openInstanceMetadataReader(executor), row).value;
  if (!address) {
    throw new AppError("metadata_locked", "Orbit cannot read this address until the encryption key is available", 503);
  }

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
  const expiresAt = new Date(now.getTime() + SENDER_VERIFICATION_TTL_MS);
  const send = dependencies.sendMail ?? defaultSender(smtp);

  /* Check, write the token, send and record, all in the caller's transaction
     under the member's lock: two presses by the same member queue on the lock,
     and the second sees the first's send (two-step "lock, then
     check-and-record", as the sign-in lockout does for its attempt count). The
     token and the send are recorded only once the mailer has taken the
     message; if it throws, the transaction rolls back, so neither the count
     nor the outstanding link changes. */
  const [locked] = await executor.select({
    verifiedAt: mailInSenderAddresses.verifiedAt,
    checkSentAt: mailInSenderAddresses.checkSentAt,
  }).from(mailInSenderAddresses)
    .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId)))
    .for("update");
  if (!locked) throw new AppError("sender_address_unknown", "That address is not on this account", 404);
  if (locked.verifiedAt) throw new AppError("sender_already_verified", "That address is already checked", 409);

  /* The clock is the process's, not the database's `now()`, as everywhere
     else in this file. */
  const sentAt = dependencies.now?.() ?? new Date();
  const wait = senderCheckWaitSeconds(locked.checkSentAt, sentAt);
  if (wait > 0) {
    throw new RateLimitedError(
      "sender_check_too_soon",
      "A check email was sent recently; try again shortly",
      wait,
    );
  }

  const [updated] = await executor.update(mailInSenderAddresses).set({
    verificationTokenDigest: digestToken(token),
    verificationExpiresAt: expiresAt,
    updatedAt: now,
  }).where(and(
    eq(mailInSenderAddresses.id, id),
    eq(mailInSenderAddresses.userId, userId),
    isNull(mailInSenderAddresses.verifiedAt),
  )).returning({ id: mailInSenderAddresses.id });
  if (!updated) throw new AppError("sender_already_verified", "That address is already checked", 409);

  await send({
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
  });

  const kept = locked.checkSentAt
    .filter((at) => at.getTime() > sentAt.getTime() - SENDER_CHECK_WINDOW_MS)
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(-(SENDER_CHECK_DAILY_LIMIT - 1));
  await executor.update(mailInSenderAddresses).set({ checkSentAt: [...kept, sentAt] })
    .where(and(eq(mailInSenderAddresses.id, id), eq(mailInSenderAddresses.userId, userId)));
  return { address, expiresAt };
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
 * index at all; rather than throw, it attributes to nobody (fail closed),
 * because mail-in must keep running while the key is away and an address it
 * cannot read simply belongs to nobody.
 */
export async function userForVerifiedSender(address: string): Promise<string | undefined> {
  const normalized = normalizeSenderAddress(address);
  if (!normalized) return undefined;
  const cipher = await openInstanceMetadataReader();
  if (cipher.locked) return undefined;
  const addressIndex = cipher.senderAddressIndex(normalized);
  if (addressIndex === null) return undefined;
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
  const row = rows.find((candidate) => !candidate.disabledAt
    && normalizeSenderAddress(
      cipher.text("users.email", candidate.userId, { encrypted: candidate.emailEnc }).value ?? undefined,
    ) === normalized);
  return row?.userId;
}
