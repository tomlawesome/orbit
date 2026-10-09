import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { AppError } from "@/lib/app-error";

type Database = ReturnType<typeof getDb>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Whether this user is an administrator who may act right now: an
 * instance-wide administrator whose account is not disabled. The one
 * administrator predicate (#1334); pass a transaction to read inside it.
 *
 * A disabled account has no sessions, so this is never what stops a disabled
 * administrator today. It is here so that every administrator gate gives the
 * strictest answer, and the next change cannot pick a looser one.
 */
export async function isInstanceAdministrator(userId: string, executor: Database | DatabaseTransaction = getDb()): Promise<boolean> {
  const [user] = await executor
    .select({ isInstanceAdmin: users.isInstanceAdmin, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(user?.isInstanceAdmin) && !user?.disabledAt;
}

/**
 * Refuses anyone who is not an active administrator with 403
 * `administrator_required`. Pass the transaction when the check has to hold
 * for the rest of it (the caller already holds its locks).
 */
export async function requireActiveAdministrator(userId: string, executor: Database | DatabaseTransaction = getDb()): Promise<void> {
  if (!await isInstanceAdministrator(userId, executor)) {
    throw new AppError("administrator_required", "Orbit administrator access is required", 403);
  }
}

export async function requireInstanceAdministrator(userId: string): Promise<void> {
  await requireActiveAdministrator(userId);
}
