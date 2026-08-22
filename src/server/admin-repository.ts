import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, externalIdentities, instanceAuthority, memberships, sessions, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { ACCOUNT_LIFECYCLE_LOCK_KEY, ADMINISTRATOR_LOCK_KEY } from "@/lib/auth/authority-locks";
import { requireInstanceAdministrator } from "@/server/authorization";

const uuidSchema = z.uuid();

/**
 * How long a session may be old and still count as fresh proof for a
 * primary-authority transfer (#263). There is no in-session re-auth flow yet
 * (that arrives with #259's local accounts), so "recently signed in" is the
 * available equivalent: past the window the transfer asks for a fresh sign-in.
 */
const TRANSFER_FRESH_SESSION_SECONDS = 15 * 60;

export interface InstanceUser {
  id: string;
  displayName: string;
  email: string;
  isInstanceAdmin: boolean;
  isPrimaryAdministrator: boolean;
  disabledAt: Date | null;
}

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** The current primary administrator, or null before the first bootstrap. */
async function primaryAdministratorId(transaction: Transaction): Promise<string | null> {
  const [row] = await transaction
    .select({ primaryUserId: instanceAuthority.primaryUserId })
    .from(instanceAuthority)
    .limit(1);
  return row?.primaryUserId ?? null;
}

export async function listInstanceUsers(actorUserId: string): Promise<InstanceUser[]> {
  await requireInstanceAdministrator(actorUserId);
  const [authority] = await getDb()
    .select({ primaryUserId: instanceAuthority.primaryUserId })
    .from(instanceAuthority)
    .limit(1);
  const rows = await getDb()
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      isInstanceAdmin: users.isInstanceAdmin,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .orderBy(asc(users.displayName), asc(users.email))
    .limit(1_000);
  return rows.map((row) => ({
    ...row,
    isPrimaryAdministrator: row.id === (authority?.primaryUserId ?? null),
  }));
}

