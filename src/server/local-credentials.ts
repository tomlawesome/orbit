/*
 * Local credentials: the repository behind password sign-in (ADR-0023 §2, §4).
 *
 * A user has a credential, an identity, or both. This module owns the
 * credential half — creating the local half of an account, and verifying a
 * password against it under the persisted backoff that makes guessing
 * expensive.
 *
 * Two properties are load-bearing and easy to lose in a later edit:
 *
 *  - **Every failure looks the same.** Unknown address, wrong password,
 *    disabled account and an account with no credential all return the same
 *    verdict, and all spend the same Argon2id derivation — the decoy hash of
 *    ADR-0021 §5 stands in where there is no stored hash. Nothing here returns
 *    a reason a caller could turn into "that address exists".
 *  - **The counter is a row, not a variable.** `local_credentials` carries
 *    `failed_attempt_count` and `locked_until`, so a restart does not hand an
 *    attacker five fresh attempts. (The claim's backoff is deliberately the
 *    other way round — see `src/lib/auth/bootstrap.ts`, which explains why.)
 *
 * Password plaintext is never logged, audited, returned or stored; only the
 * PHC string `src/lib/auth/password.ts` produces reaches the table.
 *
 * Later M7 slices add `setPassword`, `issueSetupToken`, `consumeSetupToken`,
 * `listMethods` and the unlink pair here (the plan's module map). Keep the
 * exported surface to what a route actually calls.
 */

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  auditLog,
  externalIdentities,
  instanceAuthority,
  localCredentials,
  userPreferences,
  users,
} from "@/db/schema";
import { ACCOUNT_LIFECYCLE_LOCK_KEY, INSTANCE_BOOTSTRAP_LOCK_KEY } from "@/lib/auth/authority-locks";
import { AuthError } from "@/lib/auth/errors";
import type { VerifiedIdentity } from "@/lib/auth/oidc";
import { hashPassword, verifyAgainstDecoy, verifyPassword } from "@/lib/auth/password";
import type { RecentAuthentication } from "@/lib/auth/recent-auth";
import { VerificationGateRefusedError } from "@/lib/auth/verification-gate";
import { getAuthConfig } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";

/** Failures allowed before a credential starts locking (ADR-0023 §4). */
export const LOCAL_SIGN_IN_FREE_ATTEMPTS = 5;

/** The sixth failure's penalty; each further failure doubles it. */
export const LOCAL_LOCKOUT_FLOOR_MS = 1_000;

/** The doubling stops here: 15 minutes, never permanent (ADR-0023 §4). */
export const LOCAL_LOCKOUT_CEILING_MS = 900_000;

/** Longer than any real address; bounds what a hostile body can ask us to parse. */
const MAX_EMAIL_LENGTH = 320;

/** Bounds the one free-text field a local account carries. */
const MAX_DISPLAY_NAME_LENGTH = 128;

/**
 * How long a credential is locked after `failures` consecutive failures.
 * Zero while the free attempts last, then 1 s doubling to the 15 minute
 * ceiling — so the sixth failure costs a second and the tenth costs sixteen.
 */
function lockoutMs(failures: number): number {
  const overrun = failures - LOCAL_SIGN_IN_FREE_ATTEMPTS;
  if (overrun <= 0) return 0;
  return Math.min(LOCAL_LOCKOUT_FLOOR_MS * 2 ** (overrun - 1), LOCAL_LOCKOUT_CEILING_MS);
}

export interface LocalUserDraft {
  email: string;
  displayName: string;
  /**
   * The PHC string to store (ADR-0021 §2). Omitted for an administrator-created
   * user who has not chosen a password yet: that account exists with no
   * credential row until it consumes a setup token, and cannot sign in
   * meanwhile.
   */
  passwordHash?: string;
}

export interface LocalUser {
  id: string;
  email: string;
  displayName: string;
}

