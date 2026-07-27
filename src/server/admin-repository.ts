import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, memberships, sessions, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { ACCOUNT_LIFECYCLE_LOCK_KEY, ADMINISTRATOR_LOCK_KEY } from "@/lib/auth/authority-locks";
import { requireInstanceAdministrator } from "@/server/authorization";

const uuidSchema = z.uuid();

export interface InstanceUser {
  id: string;
  displayName: string;
  email: string;
  isInstanceAdmin: boolean;
  disabledAt: Date | null;
}

export async function listInstanceUsers(actorUserId: string): Promise<InstanceUser[]> {
  await requireInstanceAdministrator(actorUserId);
  return getDb()
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