/** Updates administrator rights while ensuring the instance always retains one administrator. */
export async function setInstanceAdministrator(
  actorUserId: string,
  targetUserId: string,
  administrator: boolean,
): Promise<InstanceUser[]> {
  if (!uuidSchema.safeParse(targetUserId).success) {
    throw new AppError("invalid_identifier", "User is not a valid identifier", 422);
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ADMINISTRATOR_LOCK_KEY}, 0))`);
    const [actor] = await transaction.select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, actorUserId)).limit(1);
    if (!actor?.administrator || actor.disabledAt) {
      throw new AppError("administrator_required", "Orbit administrator access is required", 403);
    }

    const [target] = await transaction.select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, targetUserId)).limit(1);
    if (!target) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);
    if (target.disabledAt) {
      throw new AppError("account_disabled", "Enable this Orbit account before granting administrator access", 409);
    }
    if (target.administrator === administrator) return;

    if (!administrator && targetUserId === actorUserId) {
      throw new AppError(
        "self_demotion_not_allowed",
        "Ask another administrator to remove your administrator access",
        409,
      );
    }

    /* The primary administrator cannot be demoted by anyone — authority moves
       first, by explicit transfer (#263). */
    if (!administrator && targetUserId === await primaryAdministratorId(transaction)) {
      throw new AppError(
        "primary_administrator_protected",
        "Transfer primary administrator authority before changing this account",
        409,
      );
    }

    if (!administrator && target.administrator) {
      const [state] = await transaction
        .select({ administrators: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.isInstanceAdmin, true), isNull(users.disabledAt)));
      if (state.administrators <= 1) {
        throw new AppError("last_administrator", "Orbit must retain at least one administrator", 409);
      }
    }

    await transaction.update(users)
      .set({ isInstanceAdmin: administrator, updatedAt: new Date() })
      .where(eq(users.id, targetUserId));
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "user",
      entityId: targetUserId,
      action: administrator ? "administrator_granted" : "administrator_revoked",
      changes: { administrator },
    });
  });

  return listInstanceUsers(actorUserId);
}

/**
 * Disables an account without deleting its household records or audit history.
 * Existing sessions are deleted inside the same transaction so access ends
 * immediately after the administrator action succeeds.
 */
export async function setInstanceUserDisabled(
  actorUserId: string,
  targetUserId: string,
  disabled: boolean,
): Promise<InstanceUser[]> {
  if (!uuidSchema.safeParse(targetUserId).success) {
    throw new AppError("invalid_identifier", "User is not a valid identifier", 422);
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ADMINISTRATOR_LOCK_KEY}, 0))`);
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ACCOUNT_LIFECYCLE_LOCK_KEY}, 0))`);
    const [actor] = await transaction.select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, actorUserId)).limit(1);
    if (!actor?.administrator || actor.disabledAt) {
      throw new AppError("administrator_required", "Orbit administrator access is required", 403);
    }

    const [target] = await transaction.select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, targetUserId)).limit(1);
    if (!target) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);
    if (targetUserId === actorUserId && disabled) {
      throw new AppError("self_disable_not_allowed", "Ask another administrator to disable your account", 409);
    }
    /* The primary administrator cannot be disabled by anyone — authority moves
       first, by explicit transfer (#263). */
    if (disabled && targetUserId === await primaryAdministratorId(transaction)) {
      throw new AppError(
        "primary_administrator_protected",
        "Transfer primary administrator authority before changing this account",
        409,
      );
    }
    const alreadyDisabled = target.disabledAt !== null;
    if (alreadyDisabled === disabled) return;

    if (disabled && target.administrator) {
      const [state] = await transaction
        .select({ administrators: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.isInstanceAdmin, true), isNull(users.disabledAt)));
      if (state.administrators <= 1) {
        throw new AppError("last_administrator", "Orbit must retain at least one active administrator", 409);
      }
    }

    if (disabled) {
      const ownedHouseholds = await transaction.select({ householdId: memberships.householdId })
        .from(memberships)
        .where(and(eq(memberships.userId, targetUserId), eq(memberships.role, "owner")));
      for (const ownedHousehold of ownedHouseholds) {
        const [state] = await transaction.select({ owners: sql<number>`count(*)::int` })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(
            eq(memberships.householdId, ownedHousehold.householdId),
            eq(memberships.role, "owner"),
            isNull(users.disabledAt),
            sql`${memberships.userId} <> ${targetUserId}`,
          ));
        if ((state?.owners ?? 0) <= 0) {
          throw new AppError(
            "owner_protected",
            "Transfer ownership before disabling this account",
            409,
          );
        }
      }
    }

    await transaction.update(users)
      .set({ disabledAt: disabled ? new Date() : null, updatedAt: new Date() })
      .where(eq(users.id, targetUserId));
    if (disabled) await transaction.delete(sessions).where(eq(sessions.userId, targetUserId));
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "user",
      entityId: targetUserId,
      action: disabled ? "account_disabled" : "account_enabled",
      changes: { disabled },
    });
  });

  return listInstanceUsers(actorUserId);
}

/**
 * Moves primary administrator authority to another active administrator
 * (#263). One atomic transaction under the administrator lock, so a
 * concurrent disable, demotion or second transfer serializes behind it and
 * re-reads the authority row it may have moved. Only the current primary may
 * transfer; the target must be a different, active administrator with a
 * usable sign-in method. The former primary remains an ordinary active
 * administrator.
 *
 * Administrator and primary status are read from the database on every
 * mutation rather than cached in sessions, so existing sessions see the new
 * authority immediately; nothing needs revoking.
 */
export async function transferPrimaryAdministrator(
  actorUserId: string,
  actorSessionId: string,
  targetUserId: string,
): Promise<InstanceUser[]> {
  if (!uuidSchema.safeParse(targetUserId).success) {
    throw new AppError("invalid_identifier", "User is not a valid identifier", 422);
  }

  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ADMINISTRATOR_LOCK_KEY}, 0))`);

    const [actor] = await transaction
      .select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt })
      .from(users).where(eq(users.id, actorUserId)).limit(1);
    if (!actor?.administrator || actor.disabledAt) {
      throw new AppError("administrator_required", "Orbit administrator access is required", 403);
    }

    const primary = await primaryAdministratorId(transaction);
    if (primary !== actorUserId) {
      throw new AppError(
        "primary_administrator_required",
        "Only the primary administrator can transfer this authority",
        403,
      );
    }

    /* Fresh proof: the session performing the transfer must be recent. A
       stale request from an old session asks for a fresh sign-in instead
       (#263); in-session re-authentication arrives with #259. */
    const [actorSession] = await transaction
      .select({ createdAt: sessions.createdAt })
      .from(sessions)
      .where(and(eq(sessions.id, actorSessionId), eq(sessions.userId, actorUserId)))
      .limit(1);
    const freshestAcceptable = Date.now() - TRANSFER_FRESH_SESSION_SECONDS * 1000;
    if (!actorSession || actorSession.createdAt.getTime() < freshestAcceptable) {
      throw new AppError(
        "recent_authentication_required",
        "Sign in again to transfer primary administrator authority",
        403,
      );
    }

    if (targetUserId === actorUserId) {
      throw new AppError(
        "transfer_target_ineligible",
        "Choose a different active administrator to receive primary authority",
        409,
      );
    }
    const [target] = await transaction
      .select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt })
      .from(users).where(eq(users.id, targetUserId)).limit(1);
    if (!target || !target.administrator || target.disabledAt) {
      throw new AppError(
        "transfer_target_ineligible",
        "Choose a different active administrator to receive primary authority",
        409,
      );
    }
    const [identity] = await transaction
      .select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, targetUserId))
      .limit(1);
    if (!identity) {
      throw new AppError(
        "transfer_target_ineligible",
        "Choose a different active administrator to receive primary authority",
        409,
      );
    }

    await transaction.update(instanceAuthority)
      .set({ primaryUserId: targetUserId, updatedAt: new Date() });
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "user",
      entityId: targetUserId,
      action: "primary_administrator_transferred",
      changes: { from: actorUserId, to: targetUserId },
    });
  });

  return listInstanceUsers(actorUserId);
}
