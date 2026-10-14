import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { auditLog, externalIdentities, instanceAuthority, userPreferences, users } from "@/db/schema";
import { getDb } from "@/db";
import { ACCOUNT_LIFECYCLE_LOCK_KEY, INSTANCE_BOOTSTRAP_LOCK_KEY } from "@/lib/auth/authority-locks";
import { AuthError } from "@/lib/auth/errors";
import type { VerifiedIdentity } from "@/lib/auth/oidc";
import { MetadataCipher, requireInstanceMetadataWriter } from "@/server/metadata/fields";

export interface ProvisionedUser {
  id: string;
  /**
   * Null when the stored address will not authenticate (#969). Never an empty
   * string: "we cannot read it" and "it is blank" are different facts and the
   * caller must be able to tell them apart.
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
 * An account address is read from its encrypted column only (#1403 Q3). A row
 * with no usable ciphertext, or a damaged one, reads as null rather than as an
 * empty address (#969).
 */
function readEmail(
  cipher: MetadataCipher,
  row: { id: string; emailEnc: string | null },
): string | null {
  return cipher.text("users.email", row.id, { encrypted: row.emailEnc }).value;
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
    /* One instance-scope cipher for the whole transaction. Strict: an instance
       with no usable key is in maintenance and nobody signs in (#1405). */
    const cipher = await requireInstanceMetadataWriter(transaction);

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

      const refreshed = resolveRefreshedEmail(
        readEmail(cipher, existing),
        identity.email,
        incomingTakenByAnother,
      );
      const addressColumns = refreshed === null
        ? {}
        : {
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

    /* The id is minted here rather than by the database, because the address
       is bound to its own row id by the envelope's AAD: the ciphertext cannot
       be written before the id it belongs to is known. */
    const userId = randomUUID();
    const [created] = await transaction
      .insert(users)
      .values({
        id: userId,
        emailEnc: cipher.encryptText("users.email", userId, identity.email),
        emailIndex: cipher.emailIndex(identity.email),
        emailVerified: identity.emailVerified,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        isInstanceAdmin: claiming,
      })
      .returning({
        id: users.id,
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
 * Matched through the blind index only (#1403 Q3); it folds case when it is
 * computed. A cipher that cannot produce an index (locked) matches nothing,
 * and `requireInstanceMetadataWriter` has already refused that case.
 */
async function ownerOfEmail(
  transaction: ProvisioningTransaction,
  cipher: MetadataCipher,
  email: string,
  exceptUserId?: string,
): Promise<string | undefined> {
  const index = cipher.emailIndex(email);
  if (index === null) return undefined;
  const matchesEmail = eq(users.emailIndex, index);
  const [row] = await transaction
    .select({ id: users.id })
    .from(users)
    .where(exceptUserId ? and(matchesEmail, ne(users.id, exceptUserId)) : matchesEmail)
    .limit(1);
  return row?.id;
}