export interface CreateLocalUserOptions {
  /**
   * True only for the claim (ADR-0022 §2): the caller presented the claim
   * cookie, so this user is seated as the instance's first administrator and
   * its primary administrator, atomically, under the bootstrap lock.
   */
  bootstrap?: boolean;
}

const emailSchema = z.email().max(MAX_EMAIL_LENGTH);

/**
 * Creates a local user, and — when this is the claim — the whole first-run
 * state with it, in one transaction (ADR-0022 §2): the user as instance
 * administrator, their credential, their preferences, the `instance_authority`
 * row and the `instance_claimed` audit record.
 *
 * The claim path reads the authority table under `INSTANCE_BOOTSTRAP_LOCK_KEY`,
 * so two claimants racing with valid cookies leave exactly one authority row
 * and the loser is told the instance is claimed. That is the same lock, and
 * the same outcome, as the OIDC claim in `provisionIdentity`.
 */
export async function createLocalUser(
  draft: LocalUserDraft,
  options: CreateLocalUserOptions = {},
): Promise<LocalUser> {
  const email = draft.email.trim();
  const displayName = draft.displayName.trim();
  if (!emailSchema.safeParse(email).success) {
    throw new AuthError("invalid_request", "Enter a valid email address", 400);
  }
  if (displayName.length < 1 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new AuthError("invalid_request", "Enter a name of up to 128 characters", 400);
  }

  return getDb().transaction(async (transaction) => {
    if (options.bootstrap === true) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INSTANCE_BOOTSTRAP_LOCK_KEY}, 0))`);
      const [authority] = await transaction
        .select({ seats: sql<number>`count(*)::int` })
        .from(instanceAuthority);
      if ((authority?.seats ?? 0) > 0) {
        throw new AuthError("bootstrap_claimed", "This Orbit instance has already been claimed", 409);
      }
    }

    /* Checked rather than left to the case-insensitive unique index, so the
       answer is Orbit's own bounded refusal instead of a driver error. The
       wording is ADR-0023 §3's collision refusal: an address belongs to one
       account, and the way to add a second sign-in method is to link it. */
    const [taken] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
    if (taken) {
      throw new AuthError(
        "link_required",
        "An Orbit account already uses this email address. Sign in to it and link this provider from settings.",
        403,
      );
    }

    const [created] = await transaction
      .insert(users)
      .values({
        email,
        /* Nothing has verified this address: no provider asserted it and Orbit
           sends no confirmation mail (ADR-0023 rejects email-based flows). */
        emailVerified: false,
        displayName,
        isInstanceAdmin: options.bootstrap === true,
      })
      .returning({ id: users.id, email: users.email, displayName: users.displayName });

    await transaction.insert(userPreferences).values({ userId: created.id }).onConflictDoNothing();
    if (draft.passwordHash) {
      await transaction.insert(localCredentials).values({
        userId: created.id,
        passwordHash: draft.passwordHash,
      });
    }

    if (options.bootstrap === true) {
      await transaction.insert(instanceAuthority).values({ primaryUserId: created.id });
      await transaction.insert(auditLog).values({
        householdId: null,
        actorUserId: created.id,
        entityType: "user",
        entityId: created.id,
        action: "instance_claimed",
        changes: { method: "local" },
      });
    }

    return created;
  });
}

/**
 * What a sign-in attempt was worth. `rejected` is deliberately one word for
 * four different situations; `throttled` covers both the persisted lock and a
 * verification gate that is already saturated (ADR-0021 §4), because a caller
 * is owed the same answer either way.
 */
export type CredentialVerdict =
  | { outcome: "verified"; userId: string }
  | { outcome: "rejected" }
  | { outcome: "throttled" };

/**
 * Verifies an email and password against `local_credentials` (ADR-0023 §4).
 *
 * On success the failure counter is cleared in the same statement that records
 * the verification, and a hash made below the current policy is replaced with
 * one made at it (ADR-0021 §3) — so raising the policy upgrades people as they
 * sign in, with no migration.
 */
export async function verifyCredential(email: string, password: string): Promise<CredentialVerdict> {
  try {
    return await attemptVerification(email, password);
  } catch (error) {
    if (error instanceof VerificationGateRefusedError) {
      /* The gate refused before any derivation ran, so this costs an attacker
         a request and tells them nothing about the address they named. */
      log.warn({
        event: "auth.local",
        state: "degraded",
        reason: "attempts_exhausted",
        action: "retry",
        impact: "sign_in_blocked",
      });
      return { outcome: "throttled" };
    }
    throw error;
  }
}

async function attemptVerification(email: string, password: string): Promise<CredentialVerdict> {
  const db = getDb();
  const [account] = await db
    .select({
      userId: users.id,
      disabledAt: users.disabledAt,
      passwordHash: localCredentials.passwordHash,
      lockedUntil: localCredentials.lockedUntil,
    })
    .from(users)
    .leftJoin(localCredentials, eq(localCredentials.userId, users.id))
    .where(sql`lower(${users.email}) = lower(${email.trim()})`)
    .limit(1);

  /* No such address, a disabled account, or an account that has no password
     yet: all three spend the decoy derivation and answer identically, so the
     three are indistinguishable from a wrong password by body, status or
     clock (ADR-0021 §5). */
  if (!account || account.disabledAt || !account.passwordHash) {
    await verifyAgainstDecoy(password);
    rejected();
    return { outcome: "rejected" };
  }

  const now = new Date();
  if (account.lockedUntil && account.lockedUntil > now) {
    return { outcome: "throttled" };
  }

  const { verified, needsRehash } = await verifyPassword(account.passwordHash, password);
  if (!verified) {
    await recordFailure(account.userId);
    rejected();
    return { outcome: "rejected" };
  }

  /* Re-hashed before the write so the upgraded string lands in the same
     statement that clears the counter, and outside the transaction so a 64 MiB
     derivation never holds a row lock. A gate refusal here is not the user's
     problem: the password was right, so the sign-in proceeds on the old hash
     and the next one tries again. */
  let upgradedHash: string | undefined;
  if (needsRehash) {
    try {
      upgradedHash = await hashPassword(password);
    } catch {
      upgradedHash = undefined;
    }
  }

  await db
    .update(localCredentials)
    .set({
      failedAttemptCount: 0,
      lockedUntil: null,
      lastVerifiedAt: new Date(),
      updatedAt: new Date(),
      ...(upgradedHash ? { passwordHash: upgradedHash } : {}),
    })
    .where(eq(localCredentials.userId, account.userId));

  return { outcome: "verified", userId: account.userId };
}

/**
 * Counts one failure and applies the schedule. Read and write happen inside
 * one transaction with the row locked, so two simultaneous wrong guesses count
 * as two rather than racing to write the same number twice.
 */
async function recordFailure(userId: string): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const [current] = await transaction
      .select({ failedAttemptCount: localCredentials.failedAttemptCount })
      .from(localCredentials)
      .where(eq(localCredentials.userId, userId))
      .for("update")
      .limit(1);
    if (!current) return;

    const failures = current.failedAttemptCount + 1;
    const penaltyMs = lockoutMs(failures);
    await transaction
      .update(localCredentials)
      .set({
        failedAttemptCount: failures,
        lockedUntil: penaltyMs > 0 ? new Date(Date.now() + penaltyMs) : null,
        updatedAt: new Date(),
      })
      .where(eq(localCredentials.userId, userId));
  });
}

/**
 * One bounded record per rejection. It names no address and no count: the
 * operator needs to know that sign-ins are being refused, and the logger's own
 * deduplication keeps a guessing run from filling the log.
 */
function rejected(): void {
  log.warn({
    event: "auth.local",
    state: "invalid",
    reason: "credentials_rejected",
    action: "none",
    impact: "sign_in_blocked",
  });
}

/* ===========================================================================
 * Sign-in methods (slice 10)
 *
 * What a reader can see and change about how they sign in (ADR-0023 §6): the
 * list, the link, and the two removals. Three rules hold this together, and
 * each of them is a way somebody could otherwise be locked out or let in:
 *
 *  - **A link binds to the session's user, never to a request parameter.**
 *    `linkIdentity` is called by the callback with the user id that was sealed
 *    into the transaction by the route that checked the session and
 *    re-challenged the person. Nothing a browser writes reaches it.
 *  - **A provider account belongs to one Orbit account.** The unique index on
 *    `(issuer, subject)` is the authority; `link_exists` is that index
 *    speaking, and an identity is never moved from one user to another.
 *  - **One usable method always survives.** A credential is usable. An
 *    identity is usable only while `ORBIT_AUTH_OIDC` is true — turning the
 *    provider off does not lock its users out of the instance, but it does
 *    stop them removing the password that is now their only way in. Both
 *    removals count what would remain, under the account-lifecycle lock, in
 *    the same transaction that removes it.
 * ========================================================================= */

/** One linked provider account, as its owner sees it. Never another user's. */
export interface LinkedIdentity {
  id: string;
  issuer: string;
  linkedAt: Date;
  lastLoginAt: Date;
}

/** The caller's own sign-in methods (ADR-0023 §6). */
export interface SignInMethods {
  local: { set: boolean; changedAt: Date | null };
  oidc: LinkedIdentity[];
}

const uuidSchema = z.uuid();

/**
 * True when the instance would accept a provider identity as a way in
 * (ADR-0023 §1, §3). Read at the moment of the decision rather than cached:
 * an operator who has just turned the provider off has changed what "usable"
 * means for the next request.
 */
function identitiesAreUsable(): boolean {
  return getAuthConfig().oidc !== null;
}

/**
 * The receipt check every removal makes for itself (ADR-0023 §5). The route
 * has already called `requireRecentAuthentication`; this refuses a receipt
 * earned by somebody else or for a different action, so the repository cannot
 * be reached with the wrong challenge.
 */
function assertUnlinkChallenge(recentAuthentication: RecentAuthentication, userId: string): void {
  if (recentAuthentication.userId !== userId || recentAuthentication.intent !== "unlink_method") {
    throw new AuthError(
      "recent_authentication_required",
      "Confirm it is you before removing a sign-in method",
      403,
    );
  }
}

/** The one refusal that keeps a reader from removing their way back in. */
function lastMethod(): AuthError {
  return new AuthError(
    "link_last_method",
    "Keep at least one way to sign in: add another method before removing this one",
    409,
  );
}

/** Lists the caller's own methods. Takes a user id, so it can never list another's. */
export async function listMethods(userId: string): Promise<SignInMethods> {
  const db = getDb();
  const [credential] = await db
    .select({ changedAt: localCredentials.passwordChangedAt })
    .from(localCredentials)
    .where(eq(localCredentials.userId, userId))
    .limit(1);
  const identities = await db
    .select({
      id: externalIdentities.id,
      issuer: externalIdentities.issuer,
      linkedAt: externalIdentities.createdAt,
      lastLoginAt: externalIdentities.lastLoginAt,
    })
    .from(externalIdentities)
    .where(eq(externalIdentities.userId, userId))
    .orderBy(asc(externalIdentities.createdAt));

  /* The subject is deliberately absent: it is the provider's opaque
     identifier for the person, it is of no use on the screen, and the issuer
     plus the dates are what a reader needs to recognise the account. */
  return {
    local: { set: Boolean(credential), changedAt: credential?.changedAt ?? null },
    oidc: identities,
  };
}

/**
 * Links a verified provider identity to a user (ADR-0023 §6).
 *
 * Called only by the callback's `link` branch, with the user id it opened out
 * of the sealed transaction. There is no recent-authentication receipt here
 * because the challenge happened before the browser left for the provider:
 * the sealed transaction IS the carried authorisation, and it is the only
 * thing that says which account the returning identity belongs to.
 *
 * An identity that already has a row is refused rather than moved or
 * duplicated — including one already on this same account, where the link
 * being asked for simply already exists.
 */
export async function linkIdentity(userId: string, identity: VerifiedIdentity): Promise<{ identityId: string }> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);

    const [existing] = await transaction
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(and(
        eq(externalIdentities.issuer, identity.issuer),
        eq(externalIdentities.subject, identity.subject),
      ))
      .limit(1);
    if (existing) {
      throw new AuthError(
        "link_exists",
        "That provider account is already linked to an Orbit account",
        409,
      );
    }

    const [owner] = await transaction
      .select({ id: users.id, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!owner) throw new AppError("user_not_found", "That account is not available", 404);
    if (owner.disabledAt) throw new AuthError("account_disabled", "This Orbit account is disabled", 403);

    const [linked] = await transaction
      .insert(externalIdentities)
      .values({ userId, issuer: identity.issuer, subject: identity.subject })
      .returning({ id: externalIdentities.id });

    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: userId,
      entityType: "user",
      entityId: userId,
      action: "identity_linked",
      changes: { identityId: linked.id },
    });

    /* Linking revokes nothing (ADR-0023 §7): the person has gained a way in,
       not changed the secret behind an existing one. */
    return { identityId: linked.id };
  });
}

/**
 * Removes the caller's password (ADR-0023 §6), leaving the account signed in
 * by its provider identity alone — which is only allowed while the provider
 * is switched on.
 */
export async function unlinkLocal(
  userId: string,
  recentAuthentication: RecentAuthentication,
): Promise<{ removed: boolean }> {
  assertUnlinkChallenge(recentAuthentication, userId);
  const identitiesUsable = identitiesAreUsable();

  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);

    const [credential] = await transaction
      .select({ userId: localCredentials.userId })
      .from(localCredentials)
      .where(eq(localCredentials.userId, userId))
      .limit(1);
    if (!credential) throw new AppError("credential_not_found", "That sign-in method is not available", 404);

    const identities = await transaction
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, userId));
    if (!identitiesUsable || identities.length === 0) throw lastMethod();

    await transaction.delete(localCredentials).where(eq(localCredentials.userId, userId));
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: userId,
      entityType: "user",
      entityId: userId,
      action: "password_removed",
      changes: {},
    });
    return { removed: true };
  });
}

/**
 * Removes one linked provider identity (ADR-0023 §6). Scoped to the caller's
 * own rows, so an identity id belonging to somebody else is simply not found
 * — the answer must not distinguish "not yours" from "does not exist".
 */
export async function unlinkIdentity(
  userId: string,
  identityId: string,
  recentAuthentication: RecentAuthentication,
): Promise<{ removed: boolean }> {
  assertUnlinkChallenge(recentAuthentication, userId);
  if (!uuidSchema.safeParse(identityId).success) {
    throw new AppError("identity_not_found", "That sign-in method is not available", 404);
  }
  const identitiesUsable = identitiesAreUsable();

  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);

    const [identity] = await transaction
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(and(eq(externalIdentities.id, identityId), eq(externalIdentities.userId, userId)))
      .limit(1);
    if (!identity) throw new AppError("identity_not_found", "That sign-in method is not available", 404);

    const [credential] = await transaction
      .select({ userId: localCredentials.userId })
      .from(localCredentials)
      .where(eq(localCredentials.userId, userId))
      .limit(1);
    const remaining = await transaction
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(and(eq(externalIdentities.userId, userId), ne(externalIdentities.id, identityId)));
    /* A password always counts. Another identity counts only while the
       provider is switched on, so unlinking down to nothing but identities on
       a local-only instance is refused rather than silently locking the
       account. */
    if (!credential && !(identitiesUsable && remaining.length > 0)) throw lastMethod();

    await transaction.delete(externalIdentities).where(eq(externalIdentities.id, identityId));
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: userId,
      entityType: "user",
      entityId: userId,
      action: "identity_unlinked",
      changes: { identityId },
    });
    return { removed: true };
  });
}
