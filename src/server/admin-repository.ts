import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { requireInstanceAdministrator } from "@/server/authorization";

const uuidSchema = z.uuid();

export interface InstanceUser {
  id: string;
  displayName: string;
  email: string;
  isInstanceAdmin: boolean;
}

export async function listInstanceUsers(actorUserId: string): Promise<InstanceUser[]> {
  await requireInstanceAdministrator(actorUserId);
  return getDb()
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      isInstanceAdmin: users.isInstanceAdmin,
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
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('orbit:administrators', 0))`);
    const [actor] = await transaction.select({ administrator: users.isInstanceAdmin }).from(users)
      .where(eq(users.id, actorUserId)).limit(1);
    if (!actor?.administrator) {
      throw new AppError("administrator_required", "Orbit administrator access is required", 403);
    }

    const [target] = await transaction.select({ administrator: users.isInstanceAdmin }).from(users)
      .where(eq(users.id, targetUserId)).limit(1);
    if (!target) throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);

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
        .where(eq(users.isInstanceAdmin, true));
      if (state.administrators <= 1) {
        throw new AppError("last_administrator", "Orbit must retain at least one administrator", 409);
      }
    }

    await transaction.update(users)
      .set({ isInstanceAdmin: administrator, updatedAt: new Date() })
      .where(eq(users.id, targetUserId));
  });

  return listInstanceUsers(actorUserId);
}
