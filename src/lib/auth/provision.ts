import { randomUUID } from "node:crypto";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { auditLog, externalIdentities, instanceAuthority, userPreferences, users } from "@/db/schema";
import { getDb } from "@/db";
import { ACCOUNT_LIFECYCLE_LOCK_KEY, INSTANCE_BOOTSTRAP_LOCK_KEY } from "@/lib/auth/authority-locks";
import { AuthError } from "@/lib/auth/errors";
import type { VerifiedIdentity } from "@/lib/auth/oidc";
import { MetadataCipher, openInstanceMetadataCipher } from "@/server/metadata/fields";

export interface ProvisionedUser {
  id: string;
  /**
   * Null when the instance has no usable encryption key, so the stored address
   * cannot be read (#969). Never an empty string: "we cannot read it" and "it
   * is blank" are different facts and the caller must be able to tell them
   * apart.
   */
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
  disabledAt: Date | null;
}

export interface ProvisionOptions {
  /**
   * True only when the callback opened a transaction sealed by a browser that
   * had presented the claim code (ADR-0022 §2). It is what turns this sign-in
   * into the claim; nothing a browser can write reaches this flag.
   */
  bootstrap?: boolean;
}

/** What a callback should do with an identity, given the facts about it. */
export type ProvisioningDecision =
  | { kind: "sign_in" }
  | { kind: "claim" }
  | { kind: "register" }
  | { kind: "refuse"; code: "bootstrap_required" | "bootstrap_claimed" | "link_required" };

export interface ProvisioningFacts {
  /** This `(issuer, subject)` already has an `external_identities` row. */
  identityKnown: boolean;
  /** `instance_authority` has a row: the instance has a primary administrator. */
  claimed: boolean;
  /** The sign-in started from a browser holding a valid claim cookie. */
  bootstrap: boolean;
  /** Some other user already holds this email, compared case-insensitively. */
  emailTaken: boolean;
}

/**
 * The whole registration policy (ADR-0022 §2, ADR-0023 §3) as one decision,
 * kept apart from the transaction below so the rules can be read — and
 * tested — without a database.
 *
 * - A known identity always signs in. Nothing about the claim changes that.
 * - While unclaimed, only a claim-cookie sign-in creates anything; every
 *   other caller is refused and NOTHING is written. There is no other way to
 *   get the first account.
 * - Once claimed, a claim attempt is late: the race is decided by state, so
 *   the loser is told the instance is claimed rather than seated beside the
 *   winner.
 * - After the claim OIDC self-registers, unless the email already belongs to
 *   someone: that is `link_required`, and nothing is created. Email equality
 *   never links anything, verified or not.
 */
export function decideProvisioning(facts: ProvisioningFacts): ProvisioningDecision {
  if (facts.identityKnown) return { kind: "sign_in" };
  if (!facts.claimed) {
    return facts.bootstrap ? { kind: "claim" } : { kind: "refuse", code: "bootstrap_required" };
  }
  if (facts.bootstrap) return { kind: "refuse", code: "bootstrap_claimed" };
  if (facts.emailTaken) return { kind: "refuse", code: "link_required" };
  return { kind: "register" };
}

/**
 * Which email a returning user keeps when the provider offers a new one
 * (ADR-0023 §2). The case-insensitive unique index means a provider that
 * moves a linked user onto an address another user already holds would
 * otherwise fail the sign-in; keeping the stored address instead is the
 * lesser fault, and the user can still be reached at what Orbit knows.
 */
export function resolveRefreshedEmail(
  storedEmail: string | null,
  incomingEmail: string,
  incomingTakenByAnother: boolean,
): string | null {
  return incomingTakenByAnother ? storedEmail : incomingEmail;
}

/**
 * The refusal when a path that must WRITE an address meets an instance with no
 * usable encryption key (#969). Registering an identity and claiming the
 * instance both write the first address, so both need the key; signing an
 * already-known identity in does not, and deliberately still works.
 *
 * Distinct from every other refusal here on purpose: an operator who has lost
 * the key must be told that, not told their provider was rejected.
 */
