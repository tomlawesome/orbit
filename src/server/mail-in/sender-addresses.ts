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
 * attribution and the uniqueness rule both look up, and the plaintext column
 * stands only until the backfill reaches the row.
 *
 * This lives outside `core/` because it needs `getDb`/schema access, which
 * `core/` is not allowed (see this directory's README).
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { externalIdentities, mailInSenderAddresses, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import {
  openInstanceMetadataReader,
  requireInstanceMetadataWriter,
  type MetadataCipher,
  type MetadataFieldState,
} from "@/server/metadata/fields";
import { metadataCryptoAvailable } from "@/server/metadata/keys";
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
  /** Present only when something is unreadable, as elsewhere (ADR-0024 decision 5). */
  metadataStatus?: { address?: MetadataFieldState };
}

/** An explicit clock seam for tests; the default is the real one. */
export interface SenderAddressDependencies {
  now?: () => Date;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The stored address, decrypted (#969).
 *
 * Dual read for the length of the expand release, as everywhere else: a row
 * whose `address_enc` is set is decrypted under the INSTANCE key, and a row
 * the backfill has not reached is read from its plaintext column.
 */
function readAddress(
  cipher: MetadataCipher,
  row: { id: string; address: string | null; addressEnc: string | null },
) {
  return cipher.text("mail_in_sender_addresses.address", row.id, { encrypted: row.addressEnc, plaintext: row.address });
}

/**
 * Any row already claiming this address — this member's or anybody else's.
 *
 * The blind index is what carries "one account per sending address" across the
 * encryption, and the plaintext arm catches a row the backfill has not reached
 * yet: without it an encrypted insert would not collide with an existing
 * plaintext claim, and the address would end up claimed twice.
 */
async function existingClaim(
  address: string,
  addressIndex: string | null,
): Promise<typeof mailInSenderAddresses.$inferSelect | undefined> {
  const [row] = await getDb().select().from(mailInSenderAddresses)
    .where(addressIndex === null
      ? eq(mailInSenderAddresses.address, address)
      : or(eq(mailInSenderAddresses.addressIndex, addressIndex), eq(mailInSenderAddresses.address, address)))
    .limit(1);
  return row;
}

function viewOf(
  row: typeof mailInSenderAddresses.$inferSelect,
  now: Date,
  cipher: MetadataCipher,
): SenderAddressView {
  const address = readAddress(cipher, row);
  return {
    id: row.id,
    address: address.value,
    source: row.source,
    verified: row.verifiedAt !== null,
    verificationPending: row.verifiedAt === null
      && row.verificationExpiresAt !== null
      && row.verificationExpiresAt.getTime() > now.getTime(),
    metadataStatus: address.state ? { address: address.state } : undefined,
  };
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
 * member proving they send from it.
 *
 * Idempotent, and silent when the address already belongs to somebody else:
 * seeding must never take an address away from the member who verified it.
 */
export async function seedSenderAddress(userId: string, dependencies: SenderAddressDependencies = {}): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  const [existing] = await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses)
    .where(eq(mailInSenderAddresses.userId, userId)).limit(1);
  if (existing) return;

  /* Seeding writes an encrypted claim now (#969), so it needs the instance
     key. A locked instance simply does not seed: this runs on the member's own
     read of the relay page, and refusing that whole page for a convenience is
     the wrong trade — the next read seeds it once the key is back. */
  if (!metadataCryptoAvailable()) return;

  const [account] = await getDb().select({ email: users.email, emailEnc: users.emailEnc })
    .from(users).where(eq(users.id, userId)).limit(1);
  const [identity] = await getDb().select({ id: externalIdentities.id }).from(externalIdentities)
    .where(eq(externalIdentities.userId, userId)).limit(1);
  const reader = await openInstanceMetadataReader();
  const accountEmail = account
    ? reader.text("users.email", userId, { encrypted: account.emailEnc, plaintext: account.email }).value
    : null;
  const address = normalizeSenderAddress(accountEmail ?? undefined);
  if (!address) return;

  const cipher = await requireInstanceMetadataWriter();
  const addressIndex = cipher.senderAddressIndex(address);
  /* An address somebody already claims is left exactly as it is: seeding must
     never take an address away from the member who verified it. */
  if (await existingClaim(address, addressIndex)) return;

  /* The row id exists before the address is encrypted: the content AAD binds
     the ciphertext to its row, so a value cannot be replayed into another
     claim (ADR-0024 decision 3). */
  const id = randomUUID();
  await getDb().insert(mailInSenderAddresses).values({
    id,
    userId,
    address: null,
    addressEnc: cipher.encryptText("mail_in_sender_addresses.address", id, address),
    addressIndex,
    source: identity ? "sso" : "account",
    updatedAt: now,
  }).onConflictDoNothing();
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
  return viewOf(verified, now, await openInstanceMetadataReader());
}

/**
 * The member a verified address belongs to, or nobody.
 *
 * This is the whole of attribution's database side, and it is deliberately
 * narrow: one exact normalised address, verified only, and never a prefix, a
 * domain or a pattern. A disabled account attributes nothing.
 *
 * The match is on the BLIND INDEX now (#969), which is what carries an exact
 * address lookup across the encryption, plus the plaintext for a row the
 * backfill has not reached yet — both arms in the one query, so attribution
 * behaves the same either side of the backfill. A locked instance cannot
 * produce an index at all; rather than throw, it matches on plaintext alone,
 * because mail-in must keep running while the key is away and an address it
 * cannot read simply attributes to nobody.
 */
export async function userForVerifiedSender(address: string): Promise<string | undefined> {
  const normalized = normalizeSenderAddress(address);
  if (!normalized) return undefined;
  const cipher = await openInstanceMetadataReader();
  const addressIndex = cipher.locked ? null : cipher.senderAddressIndex(normalized);
  const [row] = await getDb().select({ userId: mailInSenderAddresses.userId, disabledAt: users.disabledAt })
    .from(mailInSenderAddresses)
    .innerJoin(users, eq(users.id, mailInSenderAddresses.userId))
    .where(and(
      addressIndex === null
        ? eq(mailInSenderAddresses.address, normalized)
        : or(eq(mailInSenderAddresses.addressIndex, addressIndex), eq(mailInSenderAddresses.address, normalized)),
      isNotNull(mailInSenderAddresses.verifiedAt),
    ))
    .limit(1);
  return row && !row.disabledAt ? row.userId : undefined;
}