const INSTANCE_LOCKED_REFUSAL = "This Orbit instance cannot be set up until its encryption key is available";

/**
 * The dual read for an account address: an encrypted row is decrypted, a row
 * the backfill has not reached is read from its plaintext column, and a locked
 * or damaged value reads as null rather than as an empty address (#969).
 */
function readEmail(
  cipher: MetadataCipher,
  row: { id: string; email: string | null; emailEnc: string | null },
): string | null {
  return cipher.text("users.email", row.id, { encrypted: row.emailEnc, plaintext: row.email }).value;
}

const refusals = {
  bootstrap_required: {
    message: "This Orbit instance has not been claimed yet",
    status: 403,
  },
  bootstrap_claimed: {
    message: "This Orbit instance has already been claimed",
    status: 409,
  },
  link_required: {
    message: "An Orbit account already uses this email address. Sign in to it and link this provider from settings.",
    status: 403,
  },
} as const;

/**
 * Provisions by immutable issuer/subject only. A transaction-scoped advisory
 * lock prevents concurrent first callbacks from creating duplicate users, and
 * the bootstrap lock serialises the claim so N racing claimants leave exactly
 * one authority row.
 */
export async function provisionIdentity(
  identity: VerifiedIdentity,
  options: ProvisionOptions = {},
): Promise<ProvisionedUser> {
  return getDb().transaction(async (transaction) => {
    // JSON preserves the issuer/subject boundary without PostgreSQL-forbidden NUL bytes.
    const lockKey = JSON.stringify([identity.issuer, identity.subject]);
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const [existing] = await transaction
      .select({
        id: users.id,
        email: users.email,
        emailEnc: users.emailEnc,
        emailVerified: users.emailVerified,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        disabledAt: users.disabledAt,
      })
      .from(externalIdentities)
      .innerJoin(users, eq(users.id, externalIdentities.userId))
      .where(and(
        eq(externalIdentities.issuer, identity.issuer),
        eq(externalIdentities.subject, identity.subject),
      ))
      .limit(1);

    /* The claim facts are read only where they can matter — a known identity
       signs in whatever they say — so an ordinary sign-in still takes no
       instance-wide lock. Reading them UNDER the bootstrap lock is what makes
       the race safe: N racing claimants queue here, and every one after the
       winner sees the authority row the winner wrote. */
    /* One instance-scope cipher for the whole transaction. It is locked, not
       refused, when there is no usable key: signing a known identity in must
       still work without one, and the paths that must WRITE an address refuse
       explicitly below rather than failing here (#969). */
    const cipher = await openInstanceMetadataCipher(transaction);

    const identityKnown = Boolean(existing);
    let claimed = false;
    let emailTaken = false;
    if (!identityKnown) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INSTANCE_BOOTSTRAP_LOCK_KEY}, 0))`);
      const [authority] = await transaction
        .select({ seats: sql<number>`count(*)::int` })
        .from(instanceAuthority);
      claimed = (authority?.seats ?? 0) > 0;
      emailTaken = (await ownerOfEmail(transaction, cipher, identity.email)) !== undefined;
    }

    const decision = decideProvisioning({
      identityKnown,
      claimed,
      bootstrap: options.bootstrap === true,
      emailTaken,
    });

    if (decision.kind === "refuse") {
      const refusal = refusals[decision.code];
      throw new AuthError(decision.code, refusal.message, refusal.status);
    }

    if (decision.kind === "sign_in" && existing) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);
      const [current] = await transaction
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, existing.id))
        .limit(1);
      if (!current || current.disabledAt) {
        throw new AuthError("account_disabled", "This Orbit account is disabled", 403);
      }
      const incomingTakenByAnother = (await ownerOfEmail(transaction, cipher, identity.email, existing.id)) !== undefined;

      /* An identity Orbit already knows signs in on issuer and subject alone,
         which never touch the address (#969). So a locked instance must not
         block this: the refresh of the stored address is skipped and the row's
         existing ciphertext is left exactly as it stands, while the name and
         picture — neither encrypted — refresh as usual. Writing here instead
         would clear a plaintext address it could not replace. */
      const refreshed = resolveRefreshedEmail(
        cipher.locked ? null : readEmail(cipher, existing),
        identity.email,
        incomingTakenByAnother,
      );
      const addressColumns = cipher.locked || refreshed === null
        ? {}
        : {
          email: null,
          emailEnc: cipher.encryptText("users.email", existing.id, refreshed),
          emailIndex: cipher.emailIndex(refreshed),
        };

      const [updated] = await transaction
        .update(users)
        .set({
          ...addressColumns,
          emailVerified: identity.emailVerified,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id))
        .returning({
          id: users.id,
          email: users.email,
          emailEnc: users.emailEnc,
          emailVerified: users.emailVerified,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          disabledAt: users.disabledAt,
        });
      await transaction
        .update(externalIdentities)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(externalIdentities.issuer, identity.issuer),
          eq(externalIdentities.subject, identity.subject),
        ));
      return { ...updated, email: readEmail(cipher, updated) };
    }

    const claiming = decision.kind === "claim";

    /* Registering writes the account's first address, so unlike signing in it
       genuinely cannot proceed without the key (#969). Refused in its own
       words: an operator whose key is missing must not be told their identity
       provider was rejected. Claiming is the same case and the louder one —
       it is the first thing a new instance does. */
    if (cipher.locked) {
      throw new AuthError("instance_locked", INSTANCE_LOCKED_REFUSAL, 503);
    }

    /* The id is minted here rather than by the database, because the address
       is bound to its own row id by the envelope's AAD: the ciphertext cannot
       be written before the id it belongs to is known. */
    const userId = randomUUID();
    const [created] = await transaction
      .insert(users)
      .values({
        id: userId,
        email: null,
        emailEnc: cipher.encryptText("users.email", userId, identity.email),
        emailIndex: cipher.emailIndex(identity.email),
        emailVerified: identity.emailVerified,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        isInstanceAdmin: claiming,
      })
      .returning({
        id: users.id,
        email: users.email,
        emailEnc: users.emailEnc,
        emailVerified: users.emailVerified,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        disabledAt: users.disabledAt,
      });

    await transaction.insert(externalIdentities).values({
      userId: created.id,
      issuer: identity.issuer,
      subject: identity.subject,
    });
    await transaction.insert(userPreferences).values({ userId: created.id }).onConflictDoNothing();

    /* The claimant is the instance's first administrator and its primary
       administrator (#263), seated atomically under the bootstrap lock so
       there is never an instance with administrators but no seat of final
       authority. The claim (ADR-0022) is now the only entry point to this;
       the invariant is unchanged. */
    if (claiming) {
      await transaction.insert(instanceAuthority).values({ primaryUserId: created.id });
      await transaction.insert(auditLog).values({
        householdId: null,
        actorUserId: created.id,
        entityType: "user",
        entityId: created.id,
        action: "instance_claimed",
        changes: { method: "oidc" },
      });
    }
    return { ...created, email: readEmail(cipher, created) };
  });
}

type ProvisioningTransaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * The id of the user holding this email, ignoring case and one excluded id.
 *
 * Two matches, not one (#969): the blind index finds an encrypted row, and the
 * case-insensitive plaintext comparison finds a row the backfill has not
 * reached yet. Both stand for the length of the expand release, and a row is
 * only ever in one of the two states, so this cannot double-count.
 *
 * A locked instance can produce no index, so only the plaintext half runs. That
 * is not a hole: the only path that reaches here without a key is one that is
 * about to be refused anyway.
 */
async function ownerOfEmail(
  transaction: ProvisioningTransaction,
  cipher: MetadataCipher,
  email: string,
  exceptUserId?: string,
): Promise<string | undefined> {
  const plaintextMatch = sql`lower(${users.email}) = lower(${email})`;
  const index = cipher.locked ? null : cipher.emailIndex(email);
  const matchesEmail = index === null
    ? plaintextMatch
    : or(eq(users.emailIndex, index), plaintextMatch);
  const [row] = await transaction
    .select({ id: users.id })
    .from(users)
    .where(exceptUserId ? and(matchesEmail, ne(users.id, exceptUserId)) : matchesEmail)
    .limit(1);
  return row?.id;
}
